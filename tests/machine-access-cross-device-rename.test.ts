/**
 * The cross-device project rename (copy + verify + trash the source) cannot be
 * exercised on a single volume, so the device check is injected. This is the
 * one branch of project-rename that a single-machine test run would otherwise
 * never reach — and it is the branch that can lose user data if it is wrong.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executeRename,
  previewRename,
  type RenameDeps,
} from '../src/main/machine-access/project-rename';
import { FsJournal } from '../src/main/machine-access/fs-journal';

describe('cross-device project rename', () => {
  let root: string;
  let journal: FsJournal;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-xdev-')));
    fs.mkdirSync(path.join(root, 'w', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'w', 'top.txt'), 'top');
    fs.writeFileSync(path.join(root, 'w', 'nested', 'deep.txt'), 'deep');
    fs.mkdirSync(path.join(root, 'w', 'empty-dir'), { recursive: true });
    journal = new FsJournal(null);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const deps = (over: Partial<RenameDeps> = {}): RenameDeps => ({
    getProject: () => ({ id: 'p', name: 'Old', workdir: path.join(root, 'w') }),
    listSessions: () => [],
    listFiles: () => [],
    transaction: (fn) => fn(),
    applyDbUpdates: () => undefined,
    isInUse: () => null,
    journal,
    isSameDevice: () => false, // force the copy path
    ...over,
  });

  it('copies the whole tree, verifies it, then trashes the source', () => {
    const d = deps();
    const out = executeRename(d, previewRename(d, 'p', 'Moved', true));

    // Everything arrived at the destination, byte for byte.
    const dest = out.workdir as string;
    expect(fs.readFileSync(path.join(dest, 'top.txt'), 'utf-8')).toBe('top');
    expect(fs.readFileSync(path.join(dest, 'nested', 'deep.txt'), 'utf-8')).toBe('deep');
    // Directories survive the copy too, including empty ones.
    expect(fs.statSync(path.join(dest, 'empty-dir')).isDirectory()).toBe(true);

    // The source was TRASHED, never deleted: it moved under .cowork-trash.
    expect(fs.existsSync(path.join(root, 'w'))).toBe(false);
    const trashDir = path.join(root, '.cowork-trash');
    expect(fs.existsSync(trashDir)).toBe(true);
    const trashed = fs.readdirSync(trashDir);
    expect(trashed).toHaveLength(1);
    expect(fs.readFileSync(path.join(trashDir, trashed[0] as string, 'top.txt'), 'utf-8')).toBe('top');
  });

  it('journals the move so it can be undone', () => {
    const d = deps();
    executeRename(d, previewRename(d, 'p', 'Moved', true));
    const ops = journal.history();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.destination).toContain('Moved');
  });

  it('aborts without touching the source when verification fails', () => {
    // Corrupt the tree AFTER the plan is built is impossible (copy happens
    // during execution), so instead assert the guard: an unreadable source
    // makes the copy throw before the database is touched.
    const d = deps({
      getProject: () => ({ id: 'p', name: 'Old', workdir: path.join(root, 'missing') }),
    });
    expect(() => executeRename(d, previewRename(d, 'p', 'Moved', true))).toThrow();
    expect(journal.history()).toHaveLength(0);
  });

  it('same-device uses an atomic rename and leaves no trash', () => {
    const d = deps({ isSameDevice: () => true });
    const out = executeRename(d, previewRename(d, 'p', 'Quick', true));
    expect(fs.existsSync(path.join(out.workdir as string, 'top.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.cowork-trash'))).toBe(false);
  });

  it('production default: two temp dirs on one volume report the same device', () => {
    // No isSameDevice injected: the real stat().dev comparison runs. On one
    // volume it must take the atomic-rename path (no trash copy).
    const d = deps({ isSameDevice: undefined });
    const out = executeRename(d, previewRename(d, 'p', 'SameVol', true));
    expect(fs.existsSync(path.join(out.workdir as string, 'nested', 'deep.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.cowork-trash'))).toBe(false);
  });
});