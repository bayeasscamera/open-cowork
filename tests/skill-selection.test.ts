import { describe, expect, it } from 'vitest';
import {
  formatSkillHint,
  selectRelevantSkills,
  skillSelectionDirs,
} from '../src/main/agent/skill-selection';
import type { RuntimeSkillEntry } from '../src/shared/skill-runtime-types';

function skill(
  name: string,
  description?: string,
  enabled = true
): RuntimeSkillEntry {
  return { name, description, path: `/skills/${name}`, enabled };
}

const CATALOGUE: RuntimeSkillEntry[] = [
  skill('pdf', 'Extract text and tables from PDF documents'),
  skill('docx', 'Create and edit Word documents'),
  skill('spreadsheet', 'Read and write CSV and Excel files'),
  skill('image-editing', 'Crop and resize images'),
  skill('frontend-slides', 'Build presentation slide decks'),
];

describe('selectRelevantSkills', () => {
  it('picks the skill whose name matches the task', () => {
    const selected = selectRelevantSkills('extract the tables from this pdf', CATALOGUE);

    expect(selected.map((s) => s.name)).toContain('pdf');
  });

  it('ranks a name match above a description-only match', () => {
    const skills: RuntimeSkillEntry[] = [
      skill('helper', 'handles pdf files as a side job'),
      skill('pdf', 'Extract text and tables from PDF documents'),
    ];

    const selected = selectRelevantSkills('read the pdf', skills);

    expect(selected[0]?.name).toBe('pdf');
  });

  it('never returns more than maxSkills', () => {
    const many = Array.from({ length: 20 }, (_, i) => skill(`skill-${i}`, 'a skill'));

    const selected = selectRelevantSkills('a skill', many, { maxSkills: 3 });

    expect(selected).toHaveLength(3);
  });

  it('honours the per-skill enable toggle — a disabled skill is never selected', () => {
    const skills: RuntimeSkillEntry[] = [
      skill('pdf', 'Extract text from PDF', false),
      skill('docx', 'Word documents'),
    ];

    const selected = selectRelevantSkills('extract the pdf', skills);

    expect(selected.map((s) => s.name)).not.toContain('pdf');
  });

  it('returns nothing when every skill is disabled', () => {
    const skills = [skill('pdf', 'PDFs', false), skill('docx', 'Word', false)];

    expect(selectRelevantSkills('do something', skills)).toEqual([]);
  });

  it('still offers skills when the task text shares no vocabulary with any of them', () => {
    // A short or non-English task must not end up with zero skills: that is
    // exactly the failure this whole change exists to fix.
    const selected = selectRelevantSkills('fais-le', CATALOGUE);

    expect(selected.length).toBeGreaterThan(0);
  });

  it('is deterministic — the same task selects the same skills every time', () => {
    const task = 'export the spreadsheet as a document';

    const first = selectRelevantSkills(task, CATALOGUE).map((s) => s.name);
    const second = selectRelevantSkills(task, CATALOGUE).map((s) => s.name);

    expect(first).toEqual(second);
  });

  it('returns nothing when there are no skills at all', () => {
    expect(selectRelevantSkills('anything', [])).toEqual([]);
  });

  it('respects a maxSkills of zero', () => {
    expect(selectRelevantSkills('pdf', CATALOGUE, { maxSkills: 0 })).toEqual([]);
  });

  it('matches multi-word and namespaced skill names', () => {
    const skills = [skill('frontend-slides', 'Build slide decks')];

    const selected = selectRelevantSkills('build frontend slides for the review', skills);

    expect(selected.map((s) => s.name)).toEqual(['frontend-slides']);
  });
});

describe('skillSelectionDirs', () => {
  it('maps the selection to the directories the loader expects', () => {
    expect(skillSelectionDirs(CATALOGUE.slice(0, 2))).toEqual(['/skills/pdf', '/skills/docx']);
  });

  it('returns an empty list for an empty selection', () => {
    expect(skillSelectionDirs([])).toEqual([]);
  });
});

describe('formatSkillHint', () => {
  it('names each selected skill with its description', () => {
    const hint = formatSkillHint([skill('pdf', 'Extract text from PDF')]);

    expect(hint).toContain('<available_skills>');
    expect(hint).toContain('- pdf: Extract text from PDF');
    expect(hint).toContain('</available_skills>');
  });

  it('omits the description when the skill has none', () => {
    expect(formatSkillHint([skill('pdf')])).toContain('- pdf\n');
  });

  it('returns an empty string when nothing was selected', () => {
    // An empty hint must not leave an empty <available_skills> block in the
    // prompt, which would imply skills exist but none were found.
    expect(formatSkillHint([])).toBe('');
  });
});