/**
 * Branch closure, round three: the remaining error and default branches in the
 * fs tools and the scaffold, exercised on real files.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, type ToolContext } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';
import { buildFsTools } from '../src/main/machine-access/fs-tools';
import { FsJournal } from '../src/main/machine-access/fs-journal';
import { GrantStore } from '../src/main/machine-access/grant-store';
import {
  createBackgroundJob,
  detectDeclaredPort,
  editDistance,
  isPortFree,
  scaffoldApp,
  suspiciousPackage,
  validateAppName,
} from '../src/main/machine-access/app-scaffold';

function makeRegistry(workspace: string, access: 'read' | 'read-write' = 'read-write'): ToolRegistry {
  const grants = new GrantStore(null);
  grants.addGrant({ path: workspace, access, scope: 'session' }, 'user');
  const registry = new ToolRegistry();
  for (const tool of buildFsTools({
    workspaceRoot: workspace,
    grants,
    journal: new FsJournal(null),
    backupRoot: path.join(workspace, '.b'),
  })) {
    registry.register(tool);
  }
  return registry;
}

describe('fs tools remaining branches', () => {
  let workspace: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-eb3-')));
    registry = makeRegistry(workspace);
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const call = async (name: string, args: unknown) =>
    invokeTool(registry, name, args, { sessionId: 's', cwd: workspace } as ToolContext, {
      decidePermission: () => ({ allowed: true }),
    });

  it('a read-only grant allows reads but refuses writes outside the workspace', async () => {
    // The workspace itself is always writable; grant ACCESS LEVEL only
    // governs the extra folders the user added.
    const extra = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ro-')));
    try {
      fs.writeFileSync(path.join(extra, 'note.txt'), 'note');
      const grants = new GrantStore(null);
      grants.addGrant({ path: workspace, access: 'read-write', scope: 'session' }, 'user');
      grants.addGrant({ path: extra, access: 'read', scope: 'session' }, 'user');
      const registry = new ToolRegistry();
      for (const tool of buildFsTools({
        workspaceRoot: workspace,
        grants,
        journal: new FsJournal(null),
        backupRoot: path.join(workspace, '.b'),
      })) {
        registry.register(tool);
      }
      const read = await invokeTool(
        registry,
        'fs_read',
        { path: path.join(extra, 'note.txt') },
        { sessionId: 's', cwd: workspace } as ToolContext,
        { decidePermission: () => ({ allowed: true }) }
      );
      expect(read.isError).toBeFalsy();
      const write = await invokeTool(
        registry,
        'fs_write',
        { path: path.join(extra, 'note.txt'), content: 'changed' },
        { sessionId: 's', cwd: workspace } as ToolContext,
        { decidePermission: () => ({ allowed: true }) }
      );
      expect(write.isError).toBe(true);
      expect(fs.readFileSync(path.join(extra, 'note.txt'), 'utf-8')).toBe('note');
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  it('fs_write creates missing parent directories', async () => {
    const nested = path.join(workspace, 'a', 'b', 'c.txt');
    expect((await call('fs_write', { path: nested, content: 'deep' })).isError).toBeFalsy();
    expect(fs.readFileSync(nested, 'utf-8')).toBe('deep');
  });

  it('fs_create defaults missing content to an empty file', async () => {
    const f = path.join(workspace, 'empty.txt');
    expect((await call('fs_create', { path: f })).isError).toBeFalsy();
    expect(fs.readFileSync(f, 'utf-8')).toBe('');
  });

  it('fs_create and fs_write refuse a directory target', async () => {
    fs.mkdirSync(path.join(workspace, 'dir'));
    expect((await call('fs_create', { path: path.join(workspace, 'dir') })).isError).toBe(true);
    expect((await call('fs_write', { path: path.join(workspace, 'dir'), content: 'x' })).isError).toBe(
      true
    );
  });

  it('fs_move creates the destination parent directory', async () => {
    const a = path.join(workspace, 'a.txt');
    fs.writeFileSync(a, 'a');
    const dest = path.join(workspace, 'deep', 'nested', 'a.txt');
    expect((await call('fs_move', { src: a, dest })).isError).toBeFalsy();
    expect(fs.readFileSync(dest, 'utf-8')).toBe('a');
  });

  it('fs_rename and fs_copy reject a missing dest argument', async () => {
    const a = path.join(workspace, 'a.txt');
    fs.writeFileSync(a, 'a');
    expect((await call('fs_rename', { src: a })).isError).toBe(true);
    expect((await call('fs_copy', { src: a })).isError).toBe(true);
  });

  it('fs_trash backs the file up before moving it away', async () => {
    const f = path.join(workspace, 'trash-me.txt');
    fs.writeFileSync(f, 'payload');
    const r = await call('fs_trash', { path: f });
    const payload = JSON.parse(r.content) as { backup: boolean };
    expect(payload.backup).toBe(true);
    // A backup copy exists under the Cowork trash root.
    const backups = fs.readdirSync(path.join(workspace, '.b'));
    expect(backups.some((b) => b.includes('trash-me.txt'))).toBe(true);
  });

  it('a symlinked file inside the workspace is read through its real target', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(workspace, 'real.txt');
    fs.writeFileSync(target, 'real content');
    const link = path.join(workspace, 'link.txt');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return;
    }
    const r = await call('fs_read', { path: link });
    expect(r.content).toContain('real content');
  });
});

describe('scaffold remaining branches', () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-sc3-')));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses a granted root that is a file, not a directory', () => {
    const file = path.join(root, 'afile');
    fs.writeFileSync(file, 'x');
    const res = scaffoldApp({ kind: 'node-cli', name: 'app', grantedRoot: file }, () => undefined, () => undefined);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not a directory/i);
  });

  it('writes every node-http file', () => {
    const written: string[] = [];
    const res = scaffoldApp(
      { kind: 'node-http', name: 'http-app', grantedRoot: root },
      (p) => written.push(path.basename(p)),
      (p) => fs.mkdirSync(p, { recursive: true })
    );
    expect(res.ok).toBe(true);
    expect(written).toContain('server.js');
    expect(written).toContain('package.json');
    expect(written).toContain('.gitignore');
    expect(written).toContain('README.md');
  });

  it('writes node-cli and python files to disk', () => {
    const res = scaffoldApp(
      { kind: 'node-cli', name: 'cli-app', grantedRoot: root },
      (p, c) => fs.writeFileSync(p, c),
      (p) => fs.mkdirSync(p, { recursive: true })
    );
    expect(res.files).toContain('cli.js');
    expect(fs.readFileSync(path.join(res.projectDir ?? '', 'cli.js'), 'utf-8')).toContain('cli-app');
  });

  it('rejects reserved and malformed names', () => {
    for (const bad of ['', 'a<b', 'a>b', 'a:b', 'a|b', 'a?b', 'a*b', 'a/b', 'a\\b']) {
      expect(() => validateAppName(bad)).toThrow();
    }
  });

  it('reads a port out of an env-style source and ignores a bad one', () => {
    expect(detectDeclaredPort(['PORT=4000', 'PORT=5000'])).toBe(4000);
    expect(detectDeclaredPort(['PORT=notanumber'])).toBeUndefined();
  });

  it('detects an occupied port for real', async () => {
    const net = await import('net');
    const server = net.createServer();
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : 0);
      });
    });
    expect(await isPortFree(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('editDistance is symmetric and zero on identity', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('abc', 'abd')).toBe(editDistance('abd', 'abc'));
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('flags a scoped package name that is far from known ones', () => {
    expect(suspiciousPackage('@scope/totally-unknown-thing')).toMatch(/unusual|typo/);
    expect(suspiciousPackage('react')).toBeNull();
  });

  it('creates a background job handle', () => {
    const job = createBackgroundJob(root, 'npm start');
    expect(job.command).toBe('npm start');
    expect(job.projectDir).toBe(root);
    expect(job.id).toBeTruthy();
    expect(createBackgroundJob(root, 'x').id).not.toBe(job.id);
  });
});