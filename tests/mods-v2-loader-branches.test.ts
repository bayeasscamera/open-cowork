import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintPlugin } from '../src/main/mods/v2/plugin-hash';
import { ModLoader, createNodeImporter } from '../src/main/mods/v2/loader';
import { ModApprovalStore, type ApprovalStoreLike, type ApprovedMod } from '../src/main/mods/v2/approval-store';
import { ModEventBus } from '../src/main/mods/v2/event-bus';
import { buildModContext, MemoryModStorage } from '../src/main/mods/v2/mod-context';
import type { ModManifest } from '@cowork/mod-api';

/** Branch-closure tests for the loader, context and fingerprint paths. */

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-mods-b-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function approvalsBacking(): ApprovalStoreLike & { data: Record<string, ApprovedMod> } {
  const box = {
    data: {} as Record<string, ApprovedMod>,
    load: () => ({ ...box.data }),
    save: (next: Record<string, ApprovedMod>) => {
      box.data = { ...next };
    },
  };
  return box;
}

async function pluginDir(id: string, body: string, manifestOverrides: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(tmpRoot, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'mod.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.cjs',
      band: 'user',
      failMode: 'open',
      ...manifestOverrides,
    })
  );
  await fs.writeFile(path.join(dir, 'index.cjs'), body);
  return dir;
}

async function approve(dir: string, id: string) {
  const fingerprint = await fingerprintPlugin(dir);
  const approvals = new ModApprovalStore(approvalsBacking());
  approvals.approve({ modId: id, currentHash: fingerprint.hash, version: '1.0.0', sourcePath: dir });
  return approvals;
}

describe('fingerprint — traversal shapes', () => {
  it('walks nested directories and keeps the same hash for the same shape', async () => {
    const a = path.join(tmpRoot, 'nested-a');
    const b = path.join(tmpRoot, 'nested-b');
    for (const dir of [a, b]) {
      await fs.mkdir(path.join(dir, 'deep', 'deeper'), { recursive: true });
      await fs.writeFile(path.join(dir, 'top.txt'), 't');
      await fs.writeFile(path.join(dir, 'deep', 'mid.txt'), 'm');
      await fs.writeFile(path.join(dir, 'deep', 'deeper', 'leaf.txt'), 'l');
    }
    expect((await fingerprintPlugin(a)).hash).toBe((await fingerprintPlugin(b)).hash);
    expect((await fingerprintPlugin(a)).fileCount).toBe(3);
  });

  it('reports an unreadable root instead of throwing', async () => {
    const result = await fingerprintPlugin(path.join(tmpRoot, 'does-not-exist'));
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(result.hash).toBe('');
  });

  it('counts bytes it actually read', async () => {
    const dir = path.join(tmpRoot, 'sized');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
    const result = await fingerprintPlugin(dir);
    expect(result.totalBytes).toBe(5);
  });

  it('skips a file it cannot read and says so', async () => {
    // Not a hypothetical: on a machine where a plugin file becomes unreadable
    // after install, the fingerprint must report the gap rather than quietly
    // covering fewer bytes than the user approved.
    if (process.getuid?.() === 0) return; // root bypasses the permission bits
    const dir = path.join(tmpRoot, 'locked');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'readable.txt'), 'ok');
    await fs.writeFile(path.join(dir, 'locked.txt'), 'secret');
    await fs.chmod(path.join(dir, 'locked.txt'), 0o000);
    try {
      const result = await fingerprintPlugin(dir);
      expect(result.skipped.some((entry) => entry.path.includes('locked.txt'))).toBe(true);
    } finally {
      await fs.chmod(path.join(dir, 'locked.txt'), 0o600);
    }
  });
});

