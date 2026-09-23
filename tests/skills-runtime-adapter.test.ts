import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { createSkillsRuntimeAdapter } from '../src/main/skills/skills-runtime-adapter';

const roots: string[] = [];

const makeRoot = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-adapter-'));
  roots.push(dir);
  return dir;
};

const writeSkill = (root: string, name: string): string => {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: ' + name + '\n---', 'utf-8');
  return dir;
};

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('skills runtime adapter', () => {
  it('hands the loader one directory per enabled skill', () => {
    const root = makeRoot();
    const pdf = writeSkill(root, 'pdf');
    const docx = writeSkill(root, 'docx');
    const adapter = createSkillsRuntimeAdapter({
      resolveSources: () => [{ root, kind: 'global' }],
      lookup: { getAllSkills: () => [{ name: 'pdf', enabled: true }, { name: 'docx', enabled: true }] },
    });
    expect(adapter.getSkillPaths().sort()).toEqual([pdf, docx].sort());
  });

  it('withholds a skill the user switched off', () => {
    const root = makeRoot();
    const keep = writeSkill(root, 'keep');
    writeSkill(root, 'drop');
    const adapter = createSkillsRuntimeAdapter({
      resolveSources: () => [{ root, kind: 'global' }],
      lookup: { getAllSkills: () => [{ name: 'keep', enabled: true }, { name: 'drop', enabled: false }] },
    });
    expect(adapter.getSkillPaths()).toEqual([keep]);
  });

  it('treats a skill the manager has never seen as enabled', () => {
    const root = makeRoot();
    const fresh = writeSkill(root, 'fresh');
    const adapter = createSkillsRuntimeAdapter({
      resolveSources: () => [{ root, kind: 'global' }],
      lookup: { getAllSkills: () => [] },
    });
    expect(adapter.getSkillPaths()).toEqual([fresh]);
  });

  it('falls back to the supplied roots when discovery throws', () => {
    const adapter = createSkillsRuntimeAdapter({
      resolveSources: () => {
        throw new Error('boom');
      },
      fallback: () => ['/fallback/root'],
    });
    expect(adapter.getSkillPaths()).toEqual(['/fallback/root']);
  });

  it('returns nothing when there is no skill at all', () => {
    const root = makeRoot();
    const adapter = createSkillsRuntimeAdapter({ resolveSources: () => [{ root, kind: 'global' }] });
    expect(adapter.getSkillPaths()).toEqual([]);
  });
});
