/**
 * Writing-skills benchmark: corpus, automatic metrics, and the blind-review file.
 *
 * The premise of this harness is that "these skills improve prose" is a claim
 * that needs evidence, not a plausible story. So the harness does three things
 * and refuses the fourth:
 *
 *   1. holds a corpus of prompts (French and English),
 *   2. scores a text mechanically on the dimensions the skills claim to move,
 *   3. builds a shuffled, anonymised file for blind human rating.
 *
 * It does NOT decide whether a text is good. Every metric here counts something
 * a machine can count; "does this sound alive" is the human's call, and the
 * blind file exists precisely so that call is not biased by knowing which side
 * produced the text.
 *
 * One deliberate exclusion: no metric here counts em dashes as a defect. In
 * French the dash is the dialogue dash. A harness that penalised it would
 * push the model away from correct French typography, which is the exact
 * regression the French layer exists to prevent.
 *
 * Usage:
 *   npx tsx scripts/writing-bench/measure.ts <file...>
 *   npx tsx scripts/writing-bench/build-blind-file.ts <outdir> <pair.json...>
 */

import fs from 'node:fs';
import path from 'node:path';

export interface BenchPrompt {
  id: string;
  lang: 'fr' | 'en';
  category: string;
  prompt: string;
}

/**
 * Twelve French prompts and four English ones, spanning the categories the
 * brief asks for: narrative, dialogue, place description, novel opening, flat
 * paragraph rewrite, interior monologue, action, letter, tale, constrained text.
 */
export const CORPUS: BenchPrompt[] = [
  { id: 'fr-01', lang: 'fr', category: 'nouvelle', prompt: 'Écris le premier paragraphe d\'une nouvelle. Une femme reçoit une lettre qui n\'a pas été envoyée.' },
  { id: 'fr-02', lang: 'fr', category: 'scene-dialogue', prompt: 'Écris une scène de dialogue entre une mère et son fils adulte qui ne se parlent plus depuis deux ans. Ils finissent par dire ce qu\'ils avaient à dire.' },
  { id: 'fr-03', lang: 'fr', category: 'description-lieu', prompt: 'Décris une cuisine abandonnée dans une maison dont les habitants sont partis sans rien prendre.' },
  { id: 'fr-04', lang: 'fr', category: 'ouverture-romant', prompt: 'Ouvre un roman policier : un village de montagne reçoit un courrier qui n\'aurait jamais dû arriver.' },
  { id: 'fr-05', lang: 'fr', category: 'reecriture-plate', prompt: 'Réécris ce paragraphe pour qu\'il soit plus vivant : "C\'était une journée très importante. Il marchait dans la ville qui était grande et animée. Il pensait à son avenir. Il se sentait seul."' },
  { id: 'fr-06', lang: 'fr', category: 'monologue-interieur', prompt: 'Écris le monologue intérieur d\'un homme qui vient d\'apprendre qu\'il ne sera pas père.' },
  { id: 'fr-07', lang: 'fr', category: 'scene-action', prompt: 'Écris une scène d\'action : un couloir, une porte, quelqu\'un derrière, et aucun autre moyen de sortir.' },
  { id: 'fr-08', lang: 'fr', category: 'lettre', prompt: 'Écris une lettre où quelqu\'un annonce à son employeur qu\'il démissionne, sans donner de raison.' },
  { id: 'fr-09', lang: 'fr', category: 'conte', prompt: 'Écris un conte moral court pour un enfant de huit ans, en trente lignes.' },
  { id: 'fr-10', lang: 'fr', category: 'texte-contraint', prompt: 'Écris dix lignes sans employer le verbe "être", ni les adverbes en -ment.' },
  { id: 'fr-11', lang: 'fr', category: 'scene-dialogue', prompt: 'Écris une scène de dialogue où deux personnages mensent chacun sur le même sujet, et où le lecteur comprend tout.' },
  { id: 'fr-12', lang: 'fr', category: 'description-lieu', prompt: 'Décris un marché de nuit dans une ville portuaire, en trois paragraphes.' },
  { id: 'en-01', lang: 'en', category: 'short-story', prompt: 'Write the opening paragraph of a short story. A man finds a key that does not fit any door in his house.' },
  { id: 'en-02', lang: 'en', category: 'scene-dialogue', prompt: 'Write a dialogue scene between two former friends who meet after ten years. Neither apologises.' },
  { id: 'en-03', lang: 'en', category: 'flat-rewrite', prompt: 'Rewrite this paragraph so it is more vivid: "It was a very important day. He walked down the big city street. He thought about his future. He felt alone."' },
  { id: 'en-04', lang: 'en', category: 'description-place', prompt: 'Describe an empty railway station at four in the morning.' },
];

