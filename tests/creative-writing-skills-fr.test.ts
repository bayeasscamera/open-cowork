import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The French adaptation of the English skills, and its load-bearing rules.
 *
 * Two of those rules exist because translating the English instructions
 * literally produces wrong advice in French. They are asserted here because
 * they are exactly the kind of rule a later "cleanup" would silently undo:
 *
 *  - the em dash is the FRENCH DIALOGUE DASH. English bans it; banning it in
 *    French would break every line of dialogue.
 *  - adverbs are not banned. `-ment` adverbs are ordinary French; only hollow
 *    intensifiers are targeted.
 *
 * These assertions encode editorial decisions, not formatting preferences.
 */

const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '.claude', 'skills');

const SKILLS = [
  'creative-writing-muse',
  'writing-principles',
  'llm-writing',
  'creative-writing-craft',
  'creative-writing-modes',
  'story-review',
  'stop-slop',
] as const;

function skillMd(skill: string): string {
  return fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf-8');
}

function frRef(skill: string, name: string): string {
  return fs.readFileSync(path.join(SKILLS_DIR, skill, 'references', 'fr', name), 'utf-8');
}

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(abs, out);
    else if (entry.name.endsWith('.md')) out.push(abs);
  }
  return out;
}

describe('French adaptation: load-bearing rules', () => {
  describe('the em dash is the dialogue dash, not a tic', () => {
    it('never bans the em dash outright in stop-slop', () => {
      const content = skillMd('stop-slop');
      // The upstream rule was a flat "No em dashes" plus "Em-dash anywhere?
      // Remove it." Both had to be inverted for French. Matched anywhere, not
      // only at the start of a list item, so an inline reintroduction fails too.
      expect(content).not.toMatch(/No em[ -]?dashes/i);
      expect(content).not.toMatch(/Em-dash anywhere\?\s*Remove it/i);
      expect(content).not.toMatch(/tiret.{0,20}(interdit|jamais)\b.{0,40}dialogue/i);
    });

    it('states explicitly that it is never a defect in dialogue', () => {
      // Checked across the skill and its French reference, because the wording
      // differs; what must not vary is the RULE.
      const haystack = [skillMd('stop-slop'), frRef('stop-slop', 'structures-fr.md')].join('\n');
      expect(haystack).toMatch(/jamais[^.]*défaut[^.]*dialogue/i);
    });

    it('documents it as the French dialogue norm in the craft layer', () => {
      const content = frRef('creative-writing-craft', 'craft-fr.md');
      expect(content).toMatch(/tiret de dialogue/i);
    });

    it('shows the dialogue dash correctly in the examples, not removed', () => {
      const examples = frRef('creative-writing-craft', 'exemples-fr.md');
      // A quoted dialogue line carrying the dash proves the convention survived
      // the French adaptation rather than being stripped with the English rule.
      expect(examples).toMatch(/^> \*—\s/m);
      // At least two such lines, so the dialogue convention is demonstrated and
      // not a one-off.
      expect(examples.match(/^> \*—\s/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    it('still flags it as an abuse when used as a parenthetical', () => {
      const structures = frRef('stop-slop', 'structures-fr.md');
      expect(structures).toMatch(/incise/i);
    });
  });

  describe('adverbs are not banned', () => {
    it('does not carry the upstream "Cut all adverbs" rule', () => {
      const content = skillMd('stop-slop');
      expect(content).not.toMatch(/Cut (all )?adverbs/i);
      expect(content).not.toMatch(/Any adverbs\?\s*Kill them/i);
    });

    it('targets hollow intensifiers instead', () => {
      const content = skillMd('stop-slop');
      expect(content).toMatch(/insistance creuse/i);
    });

    it('gives the author a test to decide case by case', () => {
      const tics = frRef('writing-principles', 'tics-ia-fr.md');
      // A blunt ban is the failure mode; the list must ship a discriminator.
      expect(tics).toMatch(/Test/);
      expect(tics).toMatch(/-ment/);
    });

    it('lists ordinary French adverbs as NOT a defect', () => {
      const tics = frRef('writing-principles', 'tics-ia-fr.md');
      expect(tics).toMatch(/n'est\s*\*?\*?pas un défaut/i);
    });
  });

  describe('binary contrasts and rule of three are nuanced, not banned', () => {
    it('gives the French equivalents of the English contrast', () => {
      const structures = frRef('stop-slop', 'structures-fr.md');
      expect(structures).toMatch(/non seulement/i);
      expect(structures).toMatch(/loin d'être/i);
    });

    it('keeps a legitimate exception for the rule of three', () => {
      const structures = frRef('stop-slop', 'structures-fr.md');
      expect(structures).toMatch(/Exception/);
      // The point is the predictable third, not the number three itself.
      expect(structures).toMatch(/pr[ée]visible/i);
    });
  });

  describe('the tic list is presented as provisional', () => {
    it('marks the list as candidates awaiting the author validation', () => {
      const tics = frRef('writing-principles', 'tics-ia-fr.md');
      expect(tics).toMatch(/[àa] valider/i);
      expect(tics).toMatch(/candidat/i);
    });

    it('states how the list must be built from real text', () => {
      const tics = frRef('writing-principles', 'tics-ia-fr.md');
      expect(tics).toMatch(/par 1\s*000 mots|par 1000 mots/i);
    });
  });
});

describe('French adaptation: packaging', () => {
  it.each(SKILLS)('%s has a SKILL.md under 500 lines', (skill) => {
    const content = skillMd(skill);
    expect(content.split('\n').length).toBeLessThan(500);
  });

  it.each(SKILLS)('%s has a valid frontmatter with a name', (skill) => {
    const content = skillMd(skill);
    const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    expect(front, `${skill} has no frontmatter`).not.toBeNull();
    expect(front![1]).toMatch(/name:\s*["']?[a-z0-9-]+/);
  });

  it.each(SKILLS)('%s has a description Cowork can actually parse', (skill) => {
    const content = skillMd(skill);
    const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    // Mirrors SkillsManager.getSkillMetadata: it reads the first line of the
    // frontmatter and takes everything up to a closing quote. A folded
    // `description: >` made the loader return the literal ">" and ship an empty
    // description, so both facts are asserted.
    const asLoaderSeesIt = front![1].match(/description:\s*["']?([^"'\r\n]+)/);
    expect(asLoaderSeesIt, `${skill} has no description`).not.toBeNull();
    expect(asLoaderSeesIt![1].trim()).not.toBe('>');
    expect(asLoaderSeesIt![1].trim().length).toBeGreaterThan(40);

    // And the line must be a single one: a folded description would be legal
    // YAML but is unreadable by this loader.
    const descriptionLines = front![1]
      .split('\n')
      .filter((line) => line.trimStart().startsWith('description:'));
    expect(descriptionLines).toHaveLength(1);
    expect(descriptionLines[0]).not.toMatch(/description:\s*[>|]/);
  });

  it.each(SKILLS)('%s has a description in French and in English', (skill) => {
    const content = skillMd(skill);
    // Read the WHOLE frontmatter line. The descriptions are quoted, and the
    // loader's own regex stops at the closing quote, so capturing only that
    // slice would silently test the English half alone.
    const front = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1];
    const description = front
      .split('\n')
      .find((line) => line.startsWith('description:'))!
      .replace(/^description:\s*/, '')
      .replace(/^["']|["']$/g, '');
    // Bilingual so the skill triggers on "écris une nouvelle" as well as on
    // "write a short story". A French-specific letter (accented, cedilla,
    // oe ligature) proves the French half is really there.
    expect(description).toMatch(/[\u00C0-\u024F]/);
    expect(description.length).toBeGreaterThan(80);
  });

  it('requires stop-slop to be invoked explicitly, never automatically', () => {
    // A mechanical pass damages prose that is already alive.
    expect(skillMd('stop-slop')).toMatch(/disable-model-invocation:\s*true/);
  });

  it('gives stop-slop a fidelity guardrail', () => {
    const content = skillMd('stop-slop');
    expect(content).toMatch(/sens/);
    expect(content).toMatch(/faits/);
    expect(content).toMatch(/voix/);
    // It must be allowed to decline rather than decide.
    expect(content).toMatch(/signale|hésite/i);
  });

  it('carries the licence line for the MIT skill', () => {
    expect(skillMd('stop-slop')).toMatch(/MIT/);
  });

  it('carries the licence line for the Apache skills', () => {
    for (const skill of ['writing-principles', 'llm-writing', 'story-review'] as const) {
      expect(skillMd(skill)).toMatch(/Apache-2\.0/);
    }
  });
});

describe('French adaptation: internal links resolve', () => {
  it.each(SKILLS)('%s has no dead internal link', (skill) => {
    const root = path.join(SKILLS_DIR, skill);
    const dead: string[] = [];
    for (const file of collectFiles(root)) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const match of content.matchAll(/\]\(([^)]+\.md)\)/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (!fs.existsSync(target)) dead.push(`${path.relative(root, file)} -> ${match[1]}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it.each(SKILLS)('%s has no orphan resource file', (skill) => {
    const root = path.join(SKILLS_DIR, skill);
    const files = collectFiles(root);
    const referenced = new Set<string>();
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const match of content.matchAll(/\]\(([^)]+\.md)\)/g)) {
        referenced.add(path.resolve(path.dirname(file), match[1]));
      }
    }
    const orphans = files
      .map((f) => path.resolve(f))
      .filter((f) => !['SKILL.md', 'LICENSE'].includes(path.basename(f)) && !referenced.has(f));
    expect(orphans.map((o) => path.relative(root, o))).toEqual([]);
  });
});

describe('French adaptation: no missing-agent references', () => {
  const ABSENT_SKILLS = [
    'intent-modeling',
    'information-hierarchy',
    'reader-sim',
    'character-sim',
    'shared-dao',
    'story-planning',
    'story-memory',
    'creative-research',
    'kb-management',
    'project-setup',
  ];

  it.each(SKILLS)('%s does not route to a skill Cowork does not have', (skill) => {
    const root = path.join(SKILLS_DIR, skill);
    const offenders: string[] = [];
    for (const file of collectFiles(root)) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const absent of ABSENT_SKILLS) {
        // The upstream convention was a route `/skill-name`, which the model
        // would try to load. A FILE whose name merely starts with the same
        // prefix (reader-sim-signal.md) is not a route, so it is excluded:
        // requiring the slash to be followed by the exact name and NOT by more
        // word characters.
        const route = new RegExp(`/${absent}(?![\\w-])`);
        if (route.test(content)) {
          offenders.push(`${path.relative(root, file)} -> /${absent}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not declare itself under an absent skill name', () => {
    for (const skill of SKILLS) {
      expect(ABSENT_SKILLS).not.toContain(skill);
    }
  });

  it('still points at skills Cowork actually ships', () => {
    expect(fs.existsSync(path.join(SKILLS_DIR, 'docx', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(SKILLS_DIR, 'security-audit', 'SKILL.md'))).toBe(true);
  });
});
