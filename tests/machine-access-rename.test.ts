import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executeRename,
  previewRename,
  validateProjectName,
  type RenameDeps,
} from '../src/main/machine-access/project-rename';
import { FsJournal } from '../src/main/machine-access/fs-journal';

function makeDeps(root: string, overrides: Partial<RenameDeps> = {}): {
  deps: RenameDeps;
  state: { name: string; workdir: string; sessions: Array<{ id: string; cwd: string }>; files: string[] };
} {
  const workdir = path.join(root, 'proj');
  fs.mkdirSync(path.join(workdir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(workdir, 'sub', 'f.txt'), 'x');
  const state = {
    name: 'Old',
    workdir,
    sessions: [{ id: 's1', cwd: path.join(workdir, 'sub') }],
    files: [path.join(workdir, 'sub', 'f.txt')],
  };
  const deps: RenameDeps = {
    getProject: () => ({ id: 'p1', name: state.name, workdir: state.workdir }),
    listSessions: () => state.sessions,
    listFiles: () => state.files,
    transaction: (fn) => fn(),
    applyDbUpdates: (u) => {
      state.name = u.project.name;
      if (u.project.workdir) state.workdir = u.project.workdir;
      for (const s of u.sessions) {
        const cur = state.sessions.find((x) => x.id === s.id);
        if (cur) cur.cwd = s.cwd;
      }
      state.files = u.files.map((f) => f.after);
    },
    isInUse: () => null,
    journal: new FsJournal(null),
    ...overrides,
  };
  return { deps, state };
}

describe('project rename', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rename-')));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('validates names', () => {
    expect(() => validateProjectName('')).toThrow();
    expect(() => validateProjectName('a/b')).toThrow();
    expect(() => validateProjectName('CON', 'win32')).toThrow();
    expect(validateProjectName('New Name')).toBe('New Name');
  });

  it('renames display name only without touching the disk', () => {
    const { deps, state } = makeDeps(root);
    const preview = previewRename(deps, 'p1', 'New', false);
    expect(preview.refs).toHaveLength(0);
    executeRename(deps, preview);
    expect(state.name).toBe('New');
    expect(fs.existsSync(state.workdir)).toBe(true);
  });

  it('renames folder + updates every reference, journaled', () => {
    const { deps, state } = makeDeps(root);
    const preview = previewRename(deps, 'p1', 'New', true);
    expect(preview.refs.some((r) => r.kind === 'session.cwd')).toBe(true);
    const out = executeRename(deps, preview);
    expect(out.workdir).toContain('New');
    expect(fs.existsSync(path.join(out.workdir ?? '', 'sub', 'f.txt'))).toBe(true);
    expect(state.sessions[0]?.cwd).toContain('New');
    expect(deps.journal.history()).toHaveLength(1);
  });

  it('refuses when in use or target exists, rolls back on DB failure', () => {
    const busy = makeDeps(root, { isInUse: () => 'active session s1' });
    expect(() => executeRename(busy.deps, previewRename(busy.deps, 'p1', 'New', true))).toThrow(/in use/i);

    const { deps } = makeDeps(root);
    fs.mkdirSync(path.join(root, 'Taken'));
    expect(() => executeRename(deps, previewRename(deps, 'p1', 'Taken', true))).toThrow(/already exists/i);

    const failing = makeDeps(root, {
      applyDbUpdates: () => {
        throw new Error('db boom');
      },
    });
    const before = failing.state.workdir;
    expect(() => executeRename(failing.deps, previewRename(failing.deps, 'p1', 'Rolled', true))).toThrow(/db boom/);
    expect(fs.existsSync(before)).toBe(true);
    expect(fs.existsSync(path.join(root, 'Rolled'))).toBe(false);
  });

  it('warns on git configs with absolute paths instead of guessing', () => {
    const { deps, state } = makeDeps(root);
    fs.mkdirSync(path.join(state.workdir, '.git'));
    fs.writeFileSync(path.join(state.workdir, '.git', 'config'), `[core]\n worktree = ${state.workdir}\n`);
    const preview = previewRename(deps, 'p1', 'New', true);
    expect(preview.warnings.join(' ')).toContain('.git/config');
  });
});
