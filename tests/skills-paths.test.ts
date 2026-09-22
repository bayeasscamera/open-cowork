/**
 * Tests for the skills directory discovery and synchronization helpers extracted
 * from CoworkAgentRunner (skills-paths.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { app } from 'electron';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
  lstatSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  symlinkSync: vi.fn(),
  rmSync: vi.fn(),
  copyFileSync: vi.fn(),
  getBundledNodePaths: vi.fn(),
  resolveBundledPythonBinDir: vi.fn(),
  configGet: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  mkdirSync: mocks.mkdirSync,
  statSync: mocks.statSync,
  lstatSync: mocks.lstatSync,
  readdirSync: mocks.readdirSync,
  unlinkSync: mocks.unlinkSync,
  symlinkSync: mocks.symlinkSync,
  rmSync: mocks.rmSync,
  copyFileSync: mocks.copyFileSync,
}));
vi.mock('../src/main/config/config-store', () => ({
  configStore: { get: mocks.configGet },
}));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logWarn: vi.fn() }));
vi.mock('../src/main/agent/bundled-binaries', () => ({
  getBundledNodePaths: mocks.getBundledNodePaths,
  resolveBundledPythonBinDir: mocks.resolveBundledPythonBinDir,
}));

import { logWarn } from '../src/main/utils/logger';
import {
  copyDirectorySync,
  getAppAgentDir,
  getBundledPathHints,
  getBuiltinSkillsPath,
  getConfiguredGlobalSkillsDir,
  getRuntimeSkillsDir,
  legacySkillPaths,
  syncConfiguredSkillsToRuntimeDir,
  syncUserSkillsToAppDir,
} from '../src/main/agent/skills-paths';

const userData = '/tmp/oc-user-data';
const home = '/tmp/oc-home';
const appPath = '/tmp/oc-app';
const runtimeSkillsDir = path.join(userData, 'claude', 'skills');
const userSkillsDir = path.join(home, '.claude', 'skills');
const moduleDir = path.resolve(__dirname, '../src/main/agent');
const builtinSkillsDir = path.join(moduleDir, '..', '..', '..', '.claude', 'skills');

const dirent = (name: string, isDir = true) => ({ name, isDirectory: () => isDir });
const dirStat = { isDirectory: () => true, isSymbolicLink: () => false };
const fileStat = { isDirectory: () => false, isSymbolicLink: () => false };

const setPackaged = (packaged: boolean): void => {
  (app as unknown as { isPackaged: boolean }).isPackaged = packaged;
};

beforeEach(() => {
  vi.clearAllMocks();
  setPackaged(false);
  (app as unknown as { getPath: (name: string) => string }).getPath = (name: string) =>
    name === 'userData' ? userData : home;
  (app as unknown as { getAppPath: () => string }).getAppPath = () => appPath;
  mocks.existsSync.mockReturnValue(false);
  mocks.statSync.mockReturnValue(dirStat);
  mocks.lstatSync.mockReturnValue(dirStat);
  mocks.readdirSync.mockReturnValue([]);
  mocks.configGet.mockReturnValue('');
  mocks.getBundledNodePaths.mockReturnValue(null);
  mocks.resolveBundledPythonBinDir.mockReturnValue(null);
});

describe('getBundledPathHints', () => {
  it('returns nothing outside a packaged build', () => {
    expect(getBundledPathHints()).toBe('');
  });

  it('lists bundled node, npx, python and pip when packaged', () => {
    setPackaged(true);
    mocks.getBundledNodePaths.mockReturnValue({ node: '/n/node', npx: '/n/npx' });
    mocks.resolveBundledPythonBinDir.mockReturnValue('/py/bin');
    mocks.existsSync.mockImplementation((p: unknown) => String(p).endsWith('pip3'));

    const hints = getBundledPathHints();

    expect(hints).toContain('<bundled_executables>');
    expect(hints).toContain('- node: /n/node');
    expect(hints).toContain('- npx: /n/npx');
    expect(hints).toContain('- python3: /py/bin/python3');
    expect(hints).toContain('- pip3: /py/bin/pip3');
  });

  it('returns nothing when no bundled executable is found', () => {
    setPackaged(true);
    expect(getBundledPathHints()).toBe('');
  });
});

describe('skills roots', () => {
  it('derives the runtime skills directory from the userData path', () => {
    expect(getAppAgentDir()).toBe(path.join(userData, 'claude'));
    expect(getRuntimeSkillsDir()).toBe(runtimeSkillsDir);
  });

  it('falls back to the runtime directory when no global path is configured', () => {
    expect(getConfiguredGlobalSkillsDir()).toBe(runtimeSkillsDir);
  });

  it('returns the configured directory when it exists', () => {
    mocks.configGet.mockReturnValue('/custom/skills');
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue(dirStat);

    expect(getConfiguredGlobalSkillsDir()).toBe('/custom/skills');
  });

  it('creates a missing configured directory and returns it', () => {
    mocks.configGet.mockReturnValue('/fresh/skills');
    mocks.existsSync.mockReturnValue(false);
    mocks.statSync.mockReturnValue(dirStat);

    expect(getConfiguredGlobalSkillsDir()).toBe('/fresh/skills');
    expect(mocks.mkdirSync).toHaveBeenCalledWith('/fresh/skills', { recursive: true });
  });

  it('falls back with a warning when the configured path is not a directory', () => {
    mocks.configGet.mockReturnValue('/custom/file.txt');
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue(fileStat);

    expect(getConfiguredGlobalSkillsDir()).toBe(runtimeSkillsDir);
    expect(logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Configured skills path is not a directory, fallback to runtime path:',
      '/custom/file.txt'
    );
  });

  it('falls back with a warning when the configured path is unavailable', () => {
    mocks.configGet.mockReturnValue('/broken/skills');
    mocks.existsSync.mockReturnValue(false);
    mocks.mkdirSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    expect(getConfiguredGlobalSkillsDir()).toBe(runtimeSkillsDir);
    expect(logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Configured skills path is unavailable, fallback to runtime path:',
      '/broken/skills',
      expect.any(Error)
    );
  });

  it('resolves the built-in skills directory from the development layout', () => {
    mocks.existsSync.mockImplementation((p: unknown) => p === builtinSkillsDir);

    expect(getBuiltinSkillsPath()).toBe(builtinSkillsDir);
  });

  it('warns when no built-in skills directory exists', () => {
    mocks.existsSync.mockReturnValue(false);

    expect(getBuiltinSkillsPath()).toBe('');
    expect(logWarn).toHaveBeenCalledWith('[CoworkAgentRunner] No built-in skills directory found');
  });

  it('lists existing built-in and global paths as legacy fallbacks', () => {
    mocks.configGet.mockReturnValue('/global/skills');
    mocks.existsSync.mockImplementation(
      (p: unknown) => p === builtinSkillsDir || p === '/global/skills'
    );
    mocks.statSync.mockReturnValue(dirStat);

    expect(legacySkillPaths()).toEqual([builtinSkillsDir, '/global/skills']);
  });
});

describe('syncUserSkillsToAppDir', () => {
  it('does nothing when the user skills directory is missing', () => {
    mocks.existsSync.mockReturnValue(false);

    syncUserSkillsToAppDir(runtimeSkillsDir);

    expect(mocks.readdirSync).not.toHaveBeenCalled();
    expect(mocks.symlinkSync).not.toHaveBeenCalled();
  });

  it('symlinks each user skill directory into the app directory', () => {
    mocks.existsSync.mockImplementation((p: unknown) => p === userSkillsDir);
    mocks.readdirSync.mockReturnValue([dirent('alpha')]);

    syncUserSkillsToAppDir(runtimeSkillsDir);

    expect(mocks.symlinkSync).toHaveBeenCalledWith(
      path.join(userSkillsDir, 'alpha'),
      path.join(runtimeSkillsDir, 'alpha'),
      'dir'
    );
  });

  it('replaces an existing symlink but skips a real directory', () => {
    mocks.existsSync.mockImplementation((p: unknown) => p === userSkillsDir || p.endsWith('alpha'));
    mocks.readdirSync.mockReturnValue([dirent('alpha')]);
    mocks.lstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });

    syncUserSkillsToAppDir(runtimeSkillsDir);
    expect(mocks.symlinkSync).not.toHaveBeenCalled();

    mocks.lstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => true });
    syncUserSkillsToAppDir(runtimeSkillsDir);

    expect(mocks.unlinkSync).toHaveBeenCalledWith(path.join(runtimeSkillsDir, 'alpha'));
    expect(mocks.symlinkSync).toHaveBeenCalledTimes(1);
  });

  it('falls back to a directory copy when symlinking fails', () => {
    mocks.existsSync.mockReturnValue(true);
    mocks.readdirSync.mockImplementation((_p: unknown, opts?: { withFileTypes?: boolean }) =>
      opts?.withFileTypes ? [dirent('alpha')] : ['skill.md']
    );
    mocks.statSync.mockReturnValue(fileStat);
    mocks.lstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => true });
    mocks.symlinkSync.mockImplementation(() => {
      throw new Error('EPERM');
    });

    syncUserSkillsToAppDir(runtimeSkillsDir);

    expect(mocks.copyFileSync).toHaveBeenCalledWith(
      path.join(userSkillsDir, 'alpha', 'skill.md'),
      path.join(runtimeSkillsDir, 'alpha', 'skill.md')
    );
  });
});

describe('syncConfiguredSkillsToRuntimeDir', () => {
  it('does nothing when the configured directory is the runtime directory', () => {
    syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir);
    expect(mocks.readdirSync).not.toHaveBeenCalled();
  });

  it('removes a real target before symlinking the configured skill', () => {
    mocks.configGet.mockReturnValue('/global/skills');
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue(dirStat);
    mocks.lstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => false });
    mocks.readdirSync.mockReturnValue([dirent('beta')]);

    syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir);

    expect(mocks.rmSync).toHaveBeenCalledWith(path.join(runtimeSkillsDir, 'beta'), {
      recursive: true,
      force: true,
    });
    expect(mocks.symlinkSync).toHaveBeenCalledWith(
      path.join('/global/skills', 'beta'),
      path.join(runtimeSkillsDir, 'beta'),
      'dir'
    );
  });

  it('unlinks a symlinked target before relinking', () => {
    mocks.configGet.mockReturnValue('/global/skills');
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue(dirStat);
    mocks.lstatSync.mockReturnValue({ isDirectory: () => true, isSymbolicLink: () => true });
    mocks.readdirSync.mockReturnValue([dirent('beta')]);

    syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir);

    expect(mocks.unlinkSync).toHaveBeenCalledWith(path.join(runtimeSkillsDir, 'beta'));
    expect(mocks.rmSync).not.toHaveBeenCalled();
  });
});

describe('copyDirectorySync', () => {
  it('creates the target and copies files', () => {
    mocks.existsSync.mockReturnValue(false);
    mocks.readdirSync.mockReturnValue(['a.txt']);
    mocks.statSync.mockReturnValue(fileStat);

    copyDirectorySync('/src', '/dst');

    expect(mocks.mkdirSync).toHaveBeenCalledWith('/dst', { recursive: true });
    expect(mocks.copyFileSync).toHaveBeenCalledWith('/src/a.txt', '/dst/a.txt');
  });
});
