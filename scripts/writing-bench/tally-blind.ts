/**
 * Tallies the blind review and reveals which side won.
 *
 * Run this only AFTER the ratings are in. It reads the filled REVIEW.md tables
 * and the separate answer key, then reports the result per dimension and per
 * pair. It deliberately does not smooth anything: if a dimension went the wrong
 * way, that is the finding, and hiding it would make the whole exercise
 * pointless.
 *
 * Usage:
 *   npx tsx scripts/writing-bench/tally-blind.ts <blind-dir>
 */

import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2];
if (!DIR) {
  process.stderr.write('usage: tally-blind.ts <blind-dir>\n');
  process.exit(1);
}

const reviewPath = path.join(DIR, 'REVIEW.md');
const keyPath = path.join(DIR, 'ANSWER-KEY.tsv');

if (!fs.existsSync(reviewPath) || !fs.existsSync(keyPath)) {
  process.stderr.write('REVIEW.md ou ANSWER-KEY.tsv introuvable\n');
  process.exit(1);
}

const review = fs.readFileSync(reviewPath, 'utf-8');
const key = new Map<string, string>();
for (const line of fs.readFileSync(keyPath, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  const [id, rest] = line.split('\t');
  if (!id || id === 'id' || !rest) continue;
  // Both sides live in the SAME tab-separated field ("A=...\tB=..."), so the
  // line must be matched whole rather than split on the first tab.
  const a = /A=([^\t]+)/.exec(line)?.[1]?.trim();
  const b = /B=([^\t]+)/.exec(line)?.[1]?.trim();
  if (a && b) key.set(id.trim(), `${a}|${b}`);
}

interface Block {
  id: string;
  scores: Record<string, { A: number | null; B: number | null }>;
  preference: string | null;
}

const blocks: Block[] = [];
let current: Block | null = null;

for (const line of review.split('\n')) {
  const header = /^##\s+(\S+)\s*$/.exec(line);
  if (header) {
    if (current) blocks.push(current);
    current = { id: header[1], scores: {}, preference: null };
    continue;
  }
  if (!current) continue;

  // | axis — hint | A | B |
  const row = /^\|\s*([a-z]+)\s+[—-].*?\|\s*([0-9]*)\s*\|\s*([0-9]*)\s*\|\s*$/.exec(line);
  if (row) {
    const [, axis, a, b] = row;
    current.scores[axis] = {
      A: a === '' ? null : Number(a),
      B: b === '' ? null : Number(b),
    };
    continue;
  }
  const pref = /^\*\*(?:Préférence|Preference)\*\*\s*:\s*(.+)$/.exec(line);
  if (pref) current.preference = pref[1].trim();
}
if (current) blocks.push(current);

if (blocks.length === 0) {
  process.stderr.write('aucune paire trouvée dans REVIEW.md\n');
  process.exit(1);
}

const UNFILLED = blocks.filter((b) =>
  Object.values(b.scores).some((s) => s.A === null || s.B === null),
);

process.stdout.write(`Paires : ${blocks.length}\n`);
process.stdout.write(`Complétées : ${blocks.length - UNFILLED.length}\n`);
if (UNFILLED.length > 0) {
  process.stdout.write(`Restées vides : ${UNFILLED.map((b) => b.id).join(', ')}\n\n`);
}

const dimensions = new Set<string>();
for (const b of blocks) for (const axis of Object.keys(b.scores)) dimensions.add(axis);

process.stdout.write('\nMoyennes par axe (1 à 5)\n');
process.stdout.write('  axe'.padEnd(14) + 'avec skills'.padStart(13) + 'sans skills'.padStart(13) + '  écart\n');
process.stdout.write('-'.repeat(52) + '\n');

interface Row { axis: string; withAvg: number; withoutAvg: number; n: number }
const rows: Row[] = [];

for (const axis of [...dimensions].sort()) {
  let withSum = 0;
  let withoutSum = 0;
  let n = 0;
  for (const block of blocks) {
    const score = block.scores[axis];
    const mapping = key.get(block.id);
    if (!score || score.A === null || score.B === null || !mapping) continue;
    const [aSide, bSide] = mapping.split('|');
    const aIsWith = aSide === 'avec skills';
    const withScore = aIsWith ? score.A : score.B;
    const withoutScore = aIsWith ? score.B : score.A;
    if (withScore === null || withoutScore === null) continue;
    withSum += withScore;
    withoutSum += withoutScore;
    n += 1;
  }
  if (n === 0) continue;
  const withAvg = withSum / n;
  const withoutAvg = withoutSum / n;
  rows.push({ axis, withAvg, withoutAvg, n });
  const delta = withAvg - withoutAvg;
  process.stdout.write(
    `  ${axis.padEnd(12)}${withAvg.toFixed(2).padStart(13)}${withoutAvg.toFixed(2).padStart(13)}` +
      `  ${delta > 0 ? '+' : ''}${delta.toFixed(2)}\n`,
  );
}

if (rows.length > 0) {
  const withMean = rows.reduce((a, r) => a + r.withAvg, 0) / rows.length;
  const withoutMean = rows.reduce((a, r) => a + r.withoutAvg, 0) / rows.length;
  const delta = withMean - withoutMean;
  process.stdout.write('-'.repeat(52) + '\n');
  process.stdout.write(
    `  ${'GLOBAL'.padEnd(12)}${withMean.toFixed(2).padStart(13)}${withoutMean.toFixed(2).padStart(13)}` +
      `  ${delta > 0 ? '+' : ''}${delta.toFixed(2)}\n`,
  );
  process.stdout.write('\n');
  if (Math.abs(delta) < 0.15) {
    process.stdout.write('Verdict : différence négligeable sur cet échantillon.\n');
  } else if (delta > 0) {
    process.stdout.write('Verdict : les skills sont mieux notés sur cet échantillon.\n');
  } else {
    process.stdout.write('Verdict : les skills sont notés INFÉRIEURS. À examiner avant toute conclusion.\n');
  }
}

process.stdout.write('\nPréférences déclarées\n');
for (const block of blocks) {
  const mapping = key.get(block.id);
  process.stdout.write(`  ${block.id}: ${block.preference ?? '(non renseignée)'}${mapping ? `  [A=${mapping.split('|')[0]}]` : ''}\n`);
}

process.stdout.write('\nRappel : un petit échantillon ne prouve pas une tendance.\n');
