/**
 * Builds the blind review file.
 *
 * The point of this step is that the author does NOT know which side produced a
 * text. If they did, "the one with the skills" would win by default and the
 * measurement would be worthless. So:
 *
 *   - for each pair, the two texts are shuffled with a seeded PRNG,
 *   - each side gets a neutral label (A / B) that carries no signal,
 *   - the mapping is written to a separate ANSWER KEY file, not this one,
 *   - a simple grid asks for one score per dimension, 1 to 5.
 *
 * The seed is printed so the run is reproducible, but it is NOT put in the
 * review file: knowing it would be enough to reverse the mapping.
 *
 * Usage:
 *   npx tsx scripts/writing-bench/build-blind-file.ts <outdir> <pair.json...>
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadPairs, type Pair } from './metrics';

const DIMENSIONS = [
  ['voix', "L'auteur a-t-il une voix, ou la prose est-elle neutre ?"],
  ['concret', 'Les détails sont-ils sensoriels et précis, ou génériques ?'],
  ['rythme', 'Les longueurs de phrases varient-elles, ou est-ce une marche ?'],
  ['originalite', "Y a-t-il une image inattendue, ou une image de catalogue ?"],
  ['naturel', 'Lit-on cela sans avoir l’impression qu\'une IA l\'a écrit ?'],
] as const;

/** Mulberry32: small, deterministic, and seeded so a run can be reproduced. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const args = process.argv.slice(2);
const [outDir, ...files] = args;

if (!outDir || files.length === 0) {
  process.stderr.write('usage: build-blind-file.ts <outdir> <pair.json...>\n');
  process.exit(1);
}

const pairs: Pair[] = [];
for (const file of files) {
  const stat = fs.statSync(file);
  pairs.push(...(stat.isDirectory() ? loadPairs(file) : [JSON.parse(fs.readFileSync(file, 'utf-8')) as Pair]));
}

fs.mkdirSync(outDir, { recursive: true });

// Seed from the clock by default, or from an explicit argument for a rerun.
const seedArg = process.env.BENCH_SEED;
const seed = seedArg ? Number(seedArg) : Math.floor(Math.random() * 2 ** 31);
const rng = makeRng(seed);

const reviewParts: string[] = [];
const keyParts: string[] = [];

reviewParts.push('# Évaluation en aveugle');
reviewParts.push('');
reviewParts.push('**Ne cherchez pas** quelle version vient des skills. C\'est tout l\'intérêt.');
reviewParts.push('');
reviewParts.push('Pour chaque paire, lisez les deux versions et notez chacune de 1 à 5');
reviewParts.push('sur les cinq axes. Une seule note par axe et par version.');
reviewParts.push('');
reviewParts.push('Il n\'y a pas de bonne réponse : il n\'y a que votre lecture.');
reviewParts.push('');

for (const pair of shuffle(pairs, rng)) {
  const withSkillsFirst = rng() < 0.5;
  const a = withSkillsFirst ? pair.with : pair.without;
  const b = withSkillsFirst ? pair.without : pair.with;

  reviewParts.push(`## ${pair.id}`);
  reviewParts.push('');
  reviewParts.push(`**Consigne** : ${pair.prompt}`);
  reviewParts.push('');
  reviewParts.push('### Version A');
  reviewParts.push('');
  reviewParts.push(a.trim());
  reviewParts.push('');
  reviewParts.push('### Version B');
  reviewParts.push('');
  reviewParts.push(b.trim());
  reviewParts.push('');
  reviewParts.push('| axe | A | B |');
  reviewParts.push('|---|---|---|');
  for (const [key, hint] of DIMENSIONS) {
    reviewParts.push(`| ${key} — ${hint} | | |`);
  }
  reviewParts.push('');
  reviewParts.push('**Préférence** : A / B / indifférent');
  reviewParts.push('');
  reviewParts.push('---');
  reviewParts.push('');

  keyParts.push(`${pair.id}\tA=${withSkillsFirst ? 'avec skills' : 'sans skills'}\tB=${withSkillsFirst ? 'sans skills' : 'avec skills'}`);
}

const reviewPath = path.join(outDir, 'REVIEW.md');
const keyPath = path.join(outDir, 'ANSWER-KEY.tsv');

fs.writeFileSync(reviewPath, reviewParts.join('\n'), 'utf-8');
// One line per pair, id first, then the A/B mapping in the SAME tab-separated
// field. Splitting the line on the first tab and reading a second field would
// silently lose the B side.
fs.writeFileSync(keyPath, `id\tA=...\tB=...\n${keyParts.join('\n')}\n`, 'utf-8');

process.stdout.write(`Graine : ${seed}\n`);
process.stdout.write(`${pairs.length} paires mélangées.\n`);
process.stdout.write(`À noter : ${reviewPath}\n`);
process.stdout.write(`Clé : ${keyPath} — ne pas ouvrir avant d'avoir noté.\n`);
