/**
 * Tests for the first-query skills directory setup extracted from
 * CoworkAgentRunner.run().
 *
 * The module drives the real filesystem against a temp directory, so these
 * tests exercise the asar copy / symlink / broken-symlink recovery paths for
 * real; only the sync collaborators are stubbed and the logger is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));

vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

import {
  setupSkillsDirectories,
  type SkillsDirectorySetupDeps,
} from '../src/main/agent/skills-directory-setup';

let root: string;

function mkdir(...segments: string[]): string {
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setup(over: Partial<SkillsDirectorySetupDeps> = {}) {
  const copyDirectorySync = vi.fn();
  const syncUserSkillsToAppDir = vi.fn();
  const syncConfiguredSkillsToRuntimeDir = vi.fn();
  const deps: SkillsDirectorySetupDeps = {
    appAgentDir: path.join(root, 'claude'),
    runtimeSkillsDir: path.join(root, 'claude', 'skills'),
    builtinSkillsPath: path.join(root, 'missing-builtin'),
    copyDirectorySync,
    syncUserSkillsToAppDir,
    syncConfiguredSkillsToRuntimeDir,
    ...over,
  };
  setupSkillsDirectories(deps);
  return { deps, copyDirectorySync, syncUserSkillsToAppDir, syncConfiguredSkillsToRuntimeDir };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-setup-'));
  mocks.log.mockClear();
  mocks.logWarn.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('setupSkillsDirectories', () => {
  it('creates the config and skills roots and always runs the syncs', () => {
    const { deps, syncUserSkillsToAppDir, syncConfiguredSkillsToRuntimeDir } = setup();
    expect(fs.existsSync(deps.appAgentDir)).toBe(true);
    expect(fs.existsSync(deps.runtimeSkillsDir)).toBe(true);
    expect(syncUserSkillsToAppDir).toHaveBeenCalledWith(deps.runtimeSkillsDir);
    expect(syncConfiguredSkillsToRuntimeDir).toHaveBeenCalledWith(deps.runtimeSkillsDir);
  });

  it('symlinks built-in skill directories and skips plain files', () => {
    const builtin = mkdir('builtin');
    mkdir('builtin', 'alpha');
    fs.writeFileSync(path.join(builtin, 'README.md'), 'not a skill');
    const runtime = path.join(root, 'claude', 'skills');
    setup({ builtinSkillsPath: builtin });
    expect(fs.lstatSync(path.join(runtime, 'alpha')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(runtime, 'README.md'))).toBe(false);
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Linked built-in skill: alpha');
  });

  it('does not overwrite a skill that already exists in the runtime dir', () => {
    const builtin = mkdir('builtin');
    mkdir('builtin', 'alpha');
    mkdir('claude', 'skills', 'alpha');
    const { copyDirectorySync } = setup({ builtinSkillsPath: builtin });
    expect(fs.lstatSync(path.join(root, 'claude', 'skills', 'alpha')).isSymbolicLink()).toBe(false);
    expect(copyDirectorySync).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalledWith('[CoworkAgentRunner] Linked built-in skill: alpha');
  });

  it('copies instead of symlinking when the source lives inside an asar archive', () => {
    const builtin = mkdir('app.asar', 'skills');
    mkdir('app.asar', 'skills', 'alpha');
    const { copyDirectorySync } = setup({ builtinSkillsPath: builtin });
    expect(copyDirectorySync).toHaveBeenCalledWith(
      path.join(builtin, 'alpha'),
      path.join(root, 'claude', 'skills', 'alpha')
    );
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Copied built-in skill from asar: alpha'
    );
  });

  it('treats .asar.unpacked as a real directory and symlinks it', () => {
    const builtin = mkdir('app.asar.unpacked', 'skills');
    mkdir('app.asar.unpacked', 'skills', 'alpha');
    setup({ builtinSkillsPath: builtin });
    expect(fs.lstatSync(path.join(root, 'claude', 'skills', 'alpha')).isSymbolicLink()).toBe(true);
    expect(mocks.log).toHaveBeenCalledWith('[CoworkAgentRunner] Linked built-in skill: alpha');
  });

  it('removes a stale symlink pointing into an asar before re-linking', () => {
    const builtin = mkdir('builtin');
    mkdir('builtin', 'alpha');
    const runtime = mkdir('claude', 'skills');
    fs.symlinkSync(
      path.join(root, 'old.asar', 'skills', 'alpha'),
      path.join(runtime, 'alpha'),
      'dir'
    );
    setup({ builtinSkillsPath: builtin });
    expect(mocks.log).toHaveBeenCalledWith(
      `[CoworkAgentRunner] Removed broken asar symlink: ${path.join(runtime, 'alpha')}`
    );
    expect(fs.readlinkSync(path.join(runtime, 'alpha'))).toBe(path.join(builtin, 'alpha'));
  });

  it('falls back to a recursive copy when symlinking fails', () => {
    const builtin = mkdir('builtin');
    mkdir('builtin', 'alpha');
    const runtime = mkdir('claude', 'skills');
    // A dangling symlink makes existsSync false but symlinkSync throw EEXIST.
    fs.symlinkSync(path.join(root, 'gone'), path.join(runtime, 'alpha'), 'dir');
    const { copyDirectorySync } = setup({ builtinSkillsPath: builtin });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Failed to symlink alpha, copying instead:',
      expect.any(Error)
    );
    expect(copyDirectorySync).toHaveBeenCalledWith(
      path.join(builtin, 'alpha'),
      path.join(runtime, 'alpha')
    );
  });

  it('is a no-op for built-ins when the shipped directory is absent', () => {
    const { copyDirectorySync } = setup({ builtinSkillsPath: '' });
    expect(copyDirectorySync).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });
});