export interface Metrics {
  words: number;
  /** Hollow AI tics per 1000 words. The headline number. */
  ticsPer1k: number;
  ticHits: Record<string, number>;
  /** Spread of sentence lengths; low variance reads as metronomic. */
  sentenceLengthStdDev: number;
  sentenceLengthMean: number;
  sentenceCount: number;
  /** How often a sentence opens the same way. */
  repeatedOpeners: number;
  openerDiversity: number;
  binaryContrasts: number;
  /** French typography compliance, only meaningful for French text. */
  typography: {
    dialogueDashOk: boolean;
    nbspBeforeDoublePunctuation: number;
    straightApostrophes: number;
    nbspAfterOpeningQuote: number;
    nbspBeforeClosingQuote: number;
  };
  /** Paragraph-final isolated one-liners: the "quotable" ending tic. */
  punchlineEndings: number;
}

export interface Pair {
  id: string;
  promptId: string;
  lang: 'fr' | 'en';
  prompt: string;
  without: string;
  with: string;
  model: string;
  provider: string;
}

/** Candidate tics. Provisional by construction: the list the author validates. */
const FR_TICS: Array<[string, RegExp]> = [
  ['il est important de noter que', /il est important de noter que/gi],
  ['il convient de souligner', /il convient de souligner/gi],
  ['il faut noter que', /il faut noter que/gi],
  ['force est de constater', /force est de constater/gi],
  ['dans un monde où', /dans un monde o[uù]/gi],
  ['au cœur de', /au c[œoe]ur de/gi],
  ['plongez dans', /plongez dans/gi],
  ['un véritable voyage', /un v[ée]ritable voyage/gi],
  ['une véritable symphonie', /une v[ée]ritable symphonie/gi],
  ['se tisse', /\bse tisse\b/gi],
  ['une danse de', /une danse de/gi],
  ['un témoignage de', /un t[ée]moignage de/gi],
  ['loin d être X c est Y', /loin d[êe]tre[^.]{0,60}c[êe]st/gi],
  ['en conclusion', /en conclusion/gi],
  ['dans l ensemble', /dans l'ensemble/gi],
  ['transition de plus', /\b(de plus|de surc[ôo]t)\b/gi],
  ['ce n est pas X c est Y', /ce n'est pas[^.]{0,60}c'est/gi],
  ['non pas X mais Y', /non pas[^.]{0,60}mais/gi],
  ['mosaïque', /mosa[îi]que/gi],
  ['kaléidoscope', /kal[ée]idoscope/gi],
  ['symphonie', /symphonie/gi],
  ['tapisserie ou tisse', /tapisserie|tisse/gi],
  ['réellement adverbe creux', /(v[ée]ritablement|profond[ée]ment|extr[êe]mement)/gi],
  ['il est possible de', /il est possible de/gi],
  ['il faut préciser que', /il faut pr[ée]ciser que/gi],
  ['n est pas sans', /n'est pas sans/gi],
];

function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}']+/gu);
  return matches ? matches.length : 0;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+(?=[«"'(\p{Lu}])/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function words(sentence: string): string[] {
  const matches = sentence.match(/[\p{L}\p{N}']+/gu);
  return matches ? matches.map((w) => w.toLowerCase()) : [];
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function measure(text: string, lang: 'fr' | 'en'): Metrics {
  const wordCount = countWords(text);

  const ticHits: Record<string, number> = {};
  let ticTotal = 0;
  if (lang === 'fr') {
    for (const [name, pattern] of FR_TICS) {
      const hits = text.match(pattern)?.length ?? 0;
      if (hits > 0) ticHits[name] = hits;
      ticTotal += hits;
    }
  }

  const sentences = splitSentences(text);
  const lengths = sentences.map((s) => words(s).length).filter((n) => n > 0);

  const openers = sentences
    .map((s) => words(s)[0] ?? '')
    .filter(Boolean);
  const openerCounts = new Map<string, number>();
  for (const opener of openers) {
    openerCounts.set(opener, (openerCounts.get(opener) ?? 0) + 1);
  }
  let repeatedOpeners = 0;
  for (const count of openerCounts.values()) {
    if (count > 2) repeatedOpeners += count - 2;
  }

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  let punchlineEndings = 0;
  for (const paragraph of paragraphs) {
    const lines = paragraph.trim().split('\n').filter((l) => l.trim());
    const last = lines[lines.length - 1]?.trim() ?? '';
    // An isolated short final line is the "quotable" ending pattern.
    if (lines.length > 1 && last && words(last).length > 0 && words(last).length <= 7) {
      punchlineEndings += 1;
    }
  }

  const doublePunctuation = /[!?;:](?!\u00A0)/gu;
  const nbspBeforeDoublePunctuation = (text.match(doublePunctuation) ?? []).length;
  const straightApostrophes = (text.match(/[a-zA-ZÀ-ÿ]'[a-zA-ZÀ-ÿ]/g) ?? []).length;
  const nbspAfterOpeningQuote = (text.match(/«(?![\u00A0 ])/g) ?? []).length;
  const nbspBeforeClosingQuote = (text.match(/(?<![\u00A0 ])»/g) ?? []).length;

  // A dialogue line is one whose content sits between the dialogue dashes.
  const dialogueDashOk = !/^[^—\n]*[—].*$/m.test('') && dialogueDashesBalanced(text);

  return {
    words: wordCount,
    ticsPer1k: wordCount > 0 ? Number(((ticTotal / wordCount) * 1000).toFixed(2)) : 0,
    ticHits,
    sentenceLengthStdDev: Number(stdDev(lengths).toFixed(2)),
    sentenceLengthMean: lengths.length
      ? Number((lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(2))
      : 0,
    sentenceCount: sentences.length,
    repeatedOpeners,
    openerDiversity: openerCounts.size,
    binaryContrasts: (ticHits['ce n est pas X c est Y'] ?? 0) + (ticHits['non pas X mais Y'] ?? 0),
    typography: {
      dialogueDashOk,
      nbspBeforeDoublePunctuation,
      straightApostrophes,
      nbspAfterOpeningQuote,
      nbspBeforeClosingQuote,
    },
    punchlineEndings,
  };
}

/**
 * Dialogue dashes must balance within each line that uses them. An unbalanced
 * dash is a real typography error, and this is the ONE place the em dash is
 * checked — never as a tic, only as correctness.
 */
function dialogueDashesBalanced(text: string): boolean {
  const dialogueLines = text
    .split('\n')
    .filter((line) => /^\s*—/.test(line.trim()));
  for (const line of dialogueLines) {
    const dashes = (line.match(/—/g) ?? []).length;
    // Odd count: an interruption was opened and never closed.
    if (dashes % 2 !== 0) return false;
  }
  return true;
}

export function loadPairs(dir: string): Pair[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Pair);
}

export function compare(pairs: Pair[]): {
  ticsWith: number;
  ticsWithout: number;
  ticDelta: number;
  varianceWith: number;
  varianceWithout: number;
  openersWith: number;
  openersWithout: number;
  typographyErrorsWith: number;
  typographyErrorsWithout: number;
  punchlinesWith: number;
  punchlinesWithout: number;
} {
  const score = (text: string, lang: 'fr' | 'en'): Metrics => measure(text, lang);
  let ticsWith = 0;
  let ticsWithout = 0;
  let varianceWith = 0;
  let varianceWithout = 0;
  let openersWith = 0;
  let openersWithout = 0;
  let typoWith = 0;
  let typoWithout = 0;
  let punchWith = 0;
  let punchWithout = 0;

  for (const pair of pairs) {
    const a = score(pair.without, pair.lang);
    const b = score(pair.with, pair.lang);
    ticsWithout += a.ticsPer1k;
    ticsWith += b.ticsPer1k;
    varianceWithout += a.sentenceLengthStdDev;
    varianceWith += b.sentenceLengthStdDev;
    openersWithout += a.repeatedOpeners;
    openersWith += b.repeatedOpeners;
    punchWithout += a.punchlineEndings;
    punchWith += b.punchlineEndings;
    // Lower is better for every typography counter.
    const errs = (m: Metrics): number =>
      m.typography.nbspBeforeDoublePunctuation +
      m.typography.straightApostrophes +
      m.typography.nbspAfterOpeningQuote +
      m.typography.nbspBeforeClosingQuote +
      (m.typography.dialogueDashOk ? 0 : 1);
    typoWithout += errs(a);
    typoWith += errs(b);
  }

  const n = pairs.length || 1;
  return {
    ticsWith: Number((ticsWith / n).toFixed(2)),
    ticsWithout: Number((ticsWithout / n).toFixed(2)),
    ticDelta: Number(((ticsWith - ticsWithout) / n).toFixed(2)),
    varianceWith: Number((varianceWith / n).toFixed(2)),
    varianceWithout: Number((varianceWithout / n).toFixed(2)),
    openersWith,
    openersWithout,
    typographyErrorsWith: typoWith,
    typographyErrorsWithout: typoWithout,
    punchlinesWith: punchWith,
    punchlinesWithout: punchWithout,
  };
}
