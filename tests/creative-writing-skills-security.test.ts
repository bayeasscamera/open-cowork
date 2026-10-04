import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Security review of the third-party creative-writing skills, automated.
 *
 * These files are third-party instructions that ENTER THE MODEL PROMPT, so they
 * are untrusted input until proven otherwise: a hidden instruction in a skill
 * is a prompt injection. Every check here mirrors a manual pass done when the
 * skills were imported; the point of the test is that a future edit cannot
 * reintroduce what the manual review removed.
 */

const SKILLS_DIR = path.resolve(import.meta.dirname, '..', '.claude', 'skills');

const CREATIVE_SKILLS = [
  'creative-writing-muse',
  'writing-principles',
  'llm-writing',
  'creative-writing-craft',
  'creative-writing-modes',
  'story-review',
  'stop-slop',
] as const;

const ALLOWED_DOMAINS = [
  // Bibliographic references carried over from the upstream citations file.
  'arxiv.org',
  'aclanthology.org',
  'doi.org',
  'pubmed.ncbi.nlm.nih.gov',
];

interface SkillFile {
  rel: string;
  abs: string;
  content: string;
}

function readSkillFiles(skill: string): SkillFile[] {
  const root = path.join(SKILLS_DIR, skill);
  const out: SkillFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(md|py|sh|js|ts)$/.test(entry.name)) continue;
      out.push({ rel: path.relative(SKILLS_DIR, abs), abs, content: fs.readFileSync(abs, 'utf-8') });
    }
  };
  walk(root);
  return out;
}

const ALL_FILES = CREATIVE_SKILLS.flatMap(readSkillFiles);

