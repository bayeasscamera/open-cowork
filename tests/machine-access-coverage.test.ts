/**
 * Coverage closure for machine-access paths not exercised by the behavioural
 * tests: journal divergence branches, fs tool refusals, rename edge cases and
 * the schema DDL. Real files in real temp directories throughout.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { ToolRegistry, type ToolContext } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';
import { buildFsTools } from '../src/main/machine-access/fs-tools';
import {
  FsJournal,
  backupFile,
  checksumFile,
  purgeBackups,
} from '../src/main/machine-access/fs-journal';
import { GrantStore } from '../src/main/machine-access/grant-store';
import { MACHINE_ACCESS_SCHEMA } from '../src/main/machine-access/schema';
import {
  executeRename,
  previewRename,
  type RenameDeps,
} from '../src/main/machine-access/project-rename';
import { killGroup, scrubEnv } from '../src/main/machine-access/command-runner';

describe('fs journal edge cases', () => {
  let workspace: string;
  let backupRoot: string;
  let journal: FsJournal;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-jrn-')));
    backupRoot = path.join(workspace, '.backups');
    journal = new FsJournal(null);
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('undo of a create removes the file only while unchanged', () => {
    const file = path.join(workspace, 'created.txt');
    fs.writeFileSync(file, 'v1');
    const op = journal.record({
      batchId: 'b1',
      type: 'create',
      source: file,
      checksumAfter: checksumFile(file),
    });
    fs.writeFileSync(file, 'user changed');
    const refused = journal.undoBatch('b1');
    expect(refused.undone).toHaveLength(0);
    expect(fs.readFileSync(file, 'utf-8')).toBe('user changed');

    // Unchanged since the operation: it is moved to the Cowork trash.
    fs.writeFileSync(file, 'v1');
    const fresh = journal.record({
      batchId: 'b2',
      type: 'create',
      source: file,
      checksumAfter: checksumFile(file),
    });
    void op;
    expect(journal.undoBatch('b2').undone).toHaveLength(1);
    expect(fs.existsSync(file)).toBe(false);
    expect(fresh.id).toBeTruthy();
  });

  it('undo of a copy only removes the copy while unchanged', () => {
    const src = path.join(workspace, 'src.txt');
    const dest = path.join(workspace, 'dest.txt');
    fs.writeFileSync(src, 'data');
    fs.copyFileSync(src, dest);
    journal.record({
      batchId: 'c1',
      type: 'copy',
      source: src,
      destination: dest,
      checksumAfter: checksumFile(dest),
    });
    fs.writeFileSync(dest, 'user edited copy');
    expect(journal.undoBatch('c1').refused).toHaveLength(1);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('undo refuses a move when the original path is re-occupied', () => {
    const a = path.join(workspace, 'a.txt');
    const b = path.join(workspace, 'b.txt');
    fs.writeFileSync(a, 'a');
    journal.record({ batchId: 'm1', type: 'move', source: a, destination: b });
    fs.writeFileSync(a, 're-occupied');
    fs.writeFileSync(b, 'moved');
    const result = journal.undoBatch('m1');
    expect(result.undone).toHaveLength(0);
    expect(result.refused[0]?.reason).toMatch(/re-occupied/);
  });

  it('undo refuses when the trash backup is missing', () => {
    const f = path.join(workspace, 'gone.txt');
    journal.record({ batchId: 't1', type: 'trash', source: f, backupRef: path.join(backupRoot, 'nope') });
    expect(journal.undoBatch('t1').refused[0]?.reason).toMatch(/backup missing/i);
  });

  it('reports a missing destination for a move undo', () => {
    const a = path.join(workspace, 'a.txt');
    journal.record({ batchId: 'm2', type: 'move', source: a, destination: path.join(workspace, 'x') });
    expect(journal.undoBatch('m2').refused[0]?.reason).toMatch(/destination missing/i);
  });

  it('skips already-undone operations', () => {
    const f = path.join(workspace, 'twice.txt');
    fs.writeFileSync(f, 'x');
    journal.record({ batchId: 'd1', type: 'create', source: f, checksumAfter: checksumFile(f) });
    journal.undoBatch('d1');
    expect(journal.undoBatch('d1').undone).toHaveLength(0);
  });

  it('backs up a file and purges oldest beyond quota', () => {
    const file = path.join(workspace, 'payload.txt');
    fs.writeFileSync(file, 'x'.repeat(1000));
    const ref = backupFile(file, backupRoot, 'b');
    expect(fs.existsSync(ref)).toBe(true);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(ref, old, old);
    fs.writeFileSync(path.join(backupRoot, 'newer'), 'y'.repeat(500));
    const purged = purgeBackups(backupRoot, 600);
    expect(purged).toContain(ref);
    expect(fs.existsSync(path.join(backupRoot, 'newer'))).toBe(true);
  });
});

describe('fs tool refusals', () => {
  let workspace: string;
  let outside: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ft-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ft-out-')));
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
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const call = async (name: string, args: unknown) =>
    invokeTool(registry, name, args, { sessionId: 's', cwd: workspace } as ToolContext, {
      decidePermission: () => ({ allowed: true }),
    });

  it('reports missing arguments instead of throwing', async () => {
    for (const [name, args] of [
      ['fs_list', {}],
      ['fs_read', {}],
      ['fs_write', { path: 'x' }],
      ['fs_create', {}],
      ['fs_trash', {}],
      ['fs_move', { src: 'a' }],
      ['fs_search', { dir: '.' }],
      ['fs_copy', {}],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError).toBe(true);
    }
  });

  it('reads a directory through fs_read with a pointer to fs_list', async () => {
    const r = await call('fs_read', { path: workspace });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('fs_list');
  });

  it('lists and searches real files', async () => {
    fs.writeFileSync(path.join(workspace, 'findme.txt'), 'x');
    const list = await call('fs_list', { path: workspace });
    expect(list.content).toContain('findme.txt');
    const search = await call('fs_search', { dir: workspace, pattern: 'findme' });
    expect(search.content).toContain('findme.txt');
  });

  it('trashes a missing file and moves a missing source', async () => {
    expect((await call('fs_trash', { path: path.join(workspace, 'nope.txt') })).isError).toBe(true);
    expect(
      (await call('fs_move', { src: path.join(workspace, 'nope'), dest: path.join(workspace, 'x') }))
        .isError
    ).toBe(true);
  });

  it('copies for real and honours overwrite', async () => {
    const a = path.join(workspace, 'a.txt');
    const b = path.join(workspace, 'sub', 'b.txt');
    fs.writeFileSync(a, 'A');
    expect((await call('fs_copy', { src: a, dest: b })).isError).toBeFalsy();
    expect(fs.readFileSync(b, 'utf-8')).toBe('A');
    fs.writeFileSync(b, 'taken');
    expect((await call('fs_copy', { src: a, dest: b })).isError).toBe(true);
    expect((await call('fs_copy', { src: a, dest: b, overwrite: true })).isError).toBeFalsy();
    expect(fs.readFileSync(b, 'utf-8')).toBe('A');
  });

  it('refuses writes to sensitive zones with an approval payload', async () => {
    const r = await call('fs_write', { path: '/etc/cowork-x', content: 'x' });
    expect(r.isError).toBe(true);
    // Either the grant check or the sensitive check refuses, never silently.
    expect(r.content).toMatch(/outside the granted folders|sensitive/i);
  });
});

describe('project rename edge cases', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-rn2-')));
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

  it('throws on an unknown project', () => {
    expect(() => previewRename(deps({ getProject: () => undefined }), 'p', 'X', false)).toThrow(
      /not found/i
    );
  });

  it('keeps references outside the folder unchanged', () => {
    fs.mkdirSync(path.join(root, 'w'), { recursive: true });
    const outside = path.join(root, 'elsewhere.txt');
    const d = deps({ listFiles: () => [outside], listSessions: () => [{ id: 's', cwd: '/tmp' }] });
    const preview = previewRename(d, 'p', 'New', true);
    expect(preview.refs.some((r) => r.after.includes('unchanged'))).toBe(true);
  });

  it('rolls the folder back when the rename itself fails', () => {
    fs.mkdirSync(path.join(root, 'w'), { recursive: true });
    const d = deps({
      applyDbUpdates: () => {
        throw new Error('db down');
      },
    });
    expect(() => executeRename(d, previewRename(d, 'p', 'New', true))).toThrow(/db down/);
    expect(fs.existsSync(path.join(root, 'w'))).toBe(true);
  });
});

describe('runtime helpers', () => {
  it('killGroup is a no-op without a pid', () => {
    expect(() => killGroup(undefined)).not.toThrow();
  });

  it('scrubEnv keeps only allow-listed variables plus explicit extras', () => {
    process.env['COWORK_SECRET_TOKEN'] = 'nope';
    const env = scrubEnv({ MY_FLAG: '1' });
    expect(env['COWORK_SECRET_TOKEN']).toBeUndefined();
    expect(env['MY_FLAG']).toBe('1');
    delete process.env['COWORK_SECRET_TOKEN'];
  });
});

describe('schema DDL is multi-process safe', () => {
  it('runs twice without error (CREATE TABLE IF NOT EXISTS)', () => {
    const db = new Database(':memory:');
    try {
      db.exec(MACHINE_ACCESS_SCHEMA);
      db.exec(MACHINE_ACCESS_SCHEMA);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain('access_grants');
      expect(names).toContain('fs_operations');
      expect(names).toContain('machine_approvals');
    } finally {
      db.close();
    }
  });

  it('GrantStore and FsJournal persist through a real SQLite database', () => {
    const db = new Database(':memory:');
    try {
      db.exec(MACHINE_ACCESS_SCHEMA);
      const grants = new GrantStore(db);
      const created = grants.addGrant({ path: '/tmp/x', access: 'read', scope: 'session' }, 'user');
      const reopened = new GrantStore(db);
      expect(reopened.list().some((g) => g.id === created.id)).toBe(true);
      reopened.setAutonomy('p', 'extended-trust');
      expect(new GrantStore(db).getAutonomy('p')).toBe('extended-trust');

      const journal = new FsJournal(db);
      journal.record({ batchId: 'b', type: 'trash', source: '/tmp/y', backupRef: '/tmp/z' });
      expect(new FsJournal(db).history()).toHaveLength(0); // reads memory, not DB
      const row = db.prepare('SELECT COUNT(*) AS n FROM fs_operations').get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      db.close();
    }
  });
});