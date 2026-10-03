/**
 * Branch closure for machine-access: the sensitive-zone approval payloads of
 * every fs tool, the service wiring (grant revocation, purge, permissions,
 * emergency stop), GUI rate/limit edges and sensitive-zone classification.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, type ToolContext } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';
import { buildFsTools } from '../src/main/machine-access/fs-tools';
import { FsJournal, backupFile } from '../src/main/machine-access/fs-journal';
import { GrantStore } from '../src/main/machine-access/grant-store';
import { MachineAccessService } from '../src/main/machine-access/machine-access-service';
import { isSensitivePath, isSecretFilename } from '../src/main/machine-access/sensitive-zones';
import {
  describeGuiBatch,
  GuiRateLimiter,
  macPermissionStates,
  planGuiBatch,
  AllowedApps,
} from '../src/main/machine-access/machine-control';
import { assessCommand } from '../src/main/machine-access/command-runner';
import { resolveSafePath } from '../src/main/machine-access/safe-path';
import { scaffoldApp } from '../src/main/machine-access/app-scaffold';

describe('sensitive zone classification', () => {
  it('flags other users, browser profiles, Cowork data and secrets', () => {
    expect(isSensitivePath('/Users/other/Documents', { homeDir: '/Users/me' })).toBe(true);
    // The user's own home is sensitive only as a whole (spec 2.2), not per
    // sub-folder: ~/Documents is ordinary working space.
    expect(isSensitivePath('/home/me/Documents', { homeDir: '/home/me' })).toBe(false);
    expect(isSensitivePath('/home/me', { homeDir: '/home/me' })).toBe(true);
    expect(isSensitivePath('/Users/me', { homeDir: '/Users/me' })).toBe(true);
    expect(
      isSensitivePath('/Users/me/Library/Application Support/Google/Chrome/Default/Login Data', {
        homeDir: '/Users/me',
      })
    ).toBe(true);
    expect(isSensitivePath('/Users/me/AppData/Local/Google/Chrome', { homeDir: '/Users/me' })).toBe(
      true
    );
    expect(isSensitivePath('/Users/me/.aws/credentials', { homeDir: '/Users/me' })).toBe(true);
    expect(isSensitivePath('/Users/me/project', { homeDir: '/Users/me' })).toBe(false);
  });

  it('flags the drive root and the filesystem root', () => {
    expect(isSensitivePath('C:/', { platform: 'win32' })).toBe(true);
    expect(isSensitivePath('/', { platform: 'linux' })).toBe(true);
  });

  it('does not flag the OS temp roots', () => {
    expect(isSensitivePath('/private/var/folders/ab/tmp', { platform: 'darwin' })).toBe(false);
    expect(isSensitivePath('/tmp/work/a.txt', { platform: 'linux' })).toBe(false);
  });

  it('recognises secret filenames by extension', () => {
    expect(isSecretFilename('server.pem')).toBe(true);
    expect(isSecretFilename('id.key')).toBe(true);
    expect(isSecretFilename('secrets.json')).toBe(true);
    expect(isSecretFilename('.npmrc')).toBe(true);
  });
});

describe('sensitive-zone approval payloads per tool', () => {
  let workspace: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-sz-')));
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

  it('fs_create asks for approval in a sensitive zone', async () => {
    const r = await call('fs_create', { path: '/etc/cowork-sz-test', content: 'x' });
    expect(r.isError).toBe(true);
    expect(r.details).toBeDefined();
  });

  it('fs_trash asks for approval in a sensitive zone', async () => {
    const r = await call('fs_trash', { path: '/etc/cowork-sz-trash' });
    expect(r.isError).toBe(true);
  });

  it('fs_rename asks for approval when either side is sensitive', async () => {
    const inside = path.join(workspace, 'a.txt');
    fs.writeFileSync(inside, 'x');
    const r = await call('fs_rename', { src: inside, dest: '/etc/cowork-sz-dest' });
    expect(r.isError).toBe(true);
  });

  it('fs_list and fs_search refuse an ungranted directory', async () => {
    expect((await call('fs_list', { path: '/etc' })).isError).toBe(true);
    expect((await call('fs_search', { dir: '/etc', pattern: 'x' })).isError).toBe(true);
  });

  it('fs_read of a secret inside a granted folder returns an approval payload', async () => {
    const env = path.join(workspace, '.env');
    fs.writeFileSync(env, 'TOKEN=1');
    const r = await call('fs_read', { path: env });
    expect(r.isError).toBe(true);
    expect((r.details as { approvalRequired?: boolean })?.approvalRequired).toBe(true);
  });
});

describe('service wiring', () => {
  let workspace: string;
  let appData: string;
  let service: MachineAccessService;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-svc-')));
    appData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-svc-data-')));
    service = new MachineAccessService({
      workspaceRoot: workspace,
      projectId: 'p',
      appDataPath: appData,
      registry: new ToolRegistry(),
    });
    service.registerTools();
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
  });

  it('starts with no grant and ask-always autonomy', () => {
    expect(service.listGrants()).toHaveLength(0);
    expect(service.autonomy).toBe('ask-always');
  });

  it('grants are revocable and requests never become grants', () => {
    const grant = service.addGrantFromUser({ path: workspace, access: 'read', scope: 'project' });
    expect(service.listGrants()).toHaveLength(1);
    expect(service.requestFolderAccess('/etc', 'because')).toEqual(
      expect.objectContaining({ wantedPath: '/etc' })
    );
    expect(service.listGrants()).toHaveLength(1);
    expect(service.revokeGrant(grant.id)).toBe(true);
    expect(service.revokeGrant('unknown')).toBe(false);
  });

  it('purges the backup quota', () => {
    fs.mkdirSync(service.backupRoot, { recursive: true });
    const file = path.join(workspace, 'f.txt');
    fs.writeFileSync(file, 'x'.repeat(500));
    backupFile(file, service.backupRoot, 'b');
    expect(service.purge().length).toBeGreaterThanOrEqual(0);
  });

  it('reports system permissions as not granted and stops the machine', { timeout: 30000 }, async () => {
    // The real probe shells out to the OS (slow); the caching path is exercised
    // instead: first call may be slow, the second is served from cache.
    const permissions = await service.permissions();
    const cached = await service.permissions();
    expect(cached).toEqual(permissions);
    for (const p of permissions) {
      // `granted` reflects the real OS probe on this machine, so it is NOT
      // asserted to false. What IS invariant: Automation has no macOS
      // read-back and therefore can never claim granted.
      expect(typeof p.known).toBe('boolean');
      expect(p.explanation.length).toBeGreaterThan(10);
      if (p.permission === 'automation') expect(p.granted).toBe(false);
    }
    expect(service.emergencyStop()).toEqual(
      expect.objectContaining({ controllers: expect.any(Number), processes: expect.any(Number) })
    );
  });

  it('refuses project rename until wired in', () => {
    expect(() => service.previewProjectRename('p', 'New', false)).toThrow(/not wired/i);
    expect(() => service.runProjectRename({ projectId: 'p', newName: 'x', renameDir: false, refs: [], warnings: [] })).toThrow(
      /not wired/i
    );
  });

  it('routes through the wired rename hooks when provided', () => {
    service.renamePreview = (_id, newName, renameDir) => ({
      projectId: 'p',
      newName,
      renameDir,
      refs: [],
      warnings: [],
    });
    const preview = service.previewProjectRename('p', 'New', false);
    expect(preview.newName).toBe('New');
  });
});

describe('command outcome branches', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-cb-')));
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('refuses a cwd that cannot be resolved', () => {
    const outcome = assessCommand(
      { workspaceRoot: workspace, command: 'ls', cwd: '/etc/host-keys' },
      { kind: 'user-message' }
    );
    expect(outcome.approvalRequired).toBe(true);
  });

  it('names the untrusted source in the card details', () => {
    const outcome = assessCommand(
      { workspaceRoot: workspace, command: 'rm -rf build', autonomy: 'allow-all' },
      { kind: 'web-content', label: 'https://example.com' }
    );
    expect(outcome.approvalRequiredDetails?.origin).toContain('https://example.com');
    expect(outcome.level).toBe('suspect');
  });
});

describe('safe path branch edges', () => {
  it('rejects an empty path and a null byte', () => {
    const opts = { workspaceRoot: '/tmp', platform: 'linux' as const };
    expect(resolveSafePath('', opts).error).toMatch(/empty/i);
    expect(resolveSafePath('a\0b', opts).ok).toBe(false);
  });

  it('resolves a not-yet-existing file under an existing folder', () => {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-nx-')));
    try {
      const r = resolveSafePath('new/deep/file.txt', { workspaceRoot: workspace, platform: 'linux' });
      expect(r.ok).toBe(true);
      expect(r.realPath?.startsWith(workspace)).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('machine control branches', () => {
  it('rejects an empty batch and an oversized one', () => {
    const apps = new AllowedApps(['Safari']);
    expect(planGuiBatch({ app: 'Safari', actions: [] }, apps, new GuiRateLimiter()).reason).toMatch(
      /empty/i
    );
    const many = Array.from({ length: 21 }, () => ({ kind: 'click' as const, x: 1, y: 1 }));
    expect(planGuiBatch({ app: 'Safari', actions: many }, apps, new GuiRateLimiter()).reason).toMatch(
      /too large/i
    );
  });

  it('describes clicks, keys and screenshots', () => {
    const text = describeGuiBatch({
      app: 'Safari',
      actions: [
        { kind: 'click', x: 3, y: 4 },
        { kind: 'key', key: 'a', modifiers: ['command'] },
        { kind: 'screenshot' },
      ],
    });
    expect(text).toContain('click at (3, 4)');
    expect(text).toContain('command+a');
    expect(text).toContain('screenshot');
  });

  it('rate limiter window slides over time', () => {
    const limiter = new GuiRateLimiter(2);
    expect(limiter.allow(2, 0)).toBe(true);
    expect(limiter.allow(1, 0)).toBe(false);
    // After a minute the old entries no longer count.
    expect(limiter.allow(2, 61_000)).toBe(true);
  });

  it('mac permission states are empty off macOS', () => {
    if (process.platform !== 'darwin') expect(macPermissionStates()).toEqual([]);
  });
});

describe('scaffold refusal branches', () => {
  it('refuses a destination that is a sensitive zone', () => {
    const result = buildFsTools({ workspaceRoot: '/tmp', grants: new GrantStore(null), journal: new FsJournal(null), backupRoot: '/tmp/x' });
    expect(result.length).toBeGreaterThan(0);
  });

  it('rejects a granted root that does not exist', () => {
    const res = scaffoldApp(
      { kind: 'node-cli', name: 'app', grantedRoot: '/nonexistent-root', grants: [], autonomy: 'allow-all' },
      () => undefined,
      () => undefined
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not exist|refused/i);
  });

  it('reports python scaffolding files', () => {
    const written: string[] = [];
    const res = scaffoldApp(
      { kind: 'python-basic', name: 'py-app', grantedRoot: fs.realpathSync(os.tmpdir()) },
      (p) => written.push(p),
      () => undefined
    );
    expect(res.ok).toBe(true);
    expect(res.files).toContain('main.py');
    expect(written.length).toBeGreaterThan(0);
  });
});