describe('third-party creative-writing skills: security review', () => {
  describe('no hidden or invisible characters', () => {
    // Zero-width, bidi overrides and C0 controls (minus tab/newline) are the
    // vector for text that renders as nothing but reads as instructions.
    //
    // NOTE: U+00A0 (no-break space) and U+202F (narrow no-break space) are
    // deliberately EXCLUDED. The French typography guide demonstrates them on
    // purpose: they are the fix for a real problem (a colon starting a line),
    // not a hidden payload. They are asserted separately below.
    const DANGEROUS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

    it('finds none in any skill file', () => {
      const offenders = ALL_FILES.filter((f) => DANGEROUS.test(f.content)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });

    it('reports a zero-width space explicitly, the most common case', () => {
      const offenders = ALL_FILES.filter((f) => f.content.includes('\u200B')).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });

    it('keeps no-break spaces only inside the French typography guide', () => {
      const withNbsp = ALL_FILES.filter((f) => f.content.includes('\u00A0'));
      // Every one is a deliberate French-typography demonstration.
      for (const file of withNbsp) {
        expect(file.rel.replace('.claude/skills/', '')).toMatch(/typographie-fr\.md$/);
      }
      // And they are genuinely present, so the guide is not describing an
      // invisible space it never itself uses.
      expect(withNbsp.length).toBeGreaterThan(0);
      const guide = fs.readFileSync(
        path.join(SKILLS_DIR, 'creative-writing-craft', 'references/fr/typographie-fr.md'),
        'utf-8',
      );
      expect(guide).toContain('\u00A0');
    });
  });

  describe('no encoded payloads', () => {
    it('contains no long base64-like blob', () => {
      const offenders = ALL_FILES.filter((f) => /[A-Za-z0-9+/]{120,}={0,2}/.test(f.content)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  });

  describe('no prompt-injection instructions', () => {
    const INJECTION_PATTERNS: Array<[string, RegExp]> = [
      ['ignore prior instructions', /ignore\s+(all\s+|any\s+)?(previous|prior|above|other)\s+(instructions?|rules?)/i],
      ['disregard prior instructions', /disregard\s+(previous|prior|above)/i],
      ['reveal the system prompt', /reveal\s+(your|the)\s+(system\s+)?prompt|print\s+your\s+instructions/i],
      ['hide actions from the user', /(do\s+not|don't|never)\s+(tell|inform|notify|show|mention)\s+(the\s+)?user/i],
      ['bypass a safeguard', /bypass\s+(the\s+)?(safety|guardrail|permission|security)/i],
      ['override the system', /override\s+(the\s+)?(system|safety)/i],
      ['exfiltrate', /exfiltrat|send\s+(the\s+)?(contents?|file|secret)s?\s+to\s+https?:/i],
    ];

    it.each(INJECTION_PATTERNS)('contains no "%s" instruction', (_label, pattern) => {
      const offenders = ALL_FILES.filter((f) => pattern.test(f.content)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  });

  describe('no unexpected network or install commands', () => {
    it('runs no package manager, downloader or vcs fetch', () => {
      const offenders = ALL_FILES.filter((f) =>
        /\b(curl|wget|pip\s+install|npm\s+install|pnpm\s+add|yarn\s+add|apt-get|brew\s+install|git\s+clone)\b/.test(
          f.content,
        ),
      ).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  });

  describe('external references are bibliographic only', () => {
    it('only links to the documented academic domains', () => {
      const offenders: string[] = [];
      for (const file of ALL_FILES) {
        for (const match of file.content.matchAll(/https?:\/\/([^\s)\]"'`,>]+)/g)) {
          const url = match[1];
          if (!ALLOWED_DOMAINS.some((d) => url.startsWith(d))) offenders.push(`${file.rel} -> ${url}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });

  describe('no executable files are required', () => {
    it('ships no script that Cowork would have to run', () => {
      const scripts = ALL_FILES.filter((f) => /\.(py|sh|js|ts)$/.test(f.abs)).map((f) => f.rel);
      expect(scripts).toEqual([]);
    });

    it('references no interpreter in an instruction to the model', () => {
      // `uv run`, `python script.py`, `node script.js` would require a toolchain
      // the host does not assume. Upstream shipped analyze.py; it was removed.
      const offenders = ALL_FILES.filter((f) =>
        /\b(uv\s+run|python\s+\S+\.py|node\s+\S+\.js|bash\s+\S+\.sh)\b/.test(f.content),
      ).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  });

  describe('licence and attribution', () => {
    it.each(CREATIVE_SKILLS)('%s ships its licence file', (skill) => {
      expect(fs.existsSync(path.join(SKILLS_DIR, skill, 'LICENSE'))).toBe(true);
    });

    it('copies the Apache-2.0 text for the Apache-licensed skills', () => {
      const apache: typeof CREATIVE_SKILLS[number][] = [
        'creative-writing-muse',
        'writing-principles',
        'llm-writing',
        'creative-writing-craft',
        'creative-writing-modes',
        'story-review',
      ];
      for (const skill of apache) {
        const licence = fs.readFileSync(path.join(SKILLS_DIR, skill, 'LICENSE'), 'utf-8');
        expect(licence).toMatch(/Apache License/);
        expect(licence).toMatch(/Version 2\.0/);
      }
    });

    it('copies the MIT text for stop-slop', () => {
      const licence = fs.readFileSync(path.join(SKILLS_DIR, 'stop-slop', 'LICENSE'), 'utf-8');
      expect(licence).toMatch(/MIT License/);
      expect(licence).toMatch(/Hardik Pandya/);
    });

    it('has a top-level attribution file pinning both commits', () => {
      const attribution = fs.readFileSync(
        path.resolve(import.meta.dirname, '..', 'THIRD_PARTY_SKILLS.md'),
        'utf-8',
      );
      expect(attribution).toMatch(/0d5bf7fd987554e05db7e05d569736e648297722/);
      expect(attribution).toMatch(/8da1f030185bdfe8471220585162991eaeb970e9/);
      expect(attribution).toMatch(/Apache-2\.0/);
      expect(attribution).toMatch(/MIT/);
    });

    it('states the modifications, as Apache-2.0 requires', () => {
      const attribution = fs.readFileSync(
        path.resolve(import.meta.dirname, '..', 'THIRD_PARTY_SKILLS.md'),
        'utf-8',
      );
      expect(attribution).toMatch(/Modifications/);
    });

    it('does not claim the upstream authors endorsed Cowork', () => {
      const attribution = fs.readFileSync(
        path.resolve(import.meta.dirname, '..', 'THIRD_PARTY_SKILLS.md'),
        'utf-8',
      );
      expect(attribution).not.toMatch(/approve|approved|endorse|endorsed|partnership/i);
    });
  });
});