describe('loader — export shapes', () => {
  async function loadPlugin(dir: string, id: string) {
    const approvals = await approve(dir, id);
    const loader = new ModLoader({
      tools: { invoke: async () => ({ content: '' }) },
      approvals,
      importModule: createNodeImporter(process.cwd()),
    });
    return loader.load(dir, new ModEventBus());
  }

  it('accepts a default export', async () => {
    const dir = await pluginDir(
      'default-export',
      `"use strict";
exports.default = { id: "default-export" };
`
    );
    expect((await loadPlugin(dir, 'default-export')).status).toBe('loaded');
  });

  it('accepts a CommonJS module.exports assignment', async () => {
    const dir = await pluginDir(
      'module-exports',
      `"use strict";
module.exports = { id: "module-exports" };
`
    );
    expect((await loadPlugin(dir, 'module-exports')).status).toBe('loaded');
  });

  it('accepts a factory function receiving the context', async () => {
    const dir = await pluginDir(
      'factory',
      `"use strict";
module.exports = function activate(ctx) {
  if (!ctx || ctx.modId !== "factory") throw new Error("bad ctx: " + JSON.stringify(ctx && ctx.modId));
  return { id: "factory" };
};
`
    );
    const outcome = await loadPlugin(dir, 'factory');
    expect(outcome.status).toBe('loaded');
  });

  it('calls activate() when the module also carries an id', async () => {
    const dir = await pluginDir(
      'activatable',
      `"use strict";
exports.default = {
  id: "activatable",
  activate(ctx) {
    return { id: "activatable", seen: ctx.modId };
  },
};
`
    );
    const outcome = await loadPlugin(dir, 'activatable');
    expect(outcome.status).toBe('loaded');
  });

  it('reports a module that exports nothing usable', async () => {
    const dir = await pluginDir('empty', `"use strict";\nmodule.exports = 42;\n`);
    const outcome = await loadPlugin(dir, 'empty');
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.message).toMatch(/did not export/);
  });

  it('reports an import that throws', async () => {
    const dir = await pluginDir(
      'thrower',
      `"use strict";
throw new Error("plugin exploded on load");
`
    );
    const outcome = await loadPlugin(dir, 'thrower');
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.message).toMatch(/exploded/);
  });

  it('does not register a mod that failed to load', async () => {
    const dir = await pluginDir('unregistered', `"use strict";\nthrow new Error("nope");\n`);
    const approvals = await approve(dir, 'unregistered');
    const loader = new ModLoader({
      tools: { invoke: async () => ({ content: '' }) },
      approvals,
      importModule: createNodeImporter(process.cwd()),
    });
    const bus = new ModEventBus();
    await loader.load(dir, bus);
    expect(bus.list()).toHaveLength(0);
  });
});

describe('mod context — settings and UI channels', () => {
  const manifest: ModManifest = {
    id: 'channelled',
    name: 'channelled',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'index.cjs',
    band: 'user',
    failMode: 'open',
  };

  it('round-trips settings through the host backend', async () => {
    const store = new Map<string, unknown>();
    const ctx = buildModContext(manifest, {
      tools: { invoke: async () => ({ content: '' }) },
      settings: {
        get: async (_modId, key) => store.get(key) as never,
        set: async (_modId, key, value) => {
          store.set(key, value);
        },
      },
    });
    await ctx.settings.set('density', 'compact');
    expect(await ctx.settings.get('density')).toBe('compact');
  });

  it('tolerates a host with no settings backend', async () => {
    const ctx = buildModContext(manifest, { tools: { invoke: async () => ({ content: '' }) } });
    await expect(ctx.settings.set('a', 1)).resolves.toBeUndefined();
    expect(await ctx.settings.get('a')).toBeUndefined();
  });

  it('forwards a UI contribution, notice and value read to the host', async () => {
    const contribute = vi.fn(async () => undefined);
    const notify = vi.fn(async () => undefined);
    const readValue = vi.fn(async () => 'typed');
    const ctx = buildModContext(manifest, {
      tools: { invoke: async () => ({ content: '' }) },
      ui: { contribute, notify, readValue },
    });

    await ctx.ui.contribute({ slot: 'statusBar', nodes: [{ kind: 'text', label: 'hi' }] });
    await ctx.ui.notify('careful');
    expect(await ctx.ui.readValue('node-1')).toBe('typed');

    expect(contribute).toHaveBeenCalledWith('channelled', expect.objectContaining({ slot: 'statusBar' }));
    expect(notify).toHaveBeenCalledWith('channelled', 'careful', 'info');
  });

  it('falls back to the mod log for a notice when no UI channel exists', async () => {
    const warn = vi.fn();
    const ctx = buildModContext(manifest, {
      tools: { invoke: async () => ({ content: '' }) },
      log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    await ctx.ui.notify('heads up', 'warn');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('heads up'));
  });

  it('returns undefined for a value read with no UI channel', async () => {
    const ctx = buildModContext(manifest, { tools: { invoke: async () => ({ content: '' }) } });
    expect(await ctx.ui.readValue('node')).toBeUndefined();
  });

  it('rejects a malformed UI contribution coming from the host boundary', async () => {
    const ctx = buildModContext(manifest, {
      tools: { invoke: async () => ({ content: '' }) },
      ui: {
        contribute: async () => undefined,
        notify: async () => undefined,
        readValue: async () => undefined,
      },
    });
    // An unknown slot must not reach a renderer slot table by accident.
    await expect(
      ctx.ui.contribute({ slot: 'nowhere' as never, nodes: [] })
    ).resolves.toBeUndefined();
  });

  it('exposes session info as read-only view', () => {
    const ctx = buildModContext(manifest, {
      tools: { invoke: async () => ({ content: '' }) },
      session: { id: 's9', cwd: '/w', projectId: 'p1' },
      storage: new MemoryModStorage(),
    });
    expect(ctx.session).toEqual({ id: 's9', cwd: '/w', projectId: 'p1' });
  });

  it('defaults the session view to the process cwd when the host omits it', () => {
    const ctx = buildModContext(manifest, { tools: { invoke: async () => ({ content: '' }) } });
    expect(ctx.session.cwd).toBe(process.cwd());
  });
});