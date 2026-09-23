import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeSkillRuntime,
  discoverSkillDirs,
  parseSkillFrontmatter,
  runtimeSkillDirs,
} from '../src/main/skills/skill-runtime-view';

const roots: string[] = [];

const makeRoot = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-view-'));
  roots.push(dir);
  return dir;
};

const writeSkill = (root: string, name: string, content: string): string => {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
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

describe('parseSkillFrontmatter', () => {
  it('reads name and description from the YAML block', () => {
    expect(
      parseSkillFrontmatter('---\nname: pdf\ndescription: Work with PDFs\n---\n# body')
    ).toEqual({ name: 'pdf', description: 'Work with PDFs' });
  });

  it('strips surrounding quotes and ignores unrelated keys', () => {
    expect(
      parseSkillFrontmatter('---\nname: "docx"\nlicense: MIT\ndescription: \'Docs\'\n---')
    ).toEqual({ name: 'docx', description: 'Docs' });
  });

  it('returns nothing when there is no frontmatter block', () => {
    expect(parseSkillFrontmatter('# just a heading')).toEqual({});
  });
});

describe('discoverSkillDirs', () => {
  it('finds direct and nested skill directories', () => {
    const root = makeRoot();
    const direct = writeSkill(root, 'pdf', '---\nname: pdf\n---');
    const nested = writeSkill(path.join(root, 'group'), 'xlsx', '---\nname: xlsx\n---');
    expect(discoverSkillDirs(root).sort()).toEqual([direct, nested].sort());
  });

  it('stops at a skill directory instead of recursing into it', () => {
    const root = makeRoot();
    const outer = writeSkill(root, 'outer', '---\nname: outer\n---');
    writeSkill(path.join(outer, 'inner'), 'inner', '---\nname: inner\n---');
    expect(discoverSkillDirs(root)).toEqual([outer]);
  });

  it('skips dot-directories and node_modules', () => {
    const root = makeRoot();
    writeSkill(path.join(root, '.disabled'), 'hidden', '---\nname: hidden\n---');
    writeSkill(path.join(root, 'node_modules'), 'dep', '---\nname: dep\n---');
    expect(discoverSkillDirs(root)).toEqual([]);
  });

  it('returns nothing for a root that does not exist', () => {
    expect(discoverSkillDirs(path.join(os.tmpdir(), 'skill-view-missing-root'))).toEqual([]);
  });
});

describe('describeSkillRuntime', () => {
  it('groups skills by source and counts loaded versus disabled', () => {
    const builtin = makeRoot();
    const global = makeRoot();
    writeSkill(builtin, 'pdf', '---\nname: pdf\ndescription: PDFs\n---');
    writeSkill(global, 'mine', '---\nname: mine\n---');

    const view = describeSkillRuntime(
      [
        { root: builtin, kind: 'builtin' },
        { root: global, kind: 'global' },
      ],
      (name) => name !== 'mine'
    );

    expect(view.loaded).toBe(1);
    expect(view.disabled).toBe(1);
    expect(view.sources.map((source) => source.kind)).toEqual(['builtin', 'global']);
    expect(view.sources[0].skills[0]).toMatchObject({
      name: 'pdf',
      enabled: true,
      description: 'PDFs',
    });
    expect(view.sources[1].skills[0]).toMatchObject({ name: 'mine', enabled: false });
  });

  it('falls back to the directory name when the frontmatter has no name', () => {
    const root = makeRoot();
    writeSkill(root, 'no-frontmatter', '# nothing here');
    const view = describeSkillRuntime([{ root, kind: 'global' }]);
    expect(view.sources[0].skills[0].name).toBe('no-frontmatter');
  });

  it('enables everything when no predicate is supplied', () => {
    const root = makeRoot();
    writeSkill(root, 'a', '---\nname: a\n---');
    const view = describeSkillRuntime([{ root, kind: 'global' }]);
    expect(view.loaded).toBe(1);
    expect(view.disabled).toBe(0);
  });

  it('sorts skills by name', () => {
    const root = makeRoot();
    writeSkill(root, 'z', '---\nname: zeta\n---');
    writeSkill(root, 'a', '---\nname: alpha\n---');
    const view = describeSkillRuntime([{ root, kind: 'global' }]);
    expect(view.sources[0].skills.map((skill) => skill.name)).toEqual(['alpha', 'zeta']);
  });
});

describe('runtimeSkillDirs', () => {
  it('returns only the enabled skill directories', () => {
    const root = makeRoot();
    const keep = writeSkill(root, 'keep', '---\nname: keep\n---');
    writeSkill(root, 'drop', '---\nname: drop\n---');
    const view = describeSkillRuntime([{ root, kind: 'global' }], (name) => name === 'keep');
    expect(runtimeSkillDirs(view)).toEqual([keep]);
  });
});
