/**
 * Branch closure, round five: remaining rename, journal and listing edges.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeRename, previewRename, type RenameDeps } from '../src/main/machine-access/project-rename';
import { FsJournal } from '../src/main/machine-access/fs-journal';
import { GrantStore } from '../src/main/machine-access/grant-store';
import { buildFsTools } from '../src/main/machine-access/fs-tools';
import { ToolRegistry, type ToolContext } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';

describe('rename remaining branches', () => {
  let root: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rn5-')));
    fs.mkdirSync(path.join(root, 'w'), { recursive: true });
    fs.writeFileSync(path.join(root, 'w', 'a.txt'), 'a');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const deps = (over: Partial<RenameDeps> = {}): RenameDeps => ({
    getProject: () => ({ id: 'p', name: 'N', workdir: path.join(root, 'w') }),
    listSessions: () => [],
    listFiles: () => [],
    transaction: (fn) => fn(),
    applyDbUpdates: () => undefined,
    isInUse: () => null,
    journal: new FsJournal(null),
    ...over,
  });

  it('rejects an invalid custom directory name', () => {
    const d = deps();
    expect(() => previewRename(d, 'p', 'Display', true, 'bad/name')).toThrow(/invalid/i);
  });

  it('emits no git warning when .git/config is absent', () => {
    const preview = previewRename(deps(), 'p', 'New', true);
    expect(preview.warnings).toEqual([]);
    // The skills note is always present when the folder moves.
    expect(preview.refs.some((r) => r.kind === 'note')).toBe(true);
  });

  it('rejects an invalid display name before touching anything', () => {
    const d = deps();
    expect(() => executeRename(d, { projectId: 'p', newName: '', renameDir: false, refs: [], warnings: [] })).toThrow(
      /required/i
    );
  });

  it('reports a vanished project during execution', () => {
    const d = deps({ getProject: () => undefined });
    expect(() => executeRename(d, { projectId: 'p', newName: 'X', renameDir: false, refs: [], warnings: [] })).toThrow(
      /not found/i
    );
  });

  it('rebases a session cwd inside the folder', () => {
    const d = deps({
      listSessions: () => [{ id: 's1', cwd: path.join(root, 'w', 'nested') }],
    });
    const preview = previewRename(d, 'p', 'New', true);
    const sessionRef = preview.refs.find((r) => r.kind === 'session.cwd');
    expect(sessionRef?.after).toContain('New');
    expect(sessionRef?.after).toContain('nested');
  });
});

describe('journal and tool remaining branches', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-jb-')));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('checksumFile returns undefined for a missing file', () => {
    const journal = new FsJournal(null);
    journal.record({ batchId: 'b', type: 'trash', source: path.join(workspace, 'gone') });
    expect(journal.history()[0]?.checksumBefore).toBeUndefined();
  });

  it('undo of a write without a backup reports it instead of destroying', () => {
    const journal = new FsJournal(null);
    const f = path.join(workspace, 'w.txt');
    fs.writeFileSync(f, 'current');
    journal.record({ batchId: 'b', type: 'write', source: f });
    const result = journal.undoBatch('b');
    expect(result.refused[0]?.reason).toMatch(/backup missing/i);
    expect(fs.readFileSync(f, 'utf-8')).toBe('current');
  });

  it('an organize entry explains that undo is member-by-member', () => {
    const journal = new FsJournal(null);
    journal.record({
      batchId: 'o',
      type: 'organize',
      source: path.join(workspace, 'x'),
      destination: path.join(workspace, 'y'),
    });
    expect(journal.undoBatch('o').refused[0]?.reason).toMatch(/member-by-member/i);
  });

  it('fs_search tolerates an unreadable subdirectory', async () => {
    const grants = new GrantStore(null);
    grants.addGrant({ path: workspace, access: 'read', scope: 'session' }, 'user');
    const registry = new ToolRegistry();
    for (const tool of buildFsTools({
      workspaceRoot: workspace,
      grants,
      journal: new FsJournal(null),
      backupRoot: path.join(workspace, '.b'),
    })) {
      registry.register(tool);
    }
    // A symlink loop makes readdir fail; the walk must not throw.
    const loopA = path.join(workspace, 'loopA');
    if (process.platform !== 'win32') {
      try {
        fs.symlinkSync(loopA, loopA);
      } catch {
        /* symlink creation can fail; the rest of the test still holds */
      }
    }
    const r = await invokeTool(
      registry,
      'fs_search',
      { dir: workspace, pattern: 'nothing-matches' },
      { sessionId: 's', cwd: workspace } as ToolContext,
      { decidePermission: () => ({ allowed: true }) }
    );
    expect(r.isError).toBeFalsy();
  });
});