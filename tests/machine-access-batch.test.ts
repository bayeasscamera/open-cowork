import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildBatchPlan, executeBatchPlan } from '../src/main/machine-access/batch-plan';
import { FsJournal } from '../src/main/machine-access/fs-journal';
import { GrantStore } from '../src/main/machine-access/grant-store';

describe('batch plan (real files in tmp)', () => {
  let workspace: string;
  let backupRoot: string;
  let grants: GrantStore;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-batch-')));
    backupRoot = path.join(workspace, '.backups');
    grants = new GrantStore(null);
    grants.addGrant({ path: workspace, access: 'read-write', scope: 'session' }, 'user');
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const deps = () => ({ workspaceRoot: workspace, grants: grants.list() });

  it('executes exactly the preview; stops at first error with clear state', async () => {
    const a = path.join(workspace, 'a.txt');
    const b = path.join(workspace, 'b.txt');
    fs.writeFileSync(a, 'a');
    fs.writeFileSync(b, 'b');
    const plan = buildBatchPlan(
      [
        { type: 'move', src: a, dest: path.join(workspace, 'out', 'a.txt') },
        { type: 'trash', src: b },
      ],
      deps()
    );
    expect(plan.conflicts).toHaveLength(0);
    const journal = new FsJournal(null);
    const result = await executeBatchPlan(plan, deps(), { journal, backupRoot });
    expect(result.done).toBe(2);
    expect(result.pending).toBe(0);
    expect(fs.existsSync(path.join(workspace, 'out', 'a.txt'))).toBe(true);
    expect(fs.existsSync(b)).toBe(false);
    // Undo the whole batch restores both.
    const undo = journal.undoBatch(result.batchId);
    expect(undo.refused).toHaveLength(0);
    expect(fs.existsSync(a)).toBe(true);
    expect(fs.existsSync(b)).toBe(true);
  });

  it('reports conflicts instead of overwriting, and enforces the cap', () => {
    const a = path.join(workspace, 'a.txt');
    const taken = path.join(workspace, 'taken.txt');
    fs.writeFileSync(a, 'a');
    fs.writeFileSync(taken, 'x');
    const plan = buildBatchPlan([{ type: 'move', src: a, dest: taken }], deps());
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(() => buildBatchPlan([{ type: 'move', src: a, dest: taken }], { ...deps(), maxOps: 0 })).toThrow(
      /exceeds the cap/i
    );
  });

  it('refuses git roots without explicit mention', () => {
    fs.mkdirSync(path.join(workspace, '.git'));
    const a = path.join(workspace, 'a.txt');
    fs.writeFileSync(a, 'a');
    expect(() => buildBatchPlan([{ type: 'trash', src: a }], deps())).toThrow(/git roots/i);
    const plan = buildBatchPlan([{ type: 'trash', src: a }], { ...deps(), allowGitRoots: true });
    expect(plan.gitRoots.length).toBeGreaterThan(0);
  });

  it('aborts when the plan drifted since preview', async () => {
    const a = path.join(workspace, 'a.txt');
    fs.writeFileSync(a, 'a');
    const plan = buildBatchPlan([{ type: 'move', src: a, dest: path.join(workspace, 'z', 'a.txt') }], deps());
    fs.unlinkSync(a);
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'different');
    // Same realSrc path but content changed is fine for moves; simulate drift
    // by swapping the fingerprint.
    const drifted = { ...plan, fingerprint: 'deadbeef' };
    const result = await executeBatchPlan(drifted, deps(), { journal: new FsJournal(null), backupRoot });
    expect(result.done).toBe(0);
    expect(result.error).toMatch(/drifted/i);
  });
});
