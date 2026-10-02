import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, type ToolContext } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';
import { buildFsTools, type FsToolsDeps } from '../src/main/machine-access/fs-tools';
import { FsJournal } from '../src/main/machine-access/fs-journal';
import { GrantStore } from '../src/main/machine-access/grant-store';

async function call(registry: ToolRegistry, name: string, args: unknown, cwd: string) {
  const ctx: ToolContext = { sessionId: 's', cwd };
  return invokeTool(registry, name, args, ctx, {
    decidePermission: () => ({ allowed: true }),
  });
}

describe('fs tools (real files in tmp)', () => {
  let workspace: string;
  let backupRoot: string;
  let registry: ToolRegistry;
  let journal: FsJournal;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-fs-')));
    backupRoot = path.join(workspace, '.cowork-backups');
    const grants = new GrantStore(null);
    grants.addGrant({ path: workspace, access: 'read-write', scope: 'session' }, 'user');
    journal = new FsJournal(null);
    const deps: FsToolsDeps = { workspaceRoot: workspace, grants, journal, backupRoot };
    registry = new ToolRegistry();
    for (const tool of buildFsTools(deps)) registry.register(tool);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('writes with backup before overwrite, and refuses outside grants', async () => {
    const file = path.join(workspace, 'a.txt');
    let r = await call(registry, 'fs_write', { path: file, content: 'v1' }, workspace);
    expect(r.isError).toBeFalsy();
    r = await call(registry, 'fs_write', { path: file, content: 'v2' }, workspace);
    expect(r.content).toContain('backup');
    expect(fs.readFileSync(file, 'utf-8')).toBe('v2');
    r = await call(registry, 'fs_write', { path: '/etc/cowork-test', content: 'x' }, workspace);
    expect(r.isError).toBe(true);
  });

  it('create refuses existing files; move refuses overwrite; trash is restorable via undo', async () => {
    const file = path.join(workspace, 'b.txt');
    await call(registry, 'fs_create', { path: file, content: 'hi' }, workspace);
    const dup = await call(registry, 'fs_create', { path: file, content: 'hi' }, workspace);
    expect(dup.isError).toBe(true);

    const dest = path.join(workspace, 'c.txt');
    fs.writeFileSync(dest, 'taken');
    const blocked = await call(registry, 'fs_move', { src: file, dest }, workspace);
    expect(blocked.isError).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    const trash = await call(registry, 'fs_trash', { path: file }, workspace);
    expect(trash.isError).toBeFalsy();
    expect(fs.existsSync(file)).toBe(false);
    const { batchId } = JSON.parse(trash.content) as { batchId: string };
    const undo = journal.undoBatch(batchId);
    expect(undo.refused).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe('hi');
  });

  it('masks secret files and flags binary reads', async () => {
    const env = path.join(workspace, '.env');
    fs.writeFileSync(env, 'KEY=abc');
    const masked = await call(registry, 'fs_read', { path: env }, workspace);
    expect(masked.isError).toBe(true);
    expect(masked.content).toContain('approval');
    const bin = path.join(workspace, 'img.bin');
    fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3]));
    const bread = await call(registry, 'fs_read', { path: bin }, workspace);
    expect(bread.isError).toBe(true);
    expect(bread.content).toContain('Binary');
  });

  it('undo refuses cleanly when state diverged', async () => {
    const file = path.join(workspace, 'd.txt');
    await call(registry, 'fs_write', { path: file, content: 'v1' }, workspace);
    await call(registry, 'fs_write', { path: file, content: 'v2' }, workspace);
    const lastBatch = journal.history().at(-1)?.batchId ?? '';
    fs.writeFileSync(file, 'user-edited');
    const undo = journal.undoBatch(lastBatch);
    expect(undo.undone).toHaveLength(0);
    expect(undo.refused).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf-8')).toBe('user-edited');
  });

  it('every mutation is journaled with no secrets inside', async () => {
    const file = path.join(workspace, 'e.txt');
    await call(registry, 'fs_write', { path: file, content: 'super-secret-value' }, workspace);
    const entry = journal.history().at(-1);
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain('super-secret-value');
  });
});
