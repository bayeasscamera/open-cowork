import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testRoot = '';
let persistedRows: Array<{ id: string; enabled: number }> = [];
const statement = { run: vi.fn(), all: vi.fn(() => persistedRows) };

vi.mock('electron', () => ({
  app: {
    getAppPath: () => testRoot,
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => {
      if (name === 'userData') return path.join(testRoot, 'userData');
      if (name === 'home') return path.join(testRoot, 'home');
      return testRoot;
    },
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { SkillsManager } from '../src/main/skills/skills-manager';
import type { DatabaseInstance } from '../src/main/db/database';

function createDbMock(): DatabaseInstance {
  return {
    raw: {} as any,
    sessions: {} as any,
    messages: {} as any,
    traceSteps: {} as any,
    scheduledTasks: {} as any,
    prepare: vi.fn(() => statement as any),
    exec: vi.fn(),
    pragma: vi.fn(),
    close: vi.fn(),
  };
}

const writeSkill = (root: string, dir: string, name: string): void => {
  const skillDir = path.join(root, dir);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: ' + name + '\ndescription: d\n---\n',
    'utf8'
  );
};

let globalDir = '';

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-enabled-'));
  // Must sit under an allowed base (userData/home/cwd) or the manager refuses it.
  globalDir = path.join(testRoot, 'userData', 'claude', 'skills');
  fs.mkdirSync(globalDir, { recursive: true });
  persistedRows = [];
  statement.run.mockClear();
  statement.all.mockClear();
  statement.all.mockImplementation(() => persistedRows);
});

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe('skill enablement persistence', () => {
  it('restores a disabled skill from the database', async () => {
    writeSkill(globalDir, 'persisted', 'persisted');
    persistedRows = [{ id: 'global-persisted', enabled: 0 }];
    const manager = new SkillsManager(createDbMock(), {
      getConfiguredGlobalSkillsPath: () => globalDir,
    });
    const skills = await manager.listSkills({ type: 'custom' });
    expect(skills.find((skill) => skill.name === 'persisted')?.enabled).toBe(false);
  });

  it('keeps a skill enabled when the database has no row for it', async () => {
    writeSkill(globalDir, 'fresh', 'fresh');
    const manager = new SkillsManager(createDbMock(), {
      getConfiguredGlobalSkillsPath: () => globalDir,
    });
    const skills = await manager.listSkills({ type: 'custom' });
    expect(skills.find((skill) => skill.name === 'fresh')?.enabled).toBe(true);
  });

  it('persists the flag when the user toggles a skill', async () => {
    writeSkill(globalDir, 'toggled', 'toggled');
    const manager = new SkillsManager(createDbMock(), {
      getConfiguredGlobalSkillsPath: () => globalDir,
    });
    await manager.listSkills({ type: 'custom' });

    manager.setSkillEnabled('global-toggled', false);

    expect(statement.run).toHaveBeenCalledWith(
      'global-toggled',
      'toggled',
      'd',
      'custom',
      0,
      null,
      expect.any(Number)
    );
    expect(manager.getAllSkills().find((skill) => skill.id === 'global-toggled')?.enabled).toBe(false);
  });

  it('ignores a toggle for an unknown skill id', async () => {
    const manager = new SkillsManager(createDbMock(), {
      getConfiguredGlobalSkillsPath: () => globalDir,
    });
    manager.setSkillEnabled('global-missing', false);
    expect(statement.run).not.toHaveBeenCalled();
  });

  it('falls back to enabled when the skills table cannot be read', async () => {
    writeSkill(globalDir, 'safe', 'safe');
    statement.all.mockImplementationOnce(() => {
      throw new Error('no such table: skills');
    });
    const manager = new SkillsManager(createDbMock(), {
      getConfiguredGlobalSkillsPath: () => globalDir,
    });
    const skills = await manager.listSkills({ type: 'custom' });
    expect(skills.find((skill) => skill.name === 'safe')?.enabled).toBe(true);
  });
});
