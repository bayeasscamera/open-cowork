/**
 * CLI: score generated texts against the French writing benchmark.
 *
 * Reads pairs produced by the generation step and prints the mechanical
 * comparison. Deliberately refuses to print a verdict: these are counts, and
 * only the blind human rating can say whether a text got better.
 *
 * Usage:
 *   npx tsx scripts/writing-bench/measure.ts pairs/*.json
 *   npx tsx scripts/writing-bench/measure.ts --corpus      # just list prompts
 */

import fs from 'node:fs';
import path from 'node:path';

import { CORPUS, compare, loadPairs, measure, type Pair } from './metrics';

const args = process.argv.slice(2);

if (args.includes('--corpus')) {
  process.stdout.write(`Corpus : ${CORPUS.length} consignes\n\n`);
  for (const prompt of CORPUS) {
    process.stdout.write(`${prompt.id}  [${prompt.lang}/${prompt.category}]\n  ${prompt.prompt}\n\n`);
  }
  process.exit(0);
}

if (args.length === 0) {
  process.stderr.write('usage: measure.ts <pair.json...> | --corpus\n');
  process.exit(1);
}

const files = args.filter((a) => !a.startsWith('--'));
const pairs: Pair[] = [];
for (const file of files) {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) {
    pairs.push(...loadPairs(file));
  } else {
    pairs.push(JSON.parse(fs.readFileSync(path.resolve(file), 'utf-8')) as Pair);
  }
}

if (pairs.length === 0) {
  process.stderr.write('no pairs found\n');
  process.exit(1);
}

process.stdout.write(`Paires mesurées : ${pairs.length}\n`);
process.stdout.write(`Modèle : ${pairs[0].provider} / ${pairs[0].model}\n\n`);

process.stdout.write(
  'id'.padEnd(9) +
    'lang'.padEnd(6) +
    'mots'.padStart(7) +
    'tics/1k sans'.padStart(14) +
    'avec'.padStart(9) +
    'var. sans'.padStart(11) +
    'avec'.padStart(9) +
    'debuts sans'.padStart(13) +
    'avec'.padStart(9) +
    'typo sans'.padStart(11) +
    'avec'.padStart(9) +
    '\n',
);
process.stdout.write('-'.repeat(107) + '\n');

for (const pair of pairs) {
  const a = measure(pair.without, pair.lang);
  const b = measure(pair.with, pair.lang);
  const typoErrors = (m: ReturnType<typeof measure>): number =>
    m.typography.nbspBeforeDoublePunctuation +
    m.typography.straightApostrophes +
    m.typography.nbspAfterOpeningQuote +
    m.typography.nbspBeforeClosingQuote +
    (m.typography.dialogueDashOk ? 0 : 1);

  process.stdout.write(
    pair.id.padEnd(9) +
      pair.lang.padEnd(6) +
      String(b.words).padStart(7) +
      String(a.ticsPer1k).padStart(14) +
      String(b.ticsPer1k).padStart(9) +
      String(a.sentenceLengthStdDev).padStart(11) +
      String(b.sentenceLengthStdDev).padStart(9) +
      String(a.repeatedOpeners).padStart(13) +
      String(b.repeatedOpeners).padStart(9) +
      String(typoErrors(a)).padStart(11) +
      String(typoErrors(b)).padStart(9) +
      '\n',
  );
}

function punch(m: ReturnType<typeof measure>): string {
  return String(m.punchlineEndings);
}

process.stdout.write('\n');
const totals = compare(pairs);
process.stdout.write('Totaux (moyennes ou sommes)\n');
process.stdout.write(`  tics/1000 mots   sans ${totals.ticsWithout}  avec ${totals.ticsWith}  écart ${totals.ticDelta > 0 ? '+' : ''}${totals.ticDelta}\n`);
process.stdout.write(`  variance phrases sans ${totals.varianceWithout}  avec ${totals.varianceWith}\n`);
process.stdout.write(`  débuts répétés   sans ${totals.openersWithout}  avec ${totals.openersWith}\n`);
process.stdout.write(`  fins « punchline » sans ${totals.punchlinesWithout}  avec ${totals.punchlinesWith}\n`);
process.stdout.write(`  erreurs typo     sans ${totals.typographyErrorsWithout}  avec ${totals.typographyErrorsWith}\n`);
process.stdout.write('\nCes chiffres sont des comptes, pas un verdict. Le seul juge est le fichier en aveugle.\n');
