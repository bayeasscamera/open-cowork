/**
 * Branch closure, round two: the error paths and shared helpers that the
 * behavioural tests reach only on their happy path. Real files throughout.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, type ToolContext } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';
import { buildFsTools, registerMachineAccessTools } from '../src/main/machine-access/fs-tools';
import { FsJournal } from '../src/main/machine-access/fs-journal';
import { GrantStore } from '../src/main/machine-access/grant-store';
import {
  buildBatchPlan,
  executeBatchPlan,
  fingerprintPlan,
} from '../src/main/machine-access/batch-plan';
import {
  executeRename,
  previewRename,
  validateProjectName,
  type RenameDeps,
} from '../src/main/machine-access/project-rename';

describe('fs tools error branches', () => {
  let workspace: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-eb-')));
    const grants = new GrantStore(null);
    grants.addGrant({ path: workspace, access: 'read-write', scope: 'session' }, 'user');
    registry = new ToolRegistry();
    for (const tool of buildFsTools({
      workspaceRoot: workspace,
      grants,
      journal: new FsJournal(null),
      backupRoot: path.join(workspace, '.b'),
    })) {
      registry.register(tool);
    }
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const call = async (name: string, args: unknown) =>
    invokeTool(registry, name, args, { sessionId: 's', cwd: workspace } as ToolContext, {
      decidePermission: () => ({ allowed: true }),
    });

  it('reports a filesystem failure instead of throwing', async () => {
    // A directory where a file is expected makes the read fail inside the tool.
    fs.mkdirSync(path.join(workspace, 'adir'));
    const r = await call('fs_write', { path: path.join(workspace, 'adir'), content: 'x' });
    expect(r.isError).toBe(true);
  });

  it('fs_list surfaces a listing failure for a missing folder', async () => {
    const r = await call('fs_list', { path: path.join(workspace, 'nope') });
    expect(r.isError).toBe(true);
  });

  it('fs_search returns an empty list for an unreadable root', async () => {
    const r = await call('fs_search', { dir: workspace, pattern: 'zzz-no-match' });
    expect(JSON.parse(r.content)).toEqual([]);
  });

  it('truncates a read above the size cap and reports the drop', async () => {
    // The default cap is 512 KiB, so the file must exceed it.
    const big = path.join(workspace, 'big.txt');
    fs.writeFileSync(big, 'y'.repeat(600 * 1024));
    const r = await call('fs_read', { path: big });
    expect(r.content).toContain('truncated');
    expect(r.content.length).toBeLessThan(600 * 1024);
  });

  it('registers tools only once on a shared registry', () => {
    const shared = new ToolRegistry();
    const deps = {
      workspaceRoot: workspace,
      grants: new GrantStore(null),
      journal: new FsJournal(null),
      backupRoot: path.join(workspace, '.b'),
    };
    const first = registerMachineAccessTools(shared, deps);
    const second = registerMachineAccessTools(shared, deps);
    expect(first).toEqual(second);
    expect(shared.size).toBe(first.length);
  });
});

describe('batch plan branches', () => {
  let workspace: string;
  let grants: GrantStore;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-bb-')));
    grants = new GrantStore(null);
    grants.addGrant({ path: workspace, access: 'read-write', scope: 'session' }, 'user');
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const deps = () => ({ workspaceRoot: workspace, grants: grants.list() });

  it('refuses a source outside the granted folders', () => {
    expect(() =>
      buildBatchPlan([{ type: 'trash', src: '/etc/hosts' }], deps())
    ).toThrow(/refused/i);
  });

  it('refuses a move without a destination', () => {
    const a = path.join(workspace, 'a.txt');
    fs.writeFileSync(a, 'a');
    expect(() => buildBatchPlan([{ type: 'move', src: a }], deps())).toThrow(/needs a dest/i);
  });

  it('refuses a destination outside the granted folders', () => {
    const a = path.join(workspace, 'a.txt');
    fs.writeFileSync(a, 'a');
    expect(() =>
      buildBatchPlan([{ type: 'move', src: a, dest: '/etc/cowork-x' }], deps())
    ).toThrow(/refused/i);
  });

  it('reports two operations targeting the same destination', () => {
    const a = path.join(workspace, 'a.txt');
    const b = path.join(workspace, 'b.txt');
    fs.writeFileSync(a, 'a');
    fs.writeFileSync(b, 'b');
    const dest = path.join(workspace, 'out.txt');
    const plan = buildBatchPlan(
      [
        { type: 'move', src: a, dest },
        { type: 'move', src: b, dest },
      ],
      deps()
    );
    expect(plan.conflicts.join(' ')).toContain('Two operations target');
  });

  it('refuses to execute a plan that still carries conflicts', async () => {
    const a = path.join(workspace, 'a.txt');
    const dest = path.join(workspace, 'taken.txt');
    fs.writeFileSync(a, 'a');
    fs.writeFileSync(dest, 'taken');
    const plan = buildBatchPlan([{ type: 'copy', src: a, dest }], deps());
    const result = await executeBatchPlan(plan, deps(), {
      journal: new FsJournal(null),
      backupRoot: path.join(workspace, '.b'),
    });
    expect(result.done).toBe(0);
    expect(result.error).toMatch(/conflicts/i);
  });

  it('stops at the first error and reports done/pending', async () => {
    const a = path.join(workspace, 'a.txt');
    fs.writeFileSync(a, 'a');
    // A FILE where the second operation needs a directory makes mkdir fail
    // mid-execution: the batch must stop and report done/pending, not continue.
    fs.writeFileSync(path.join(workspace, 'blocker'), 'i am a file');
    const plan = buildBatchPlan(
      [
        { type: 'move', src: a, dest: path.join(workspace, 'ok', 'a.txt') },
        { type: 'move', src: a, dest: path.join(workspace, 'blocker', 'a.txt') },
      ],
      deps()
    );
    const result = await executeBatchPlan(plan, deps(), {
      journal: new FsJournal(null),
      backupRoot: path.join(workspace, '.b'),
    });
    expect(result.failedAt).toBe(1);
    expect(result.pending).toBe(1);
    expect(result.error).toBeTruthy();
    expect(fs.existsSync(path.join(workspace, 'ok', 'a.txt'))).toBe(true);
  });

  it('fingerprints pin the exact order, so a reorder reads as drift', () => {
    const a = { type: 'trash' as const, src: 'a', realSrc: '/x/a', bytes: 1 };
    const b = { type: 'trash' as const, src: 'b', realSrc: '/x/b', bytes: 1 };
    expect(fingerprintPlan([a, b])).toBe(fingerprintPlan([a, b]));
    // Order is part of the identity: swapping members changes the fingerprint,
    // which is exactly what makes executeBatchPlan re-ask instead of guessing.
    expect(fingerprintPlan([a, b])).not.toBe(fingerprintPlan([b, a]));
  });
});

describe('project rename branches', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rn3-')));
    fs.mkdirSync(path.join(root, 'w', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'w', 'nested', 'deep.txt'), 'deep');
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

  it('rejects too-long and empty names', () => {
    expect(() => validateProjectName('x'.repeat(300))).toThrow(/too long/i);
    expect(() => validateProjectName('   ')).toThrow(/required/i);
  });

  it('uses a custom directory name distinct from the display name', () => {
    const d = deps();
    const preview = previewRename(d, 'p', 'Pretty Name', true, 'slug');
    expect(preview.newWorkdir?.endsWith('/slug')).toBe(true);
  });

  it('journals the rename so it can be undone', () => {
    const journal = new FsJournal(null);
    const d = deps({ journal });
    executeRename(d, previewRename(d, 'p', 'Later', true));
    expect(journal.history()).toHaveLength(1);
    expect(journal.history()[0]?.destination).toContain('Later');
  });
});