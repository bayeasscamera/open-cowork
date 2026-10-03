import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { fingerprintPlugin, hashContent } from '../src/main/mods/v2/plugin-hash';
import { ModApprovalStore, approvalId, type ApprovalStoreLike, type ApprovedMod } from '../src/main/mods/v2/approval-store';
import { ModLoader, createNodeImporter, type ModuleImporter } from '../src/main/mods/v2/loader';
import { ModEventBus } from '../src/main/mods/v2/event-bus';
import {
  MemoryModStorage,
  buildModContext,
  isValidStorageKey,
  type ModContextDeps,
} from '../src/main/mods/v2/mod-context';
import {
  SAFE_MODE_CRASH_THRESHOLD,
  ModWatchdog,
  SafeModeController,
  initialSafeModeState,
  isNoModsFlagPresent,
  type SafeModeState,
  type SafeModeStoreLike,
} from '../src/main/mods/v2/safe-mode';
import type { ModManifest } from '@cowork/mod-api';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-mods-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** Write a real plugin directory with a real CJS entry, loadable by require. */
async function writePlugin(options: {
  id: string;
  body?: string;
  manifest?: Record<string, unknown>;
  files?: Record<string, string>;
}): Promise<string> {
  const dir = path.join(tmpRoot, options.id);
  await fs.mkdir(dir, { recursive: true });
  const manifest = {
    id: options.id,
    name: options.id,
    version: '1.0.0',
    apiVersion: 1,
    entry: 'index.cjs',
    band: 'user',
    failMode: 'open',
    ...options.manifest,
  };
  await fs.writeFile(path.join(dir, 'mod.json'), JSON.stringify(manifest, null, 2));
  await fs.writeFile(
    path.join(dir, 'index.cjs'),
    options.body ??
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = { id: ${JSON.stringify(options.id)}, onUserPrompt: () => ({ action: 'rewrite', prompt: 'patched' }) };
`
  );
  for (const [name, content] of Object.entries(options.files ?? {})) {
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

function manifestOf(id: string, overrides: Partial<ModManifest> = {}): ModManifest {
  return { id, name: id, version: '1.0.0', apiVersion: 1, entry: 'index.cjs', band: 'user', failMode: 'open', ...overrides } as ModManifest;
}

function memoryApprovals(): ApprovalStoreLike & { data: Record<string, ApprovedMod> } {
  const box = {
    data: {} as Record<string, ApprovedMod>,
    load() {
      return { ...box.data };
    },
    save(next: Record<string, ApprovedMod>) {
      box.data = { ...next };
    },
  };
  return box;
}

function stubContextDeps(): ModContextDeps {
  return {
    tools: { invoke: async () => ({ content: 'tool ran' }) },
    session: { id: 's1', cwd: tmpRoot },
  };
}

describe('plugin fingerprint', () => {
  it('is stable for identical content written twice', async () => {
    const a = await writePlugin({ id: 'stable', files: { 'helper.js': 'export const x = 1;' } });
    const b = await writePlugin({ id: 'stable', files: { 'helper.js': 'export const x = 1;' } });
    expect((await fingerprintPlugin(a)).hash).toBe((await fingerprintPlugin(b)).hash);
  });

  it('changes when a non-entry file changes', async () => {
    const dir = await writePlugin({ id: 'detect', files: { 'helper.js': 'one' } });
    const before = (await fingerprintPlugin(dir)).hash;
    await fs.writeFile(path.join(dir, 'helper.js'), 'two');
    const after = (await fingerprintPlugin(dir)).hash;
    // The pin is the only control on in-process code, so a changed sibling has
    // to invalidate it — otherwise a payload hides outside the entry file.
    expect(after).not.toBe(before);
  });

  it('changes when a file is renamed', async () => {
    const dir = await writePlugin({ id: 'rename', files: { 'a.js': 'same' } });
    const before = (await fingerprintPlugin(dir)).hash;
    await fs.rename(path.join(dir, 'a.js'), path.join(dir, 'b.js'));
    expect((await fingerprintPlugin(dir)).hash).not.toBe(before);
  });

  it('ignores .git', async () => {
    const dir = await writePlugin({ id: 'gitignore' });
    const before = (await fingerprintPlugin(dir)).hash;
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
    expect((await fingerprintPlugin(dir)).hash).toBe(before);
  });

  it('refuses to follow a symlink out of the plugin', async () => {
    const dir = await writePlugin({ id: 'symlinked' });
    await fs.symlink('/etc/hosts', path.join(dir, 'escape'));
    const result = await fingerprintPlugin(dir);
    expect(result.skipped.some((entry) => entry.reason.includes('symbolic link'))).toBe(true);
  });

  it('reports an empty plugin rather than a hash of nothing', async () => {
    const dir = path.join(tmpRoot, 'bare');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'mod.json'), '{}');
    const result = await fingerprintPlugin(dir);
    // mod.json is a file, so this is fingerprinted; the point of the assertion is
    // that a hash exists and is 64 hex chars, not that it is empty.
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes single content deterministically', () => {
    expect(hashContent('abc')).toBe(createHash('sha256').update('abc', 'utf-8').digest('hex'));
  });
});

describe('approval store', () => {
  it('refuses an unknown mod and says it is a first approval', () => {
    const store = new ModApprovalStore(memoryApprovals());
    const decision = store.check({ modId: 'x', currentHash: 'aaa', sourcePath: '/tmp/x' });
    expect(decision.allowed).toBe(false);
    expect(decision.firstApproval).toBe(true);
  });

  it('passes an approved mod whose hash is unchanged', () => {
    const backing = memoryApprovals();
    const store = new ModApprovalStore(backing);
    store.approve({ modId: 'x', currentHash: 'aaa', version: '1.0.0', sourcePath: '/tmp/x' });
    expect(store.check({ modId: 'x', currentHash: 'aaa', sourcePath: '/tmp/x' }).allowed).toBe(true);
  });

  it('refuses an approved mod whose bytes changed, and says it is not a first approval', () => {
    const store = new ModApprovalStore(memoryApprovals());
    store.approve({ modId: 'x', currentHash: 'aaa', version: '1.0.0', sourcePath: '/tmp/x' });
    const decision = store.check({ modId: 'x', currentHash: 'bbb', sourcePath: '/tmp/x' });
    expect(decision.allowed).toBe(false);
    expect(decision.firstApproval).toBe(false);
    expect(decision.reason).toMatch(/changed/i);
  });

  it('replaces the pin on re-approval rather than keeping both', () => {
    const store = new ModApprovalStore(memoryApprovals());
    store.approve({ modId: 'x', currentHash: 'aaa', version: '1.0.0', sourcePath: '/tmp/x' });
    store.approve({ modId: 'x', currentHash: 'bbb', version: '1.1.0', sourcePath: '/tmp/x' });
    expect(store.get('x')?.approvedHash).toBe('bbb');
    expect(store.list()).toHaveLength(1);
  });

  it('revoke forces a new approval', () => {
    const store = new ModApprovalStore(memoryApprovals());
    store.approve({ modId: 'x', currentHash: 'aaa', version: '1.0.0', sourcePath: '/tmp/x' });
    expect(store.revoke('x')).toBe(true);
    expect(store.revoke('x')).toBe(false);
    expect(store.check({ modId: 'x', currentHash: 'aaa', sourcePath: '/tmp/x' }).firstApproval).toBe(true);
  });

  it('describes approval state for the settings page', () => {
    const store = new ModApprovalStore(memoryApprovals());
    expect(store.describe(manifestOf('x')).firstApproval).toBe(true);
    store.approve({ modId: 'x', currentHash: 'aaa', version: '1.0.0', sourcePath: '/tmp/x' });
    expect(store.describe(manifestOf('x'))).toMatchObject({ approved: true, pinnedHash: 'aaa', approvedVersion: '1.0.0' });
  });

  it('derives a stable approval id from mod, hash and path', () => {
    const input = { modId: 'x', currentHash: 'aaa', sourcePath: '/tmp/x' };
    expect(approvalId(input)).toBe(approvalId({ ...input }));
    expect(approvalId(input)).not.toBe(approvalId({ ...input, currentHash: 'bbb' }));
  });
});

describe('mod context', () => {
  it('routes tool calls through the injected backend, tagged with the mod id', async () => {
    const invoke = vi.fn(async () => ({ content: 'ok' }));
    const ctx = buildModContext(manifestOf('caller'), { ...stubContextDeps(), tools: { invoke } });
    await ctx.tools.invoke('read', { path: '/x' });
    expect(invoke).toHaveBeenCalledWith('caller', 'read', { path: '/x' });
  });

  it.each(['bad key', 'a/b', 'a\\b', '../escape', '', 'x'.repeat(200)])('rejects storage key %j', (key) => {
    expect(isValidStorageKey(key)).toBe(false);
  });

  it('accepts a plain storage key', () => {
    expect(isValidStorageKey('counter-1')).toBe(true);
  });

  it('round-trips a value through storage', async () => {
    const ctx = buildModContext(manifestOf('storer'), { ...stubContextDeps(), storage: new MemoryModStorage() });
    await ctx.storage.set('state', { count: 3 });
    expect(await ctx.storage.get<{ count: number }>('state')).toEqual({ count: 3 });
    expect(await ctx.storage.list()).toEqual(['state']);
    expect(await ctx.storage.usage()).toBeGreaterThan(0);
    await ctx.storage.delete('state');
    expect(await ctx.storage.get('state')).toBeUndefined();
  });

  it('refuses a value above the per-value ceiling', async () => {
    const ctx = buildModContext(manifestOf('fat'), {
      ...stubContextDeps(),
      storage: new MemoryModStorage(),
      maxValueBytes: 32,
    });
    await expect(ctx.storage.set('blob', 'x'.repeat(100))).rejects.toThrow(/quota/i);
  });

  it('refuses to exceed the total quota', async () => {
    const ctx = buildModContext(manifestOf('greedy'), {
      ...stubContextDeps(),
      storage: new MemoryModStorage(),
      storageQuotaBytes: 80,
      maxValueBytes: 1000,
    });
    await ctx.storage.set('a', 'x'.repeat(50));
    await expect(ctx.storage.set('b', 'y'.repeat(50))).rejects.toThrow(/quota/i);
  });

  it('keeps one mod out of another mod namespace', async () => {
    const storage = new MemoryModStorage();
    const first = buildModContext(manifestOf('one'), { ...stubContextDeps(), storage });
    const second = buildModContext(manifestOf('two'), { ...stubContextDeps(), storage });
    await first.storage.set('secret', 'mine');
    expect(await second.storage.get('secret')).toBeUndefined();
  });

  it('refuses model access when the host granted no model channel', async () => {
    const ctx = buildModContext(manifestOf('no-model'), stubContextDeps());
    await expect(ctx.model.ask('hello')).rejects.toThrow(/model channel/);
  });

  it('refuses UI contribution when the host granted no UI channel', async () => {
    const ctx = buildModContext(manifestOf('no-ui'), stubContextDeps());
    await expect(ctx.ui.contribute({ slot: 'statusBar', nodes: [] })).rejects.toThrow(/UI channel/);
  });

  it('applies a default cost ceiling rather than none', async () => {
    const ask = vi.fn(async () => 'answer');
    const ctx = buildModContext(manifestOf('asker'), { ...stubContextDeps(), model: { ask } });
    await ctx.model.ask('hi');
    expect(ask).toHaveBeenCalledWith('asker', 'hi', expect.objectContaining({ maxCostUsd: expect.any(Number) }));
  });

  it('fs helper refuses rather than pretending to work', async () => {
    const ctx = buildModContext(manifestOf('no-fs'), stubContextDeps());
    await expect(ctx.fs.readFile('/etc/hosts')).rejects.toThrow(/filesystem helper/);
  });
});

describe('mod loader', () => {
  function loaderWith(importer: ModuleImporter) {
    return new ModLoader({
      ...stubContextDeps(),
      approvals: new ModApprovalStore(memoryApprovals()),
      importModule: importer,
    });
  }

  it('inspects without executing anything', async () => {
    const importer = vi.fn<ModuleImporter>(async () => ({}));
    const dir = await writePlugin({ id: 'inspected' });
    const outcome = await loaderWith(importer).inspect(dir);
    expect(outcome.status).toBe('needs-approval');
    expect(importer).not.toHaveBeenCalled();
  });

  it('refuses to load an unapproved mod and never imports it', async () => {
    const importer = vi.fn<ModuleImporter>(async () => ({}));
    const dir = await writePlugin({ id: 'unapproved' });
    const outcome = await loaderWith(importer).load(dir, new ModEventBus());
    expect(outcome.status).toBe('needs-approval');
    expect(importer).not.toHaveBeenCalled();
  });

  it('loads an approved mod for real and registers it on the bus', async () => {
    const dir = await writePlugin({ id: 'real' });
    const fingerprint = await fingerprintPlugin(dir);
    const approvals = new ModApprovalStore(memoryApprovals());
    approvals.approve({ modId: 'real', currentHash: fingerprint.hash, version: '1.0.0', sourcePath: dir });

    const loader = new ModLoader({
      ...stubContextDeps(),
      approvals,
      importModule: createNodeImporter(process.cwd()),
    });
    const bus = new ModEventBus();
    const outcome = await loader.load(dir, bus);

    expect(outcome.status).toBe('loaded');
    expect(bus.list().map((entry) => entry.manifest.id)).toEqual(['real']);
  });

  it('runs a loaded mod hook through the bus', async () => {
    const dir = await writePlugin({ id: 'hooked' });
    const fingerprint = await fingerprintPlugin(dir);
    const approvals = new ModApprovalStore(memoryApprovals());
    approvals.approve({ modId: 'hooked', currentHash: fingerprint.hash, version: '1.0.0', sourcePath: dir });

    const loader = new ModLoader({ ...stubContextDeps(), approvals, importModule: createNodeImporter(process.cwd()) });
    const bus = new ModEventBus();
    await loader.load(dir, bus);

    const result = await bus.chain<'onUserPrompt', string, string>(
      'onUserPrompt',
      'original',
      (mod) => (mod.onUserPrompt as (input: { prompt: string }) => unknown)({ prompt: 'original', session: { sessionId: 's', cwd: tmpRoot } }),
      (current, decision) => ((decision as { prompt: string }).prompt ?? current),
      'original'
    );
    expect(result.value).toBe('patched');
    expect(result.modifiedBy).toEqual(['hooked']);
  });

  it('refuses a mod whose code id disagrees with its manifest', async () => {
    const dir = await writePlugin({
      id: 'liar',
      body: `"use strict";
exports.default = { id: "someone-else" };
`,
    });
    const fingerprint = await fingerprintPlugin(dir);
    const approvals = new ModApprovalStore(memoryApprovals());
    approvals.approve({ modId: 'liar', currentHash: fingerprint.hash, version: '1.0.0', sourcePath: dir });

    const loader = new ModLoader({ ...stubContextDeps(), approvals, importModule: createNodeImporter(process.cwd()) });
    const outcome = await loader.load(dir, new ModEventBus());
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.message).toMatch(/someone-else/);
  });

  it('rejects an invalid manifest before touching the entry', async () => {
    const importer = vi.fn<ModuleImporter>(async () => ({}));
    const dir = await writePlugin({ id: 'bad-manifest', manifest: { version: 'not-semver' } });
    const outcome = await loaderWith(importer).inspect(dir);
    expect(outcome.status).toBe('invalid-manifest');
    expect(importer).not.toHaveBeenCalled();
  });

  it('reports unparseable JSON as an invalid manifest', async () => {
    const dir = path.join(tmpRoot, 'not-json');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'mod.json'), '{ nope');
    const outcome = await loaderWith(vi.fn()).inspect(dir);
    expect(outcome.status).toBe('invalid-manifest');
  });

  it('reports a missing manifest as an error, not a crash', async () => {
    const outcome = await loaderWith(vi.fn()).inspect(path.join(tmpRoot, 'nothing-here'));
    expect(outcome.status).toBe('error');
  });

  it('refuses an entry that escapes the plugin directory even if approved', async () => {
    const dir = await writePlugin({ id: 'escape', manifest: { entry: '../outside.cjs' } });
    const fingerprint = await fingerprintPlugin(dir);
    const approvals = new ModApprovalStore(memoryApprovals());
    approvals.approve({ modId: 'escape', currentHash: fingerprint.hash, version: '1.0.0', sourcePath: dir });
    const outcome = await new ModLoader({
      ...stubContextDeps(),
      approvals,
      importModule: createNodeImporter(process.cwd()),
    }).load(dir, new ModEventBus());
    expect(outcome.status).toBe('invalid-manifest');
  });
});

describe('safe mode', () => {
  function safeStore(): SafeModeStoreLike & { state: SafeModeState } {
    const box = {
      state: initialSafeModeState(),
      load() {
        return { ...box.state };
      },
      save(next: SafeModeState) {
        box.state = { ...next };
      },
    };
    return box;
  }

  it('detects the --no-mods flag', () => {
    expect(isNoModsFlagPresent(['electron', '--no-mods'])).toBe(true);
    expect(isNoModsFlagPresent(['electron'])).toBe(false);
  });

  it('starts normally when nothing is wrong', () => {
    const decision = new SafeModeController(safeStore()).evaluate([]);
    expect(decision).toMatchObject({ safeMode: false, reason: 'none' });
  });

  it('honours the flag above everything', () => {
    const backing = safeStore();
    const controller = new SafeModeController(backing);
    controller.setDisabledGlobally(true);
    expect(controller.evaluate(['--no-mods']).reason).toBe('flag');
  });

  it('honours the setting', () => {
    const controller = new SafeModeController(safeStore());
    controller.setDisabledGlobally(true);
    expect(controller.evaluate([])).toMatchObject({ safeMode: true, reason: 'setting' });
  });

  it('enters safe mode automatically after N consecutive boot failures', () => {
    const controller = new SafeModeController(safeStore(), 3);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      controller.recordBootFailure({ ok: false, loadedMods: ['suspect'] });
      expect(controller.evaluate([]).safeMode).toBe(false);
    }
    const state = controller.recordBootFailure({ ok: false, loadedMods: ['suspect'] });
    expect(state.autoEnteredAt).not.toBeNull();
    expect(controller.evaluate([])).toMatchObject({ safeMode: true, reason: 'auto', crashedMods: ['suspect'] });
    expect(SAFE_MODE_CRASH_THRESHOLD).toBe(3);
  });

  it('a clean boot clears the failure run', () => {
    const controller = new SafeModeController(safeStore(), 2);
    controller.recordBootFailure({ ok: false, loadedMods: ['a'] });
    controller.recordBootSuccess();
    expect(controller.snapshot().consecutiveBootFailures).toBe(0);
    expect(controller.evaluate([]).safeMode).toBe(false);
  });

  it('clearing the automatic mode lets the user retry', () => {
    const controller = new SafeModeController(safeStore(), 1);
    controller.recordBootFailure({ ok: false, loadedMods: ['a'] });
    expect(controller.evaluate([]).safeMode).toBe(true);
    controller.clearAuto();
    expect(controller.evaluate([]).safeMode).toBe(false);
  });
});

describe('mod watchdog', () => {
  it('relaunches with --no-mods when the main process is still hung', () => {
    vi.useFakeTimers();
    const relaunch = vi.fn();
    const watchdog = new ModWatchdog({
      hangTimeoutMs: 1000,
      pollIntervalMs: 100,
      spawnWatchdog: () => 4242,
      relaunch,
      isAlive: () => true,
    });

    watchdog.arm();
    vi.advanceTimersByTime(1000);
    expect(relaunch).toHaveBeenCalledWith(['--no-mods']);
    vi.useRealTimers();
  });

  it('does nothing when the main process exited cleanly', () => {
    vi.useFakeTimers();
    const relaunch = vi.fn();
    const watchdog = new ModWatchdog({
      hangTimeoutMs: 1000,
      pollIntervalMs: 100,
      spawnWatchdog: () => 4242,
      relaunch,
      isAlive: () => false,
    });

    watchdog.arm();
    vi.advanceTimersByTime(5000);
    expect(relaunch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('arms only once and can be disarmed', () => {
    vi.useFakeTimers();
    const relaunch = vi.fn();
    const spawn = vi.fn(() => 1);
    const watchdog = new ModWatchdog({
      hangTimeoutMs: 1000,
      pollIntervalMs: 100,
      spawnWatchdog: spawn,
      relaunch,
      isAlive: () => true,
    });

    expect(watchdog.arm()).toBe(1);
    expect(watchdog.isArmed()).toBe(true);
    expect(watchdog.arm()).toBe(-1);
    expect(spawn).toHaveBeenCalledTimes(1);

    watchdog.disarm();
    vi.advanceTimersByTime(5000);
    expect(relaunch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});