import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Trigger tests: which skill the description should select, for a given request.
 *
 * These are DECISION cases, not execution cases. Cowork picks a skill by
 * matching the request against each description; there is no runtime to call
 * here, so the assertion is that the expected skill's description is the one
 * that carries the trigger vocabulary for that request, and that no
 * non-writing skill claims it.
 *
 * The two directions matter equally. A writing skill that fires on a code
 * request is worse than a writing skill that never fires, because it pulls
 * prose guidance into a programming task.
 */

const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '.claude', 'skills');

/** Normalisation comparable to a naive keyword matcher. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents: "ecris" matches "écris"
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words that carry no domain signal. "écris" appears in a script request as well
 * as a story request, and "cette"/"write" are pure grammar, so counting them as
 * a match would make every skill claim every request. A real trigger needs a
 * DOMAIN word, not a function word.
 */
const STOPWORDS = new Set([
  // french function words and verbs that also occur in technical requests
  'ecris', 'ecrevez', 'ecrit', 'fais', 'fait', 'faites', 'avec', 'pour', 'dans',
  'cette', 'cet', 'ce', 'les', 'des', 'une', 'un', 'le', 'la', 'plus', 'sans',
  'sous', 'sur', 'par', 'vers', 'chez', 'est', 'sont', 'etre', 'avoir', 'a',
  'que', 'qui', 'quoi', 'dont', 'ne', 'pas', 'plus', 'aussi', 'bien', 'tout',
  'tous', 'toute', 'tres', 'peu', 'bien', 'alors', 'ensuite', 'voila',
  // english function words
  'write', 'make', 'this', 'that', 'with', 'from', 'into', 'your', 'have',
  'should', 'would', 'could', 'them', 'then', 'than', 'some', 'more', 'most',
  'been', 'being', 'they', 'them', 'what', 'which', 'will', 'just', 'only',
]);

/** Discriminative tokens of a request: content words only. */
function signalTokens(request: string): string[] {
  return normalize(request)
    .split(' ')
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));
}

/** Does the description carry at least one signal token of the request? */
function descriptionCovers(description: string, request: string): boolean {
  const desc = normalize(description);
  return signalTokens(request).some((token) => desc.includes(token));
}

interface Skill {
  name: string;
  description: string;
}

function loadSkills(): Skill[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(SKILLS_DIR, e.name, 'SKILL.md'))
    .filter((p) => fs.existsSync(p))
    .map((p) => {
      const content = fs.readFileSync(p, 'utf-8');
      const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!front) throw new Error(`${p} has no frontmatter`);
      const line = front[1].split('\n').find((l) => l.startsWith('description:'));
      if (!line) throw new Error(`${p} has no description`);
      return {
        name: path.basename(path.dirname(p)),
        description: line.replace(/^description:\s*/, '').replace(/^["']|["']$/g, ''),
      };
    });
}

const ALL_SKILLS = loadSkills();

/** Skills that must stay silent on a request of a given kind. */
const WRITING_SKILLS = [
  'creative-writing-muse',
  'writing-principles',
  'llm-writing',
  'creative-writing-craft',
  'creative-writing-modes',
  'story-review',
  'stop-slop',
];

function writingSkills(): Skill[] {
  return ALL_SKILLS.filter((s) => WRITING_SKILLS.includes(s.name));
}

function isWriting(skill: Skill): boolean {
  return WRITING_SKILLS.includes(skill.name);
}

/** The explicit trigger examples each description carries, as the model reads them. */
const FRENCH_WRITING_REQUESTS = [
  'écris une nouvelle',
  'rédige le premier chapitre de mon roman',
  'révise ce chapitre, la scène manque de tension',
  'rends ce dialogue plus naturel',
  'polisse ce paragraphe, il sonne plat',
  'fais une relecture éditoriale de ce manuscrit',
  'le style de ce paragraphe sonne artificiel',
];

const ENGLISH_WRITING_REQUESTS = [
  'write a short story',
  'draft the opening scene of my novel',
  'revise this chapter, the pacing drags',
  'make this dialogue more natural',
  'polish this paragraph, it reads flat',
  'do an editorial pass on this manuscript',
];

const CODE_REQUESTS = [
  'ajoute une fonction de tri à src/utils.ts',
  'le test échoue, trouver le bug',
  'écris le script bash qui renomme les fichiers',
  'write a function that debounces a callback',
  'refactor this component to use a hook',
  'optimise cette requête SQL',
  'crée un endpoint REST en Python',
];

