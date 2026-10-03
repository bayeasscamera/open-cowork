import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInstallReview, MOD_ACCESS_WARNING, undeclaredCapabilities } from '../src/main/mods/v2/install-plan';
import { clonePlugin, isHttpsUrl, parseMarketplaceIndex, type ProcessSpawner } from '../src/main/mods/v2/git-source';
import { ModApprovalStore, type ApprovalStoreLike, type ApprovedMod } from '../src/main/mods/v2/approval-store';
import { ModInstaller, emptyInstallState, type InstallStoreLike } from '../src/main/mods/v2/installer';
import { ModEventBus } from '../src/main/mods/v2/event-bus';
import { createNodeImporter } from '../src/main/mods/v2/loader';
import type { ModManifest } from '@cowork/mod-api';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-install-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const GOOD_MANIFEST = {
  id: 'demo-mod',
  name: 'Demo mod',
  version: '1.0.0',
  apiVersion: 1,
  entry: 'index.cjs',
  band: 'user',
  failMode: 'open',
  capabilities: { storage: true },
} as const;

async function makeSourceDir(id: string, overrides: Record<string, unknown> = {}, body?: string): Promise<string> {
  const dir = path.join(tmpRoot, `src-${id}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'mod.json'),
    JSON.stringify({ ...GOOD_MANIFEST, id, name: id, ...overrides }, null, 2)
  );
  await fs.writeFile(
    path.join(dir, 'index.cjs'),
    body ?? `"use strict";
exports.default = { id: ${JSON.stringify(id)} };
`
  );
  return dir;
}

describe('install review', () => {
  it('shows the code, the hash and the access warning', async () => {
    const dir = await makeSourceDir('reviewable');
    const result = await buildInstallReview(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.review.warning).toBe(MOD_ACCESS_WARNING);
    expect(result.review.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const entry = result.review.files.find((file) => file.path === 'index.cjs');
    expect(entry?.text).toContain('exports.default');
  });

  it('lists what the manifest does NOT declare', async () => {
    const dir = await makeSourceDir('sparse');
    const result = await buildInstallReview(dir);
    if (!result.ok) throw new Error('expected a review');
    // Silence is the most important thing to surface: a mod that declares nothing
    // still runs with everything.
    expect(result.review.undeclaredCapabilities.join(' ')).toMatch(/network/);
    expect(result.review.undeclaredCapabilities.join(' ')).toMatch(/model/);
  });

  it('reports nothing undeclared when everything is declared', () => {
    const manifest = {
      id: 'full',
      name: 'full',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.cjs',
      band: 'user',
      failMode: 'open',
      capabilities: { fs: { read: [], write: [] }, network: { domains: [] }, ui: ['statusBar'], storage: true, model: true },
    } as ModManifest;
    expect(undeclaredCapabilities(manifest)).toEqual([]);
  });

  it('refuses when the entry file cannot be read as text', async () => {
    // Code the user cannot see is code the user cannot consent to.
    const dir = await makeSourceDir('binary', { entry: 'blob.bin' });
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
    const result = await buildInstallReview(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not be read as text/);
  });

  it('reports a binary sibling without pretending to show it', async () => {
    const dir = await makeSourceDir('with-binary');
    await fs.writeFile(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const result = await buildInstallReview(dir);
    if (!result.ok) throw new Error('expected a review');
    expect(result.review.files.find((file) => file.path === 'logo.png')?.binary).toBe(true);
  });

  it('ignores .git in the preview', async () => {
    const dir = await makeSourceDir('with-git');
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'config'), '[core]');
    const result = await buildInstallReview(dir);
    if (!result.ok) throw new Error('expected a review');
    expect(result.review.files.some((file) => file.path.includes('.git'))).toBe(false);
  });

  it('surfaces an invalid manifest with its field paths', async () => {
    const dir = await makeSourceDir('bad', { version: 'nope' });
    const result = await buildInstallReview(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid/);
      expect(result.detail?.map((entry) => entry.path)).toContain('version');
    }
  });

  it('reports malformed JSON', async () => {
    const dir = path.join(tmpRoot, 'broken-json');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'mod.json'), '{ nope');
    const result = await buildInstallReview(dir);
    expect(result.ok).toBe(false);
  });
});

describe('plugin source cloning', () => {
  it('accepts https and refuses everything else', () => {
    expect(isHttpsUrl('https://example.invalid/mod.git')).toBe(true);
    for (const url of [
      'file:///etc/passwd',
      'ext::sh -c whoami',
      'ssh://git@example.invalid/mod.git',
      'not a url',
      'http://example.invalid/mod.git',
    ]) {
      expect(isHttpsUrl(url)).toBe(false);
    }
  });

  it('refuses a non-https source without spawning anything', async () => {
    const spawnProcess = vi.fn() as unknown as ProcessSpawner;
    const result = await clonePlugin({ url: 'ext::sh -c id', destination: '/tmp/x' }, { spawnProcess });
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/https/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('passes the hardening flags and a scrubbed env to git', async () => {
    const emitted: EventEmitter[] = [];
    let seenArgs: string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const fakeSpawn = ((_cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      seenArgs = args;
      seenEnv = options.env;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number | undefined;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = undefined;
      emitted.push(child);
      setImmediate(() => child.emit('close', 0));
      return child;
    }) as unknown as ProcessSpawner;

    await clonePlugin({ url: 'https://example.invalid/mod.git', destination: '/tmp/x' }, { spawnProcess: fakeSpawn });

    expect(seenArgs).toContain('--depth');
    expect(seenArgs.join(' ')).toContain('core.hooksPath=/dev/null');
    expect(seenArgs.join(' ')).toContain('protocol.ext.allow=never');
    // `--` before the URL so an argument that looks like a flag cannot become one.
    expect(seenArgs.indexOf('--')).toBeLessThan(seenArgs.indexOf('https://example.invalid/mod.git'));
    expect(seenEnv.GIT_TERMINAL_PROMPT).toBe('0');
    // Secrets must not be inherited by whatever git runs.
    expect(seenEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('reports a failed clone', async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('close', 128));
      return child;
    }) as unknown as ProcessSpawner;

    const result = await clonePlugin({ url: 'https://example.invalid/mod.git', destination: '/tmp/x' }, { spawnProcess: fakeSpawn });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(128);
  });

  it('surfaces a spawn error rather than hanging', async () => {
    const fakeSpawn = (() => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid?: number };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit('error', new Error('git not found')));
      return child;
    }) as unknown as ProcessSpawner;

    const result = await clonePlugin({ url: 'https://example.invalid/mod.git', destination: '/tmp/x' }, { spawnProcess: fakeSpawn });
    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/git not found/);
  });
});

describe('marketplace index', () => {
  it('accepts a well-formed index', () => {
    const result = parseMarketplaceIndex(
      JSON.stringify({ version: 1, mods: [{ id: 'a', name: 'A', url: 'https://example.invalid/a.git' }] })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.index.mods).toHaveLength(1);
  });

  it('refuses a non-https entry URL', () => {
    const result = parseMarketplaceIndex(
      JSON.stringify({ version: 1, mods: [{ id: 'a', name: 'A', url: 'file:///etc' }] })
    );
    expect(result.ok).toBe(false);
  });

  it.each([
    ['not JSON', 'nope'],
    ['wrong version', JSON.stringify({ version: 2, mods: [] })],
    ['no mods array', JSON.stringify({ version: 1 })],
    ['entry missing url', JSON.stringify({ version: 1, mods: [{ id: 'a', name: 'A' }] })],
  ])('refuses %s', (_label, raw) => {
    expect(parseMarketplaceIndex(raw).ok).toBe(false);
  });
});

describe('installer', () => {
  function makeInstaller() {
    const approvalsBacking: ApprovalStoreLike & { data: Record<string, ApprovedMod> } = {
      data: {},
      load: () => ({ ...approvalsBacking.data }),
      save: (next) => {
        approvalsBacking.data = { ...next };
      },
    };
    const installBacking: InstallStoreLike & { data: ReturnType<typeof emptyInstallState> } = {
      data: emptyInstallState(),
      load: () => JSON.parse(JSON.stringify(installBacking.data)) as ReturnType<typeof emptyInstallState>,
      save: (next) => {
        installBacking.data = JSON.parse(JSON.stringify(next)) as ReturnType<typeof emptyInstallState>;
      },
    };
    const installer = new ModInstaller(
      installBacking,
      new ModApprovalStore(approvalsBacking),
      { tools: { invoke: async () => ({ content: '' }) } },
      createNodeImporter(process.cwd()),
      path.join(tmpRoot, 'mods'),
      path.join(tmpRoot, 'staging')
    );
    return { installer, approvalsBacking, installBacking };
  }

  it('stages without installing anything', async () => {
    const { installer } = makeInstaller();
    const dir = await makeSourceDir('staged');
    const stage = await installer.stageFromDirectory(dir);
    expect(stage.stage).toBe('review');
    await expect(fs.access(path.join(tmpRoot, 'mods', 'staged'))).rejects.toThrow();
  });

  it('copies into a staging area and still installs nothing', async () => {
    const { installer } = makeInstaller();
    const dir = await makeSourceDir('copied');
    const stage = await installer.stageByCopy(dir);
    expect(stage.stage).toBe('review');
    if (stage.stage !== 'review') return;
    await expect(fs.access(path.join(stage.stagingDir, 'mod.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpRoot, 'mods', 'copied'))).rejects.toThrow();
  });

  it('refuses to commit when the code changed since review', async () => {
    const { installer } = makeInstaller();
    const dir = await makeSourceDir('swapped');
    const stage = await installer.stageFromDirectory(dir);
    if (stage.stage !== 'review') throw new Error('expected review');

    // The user approved hash A; the bytes on disk are now B.
    const result = await installer.commit({
      review: stage.review,
      stagingDir: stage.stagingDir,
      approvedHash: 'f'.repeat(64),
      source: dir,
    });
    expect(result.ok).toBe(false);
    expect(result.reapprovalRequired).toBe(true);
  });

  it('commits an approved plugin and records it', async () => {
    const { installer, installBacking } = makeInstaller();
    const dir = await makeSourceDir('approved');
    const stage = await installer.stageFromDirectory(dir);
    if (stage.stage !== 'review') throw new Error('expected review');

    const result = await installer.commit({
      review: stage.review,
      stagingDir: stage.stagingDir,
      approvedHash: stage.review.fingerprint,
      source: 'local folder',
    });
    expect(result.ok).toBe(true);
    expect(result.modId).toBe('approved');
    expect(installBacking.data.installed.approved?.fingerprint).toBe(stage.review.fingerprint);
    await expect(fs.access(path.join(tmpRoot, 'mods', 'approved', 'mod.json'))).resolves.toBeUndefined();
  });

  it('loads the installed plugin for real through the bus', async () => {
    const { installer } = makeInstaller();
    const dir = await makeSourceDir('loadable');
    const stage = await installer.stageFromDirectory(dir);
    if (stage.stage !== 'review') throw new Error('expected review');
    await installer.commit({ review: stage.review, stagingDir: stage.stagingDir, approvedHash: stage.review.fingerprint, source: 'test' });

    const bus = new ModEventBus();
    const outcome = await installer.loadInstalled(bus);
    expect(outcome.loaded).toContain('loadable');
    expect(bus.list().map((entry) => entry.manifest.id)).toContain('loadable');
  });

  it('refuses to load a mod whose bytes changed after install', async () => {
    const { installer } = makeInstaller();
    const dir = await makeSourceDir('tampered');
    const stage = await installer.stageFromDirectory(dir);
    if (stage.stage !== 'review') throw new Error('expected review');
    await installer.commit({ review: stage.review, stagingDir: stage.stagingDir, approvedHash: stage.review.fingerprint, source: 'test' });

    // Someone edits the installed copy.
    const installedEntry = path.join(tmpRoot, 'mods', 'tampered', 'index.cjs');
    await fs.writeFile(installedEntry, `${'"use strict";\nmodule.exports = { id: "tampered", surprise: true };\n'}`);

    const outcome = await installer.loadInstalled(new ModEventBus());
    expect(outcome.loaded).not.toContain('tampered');
    expect(outcome.refused.find((entry) => entry.id === 'tampered')?.reason).toMatch(/changed/i);
  });

  it('is enabled by default and honours the global toggle', async () => {
    const { installer } = makeInstaller();
    expect(installer.isEnabled('anything')).toBe(true);
    installer.setEnabled('anything', false);
    expect(installer.isEnabled('anything')).toBe(false);
    installer.setEnabled('anything', true);
    expect(installer.isEnabled('anything')).toBe(true);
  });

  it('lets a project override the global setting', async () => {
    const { installer } = makeInstaller();
    installer.setEnabled('shared', false);
    expect(installer.isEnabled('shared', 'project-1')).toBe(false);
    installer.setEnabled('shared', true, 'project-1');
    expect(installer.isEnabled('shared', 'project-1')).toBe(true);
    expect(installer.isEnabled('shared')).toBe(false);
  });

  it('can drop a project override so the mod follows the global setting again', () => {
    const { installer } = makeInstaller();
    installer.setEnabled('shared', false);
    installer.setEnabled('shared', true, 'project-1');
    installer.clearProjectOverride('shared', 'project-1');
    expect(installer.isEnabled('shared', 'project-1')).toBe(false);
  });

  it('does not load a mod that is disabled', async () => {
    const { installer } = makeInstaller();
    const dir = await makeSourceDir('switched-off');
    const stage = await installer.stageFromDirectory(dir);
    if (stage.stage !== 'review') throw new Error('expected review');
    await installer.commit({ review: stage.review, stagingDir: stage.stagingDir, approvedHash: stage.review.fingerprint, source: 'test' });
    installer.setEnabled('switched-off', false);

    const outcome = await installer.loadInstalled(new ModEventBus());
    expect(outcome.loaded).not.toContain('switched-off');
  });

  it('uninstall removes the files, the record and the approval', async () => {
    const { installer, approvalsBacking } = makeInstaller();
    const dir = await makeSourceDir('removable');
    const stage = await installer.stageFromDirectory(dir);
    if (stage.stage !== 'review') throw new Error('expected review');
    await installer.commit({ review: stage.review, stagingDir: stage.stagingDir, approvedHash: stage.review.fingerprint, source: 'test' });

    expect(await installer.uninstall('removable')).toBe(true);
    expect(await installer.uninstall('removable')).toBe(false);
    await expect(fs.access(path.join(tmpRoot, 'mods', 'removable'))).rejects.toThrow();
    expect(approvalsBacking.data.removable).toBeUndefined();
  });

  it('leaves no .previous directory behind after an upgrade', async () => {
    const { installer } = makeInstaller();
    const dir = await makeSourceDir('upgraded');
    const stage = await installer.stageFromDirectory(dir);
    if (stage.stage !== 'review') throw new Error('expected review');
    await installer.commit({ review: stage.review, stagingDir: stage.stagingDir, approvedHash: stage.review.fingerprint, source: 'test' });

    const updated = await makeSourceDir('upgraded', { version: '1.1.0' });
    const secondStage = await installer.stageByCopy(updated);
    if (secondStage.stage !== 'review') throw new Error('expected review');
    await installer.commit({
      review: secondStage.review,
      stagingDir: secondStage.stagingDir,
      approvedHash: secondStage.review.fingerprint,
      source: 'update',
    });

    await expect(fs.access(path.join(tmpRoot, 'mods', 'upgraded.previous'))).rejects.toThrow();
    expect(installer.list()[0]?.version).toBe('1.1.0');
  });
});