describe('writing skills: trigger vocabulary in the description', () => {
  it('every writing skill carries a parseable bilingual description', () => {
    for (const skill of writingSkills()) {
      expect(skill.description.length, `${skill.name} description too short`).toBeGreaterThan(80);
    }
  });

  it.each(FRENCH_WRITING_REQUESTS)('the set carries a French trigger for "%s"', (request) => {
    // At least one writing skill's description must contain a distinctive token
    // of the request, which is what makes the match possible at all.
    const tokens = signalTokens(request);
    const found = writingSkills().some((skill) => descriptionCovers(skill.description, request));
    expect(found, `no writing description mentions any signal word of: ${tokens.join(', ')}`).toBe(true);
  });

  it.each(ENGLISH_WRITING_REQUESTS)('the set carries an English trigger for "%s"', (request) => {
    const tokens = signalTokens(request);
    const found = writingSkills().some((skill) => descriptionCovers(skill.description, request));
    expect(found, `no writing description mentions any signal word of: ${tokens.join(', ')}`).toBe(true);
  });

  it.each(CODE_REQUESTS)('no writing skill claims the code request "%s"', (request) => {
    // A code request carries no writing vocabulary, so no writing description
    // should mention a distinctive token of it. This is the direction that
    // matters: prose guidance leaking into a programming task is the failure.
    const tokens = signalTokens(request);
    const offenders = writingSkills()
      .filter((skill) => {
        const desc = normalize(skill.description);
        return tokens.some((token) => desc.includes(token));
      })
      .map((skill) => skill.name);
    expect(offenders, `writing skill(s) claim the code request via: ${tokens.join(', ')}`).toEqual([]);
  });

  it('stop-slop is marked as explicit-only, so it cannot fire on its own', () => {
    const stopSlop = ALL_SKILLS.find((s) => s.name === 'stop-slop');
    expect(stopSlop).toBeDefined();
    const content = fs.readFileSync(path.join(SKILLS_DIR, 'stop-slop', 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/disable-model-invocation:\s*true/);
    // And its own text insists on an explicit request.
    expect(stopSlop!.description).toMatch(/explicit/i);
  });

  it('the other writing skills stay model-invocable, which is what makes them useful', () => {
    for (const name of WRITING_SKILLS.filter((n) => n !== 'stop-slop')) {
      const content = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8');
      expect(content, `${name} must not be explicit-only`).not.toMatch(
        /disable-model-invocation:\s*true/,
      );
    }
  });
});

describe('writing skills: no collision with the existing suite', () => {
  it('the existing document skills still exist and are distinct', () => {
    for (const name of ['docx', 'pdf', 'pptx', 'xlsx']) {
      expect(ALL_SKILLS.map((s) => s.name)).toContain(name);
    }
  });

  it('no writing-skill description claims a document FORMAT', () => {
    // "write a report in docx" must go to the docx skill. A fiction skill may
    // legitimately say "writing"; it must not name a file format, because that
    // is what would actually route the request to it.
    const formats = /\b(docx|pdf|pptx|xlsx|odt|rtf|powerpoint|spreadsheet|workbook|deck)\b/;
    const offenders = writingSkills()
      .filter((skill) => formats.test(skill.description))
      .map((skill) => skill.name);
    expect(offenders, `writing skill(s) name a document format: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the format requests stay owned by the document skills', () => {
    const formatRequests = [
      'mets ce rapport en docx',
      'convert this to pdf',
      'build a powerpoint deck',
      'fill this spreadsheet',
    ];
    for (const request of formatRequests) {
      const formats = /\b(docx|pdf|pptx|xlsx|powerpoint|spreadsheet|deck)\b/;
      // At least one DOCUMENT skill must carry the format vocabulary...
      const docOwner = ALL_SKILLS.some(
        (s) => !isWriting(s) && formats.test(normalize(s.description)),
      );
      expect(docOwner, `no document skill covers "${request}"`).toBe(true);
      // ...and no writing skill may.
      const fictionOwner = writingSkills().some((s) => formats.test(normalize(s.description)));
      expect(fictionOwner, `a writing skill claims the format in "${request}"`).toBe(false);
    }
  });

  it('does not collide with tender-and-funding-response or i-have-adhd', () => {
    const others = ['tender-and-funding-response', 'i-have-adhd'];
    for (const name of others) {
      const exists = fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'));
      expect(exists, `${name} should still exist`).toBe(true);
    }
    // The ADHD skill shapes output format; the writing skills shape prose. They
    // must not be described as the same thing.
    const adhd = fs.readFileSync(path.join(SKILLS_DIR, 'i-have-adhd', 'SKILL.md'), 'utf-8');
    for (const skill of writingSkills()) {
      expect(adhd).not.toMatch(new RegExp(skill.name));
    }
  });
});
