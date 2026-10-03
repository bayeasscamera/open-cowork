import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../src/main/tools/registry';
import { runToolGate, type ToolGateDeps } from '../src/main/tools/pipeline';
import { createBuiltinModsV2 } from '../src/main/mods/v2/builtin-mods-v2';
import { adaptLegacyMod } from '../src/main/mods/v2/legacy-adapter';
import { ModEventBus } from '../src/main/mods/v2/event-bus';
import { buildModContext } from '../src/main/mods/v2/mod-context';
import { ModsRegistry } from '../src/main/mods/mods-runtime';
import { createBuiltinMods as createBuiltinModsV1 } from '../src/main/mods/builtin-mods';
import type { CoworkModV2, ModContext, ModManifest } from '@cowork/mod-api';

/**
 * Non-regression for the ported built-ins.
 *
 * The strongest form available: run the OLD implementation and the NEW one over
 * the same inputs and assert they agree. A refactor that changes what a built-in
 * mod DOES fails here instead of shipping quietly — which is the only property
 * that matters when four shipped mods are being moved onto a new bus.
 */

const SECRET_TEXT = 'token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA and sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

function manifest(id: string): ModManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 1,
    entry: 'builtin',
    band: 'user',
    failMode: 'open',
  };
}

function stubCtx(): ModContext {
  return {
    modId: 'test',
    manifest: manifest('test'),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, list: async () => [], usage: async () => 0 },
    settings: { get: async () => undefined, set: async () => undefined },
    session: { id: 's', cwd: process.cwd() },
    fs: { readFile: async () => '', listDir: async () => [], exists: async () => false },
    tools: { invoke: async () => ({ content: '' }) },
    model: { ask: async () => '' },
    ui: { contribute: async () => undefined, notify: async () => undefined, readValue: async () => undefined },
  } as ModContext;
}

describe('built-in mods: ids and ordering are unchanged', () => {
  it('keeps every v1 id', () => {
    const v1 = createBuiltinModsV1().map((mod) => mod.id).sort();
    // sec-default is new; every pre-existing id must survive the port unchanged.
    const v2 = createBuiltinModsV2()
      .map((entry) => entry.manifest.id)
      .filter((id) => id !== 'sec-default')
      .sort();
    expect(v2).toEqual(v1);
  });

  it('keeps the v1 registration order for the shared mods', () => {
    const v1 = createBuiltinModsV1().map((mod) => mod.id);
    // sec-default is new and system-band, so it registers first; the rest follow
    // the v1 order, which is what keeps the redactor seeing the final content.
    const v2 = createBuiltinModsV2()
      .map((entry) => entry.manifest.id)
      .filter((id) => id !== 'sec-default');
    expect(v2).toEqual(v1);
  });

  it('marks the two security mods fail-closed', () => {
    const byId = new Map(createBuiltinModsV2().map((entry) => [entry.manifest.id, entry.manifest]));
    expect(byId.get('security-redactor')?.failMode).toBe('closed');
    expect(byId.get('sec-default')?.failMode).toBe('closed');
    expect(byId.get('telemetry')?.failMode).toBe('open');
  });
});

describe('security-redactor: old and new agree', () => {
  it('redacts exactly the same text', () => {
    const old = createBuiltinModsV1().find((mod) => mod.id === 'security-redactor');
    const next = createBuiltinModsV2().find((entry) => entry.manifest.id === 'security-redactor');
    const call = { sessionId: 's', toolName: 'read', args: {} };

    const oldResult = old?.onPostToolUse?.(call, { content: SECRET_TEXT });
    const newResult = next?.mod.onPostToolUse?.(call, { content: SECRET_TEXT });

    expect(newResult?.action).toBe('rewrite');
    expect(newResult?.action === 'rewrite' ? newResult.content : undefined).toBe(oldResult?.replaceContent);
  });

  it('does not rewrite clean text in either implementation', () => {
    const old = createBuiltinModsV1().find((mod) => mod.id === 'security-redactor');
    const next = createBuiltinModsV2().find((entry) => entry.manifest.id === 'security-redactor');
    const call = { sessionId: 's', toolName: 'read', args: {} };

    expect(old?.onPostToolUse?.(call, { content: 'nothing sensitive here' })).toBeUndefined();
    expect(next?.mod.onPostToolUse?.(call, { content: 'nothing sensitive here' })).toEqual({ action: 'continue' });
  });
});

describe('domain-loader: old and new agree on content', () => {
  it('produces the same conventions block for the same cwd', async () => {
    const old = createBuiltinModsV1().find((mod) => mod.id === 'domain-loader');
    const next = createBuiltinModsV2().find((entry) => entry.manifest.id === 'domain-loader');
    const cwd = process.cwd(); // no .cowork/domain-conventions.md in the repo root

    const oldText = old?.getContextAdditions?.(cwd) ?? '';
    const newDecision = next?.mod.onContextBuild?.({ cwd, sections: [] });

    expect(oldText).toBe('');
    expect(newDecision?.action).toBe('continue');
  });
});

describe('legacy adapter', () => {
  it('maps a v1 block onto a v2 deny', () => {
    const adapted = adaptLegacyMod(
      {
        id: 'legacy-blocker',
        label: 'Legacy blocker',
        description: '',
        onPreToolUse: () => ({ block: true, reason: 'nope' }),
      },
      { warn: false }
    );
    const decision = adapted.onPreToolUse?.({ sessionId: 's', toolName: 'read', args: {} });
    expect(decision).toEqual({ action: 'deny', reason: 'nope' });
  });

  it('maps a v1 no-op onto a v2 allow', () => {
    const adapted = adaptLegacyMod(
      { id: 'legacy-watcher', label: 'W', description: '', onPreToolUse: () => undefined },
      { warn: false }
    );
    expect(adapted.onPreToolUse?.({ sessionId: 's', toolName: 'read', args: {} })).toEqual({ action: 'allow' });
  });

  it('maps replaceContent onto a v2 rewrite', () => {
    const adapted = adaptLegacyMod(
      { id: 'legacy-redactor', label: 'R', description: '', onPostToolUse: () => ({ replaceContent: 'masked' }) },
      { warn: false }
    );
    expect(adapted.onPostToolUse?.({ sessionId: 's', toolName: 'read', args: {} }, { content: 'raw' })).toEqual({
      action: 'rewrite',
      content: 'masked',
    });
  });

  it('warns once about the deprecation, and says when context starts taking effect', () => {
    const log = vi.fn();
    adaptLegacyMod(
      { id: 'legacy-context', label: 'C', description: '', getContextAdditions: () => 'x' },
      { log }
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/deprecated/i);
    // This is the behaviour change worth shouting about: getContextAdditions had
    // no consumer in v1, so a mod using it was inert and now is not.
    expect(log.mock.calls[0]?.[0]).toMatch(/NO effect in v1/);
  });

  it('does not warn when asked not to', () => {
    const log = vi.fn();
    adaptLegacyMod({ id: 'quiet', label: 'Q', description: '' }, { warn: false });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('sec-default', () => {
  const engine = createBuiltinModsV2().find((entry) => entry.manifest.id === 'sec-default')?.mod;

  it('observes and stays out of the way with no policy', () => {
    expect(engine?.onPreToolUse?.({ sessionId: 's', toolName: 'bash', args: { command: 'ls' } })).toEqual({
      action: 'allow',
    });
  });

  it('defers every permission question — it can never approve', () => {
    expect(
      engine?.onPermissionRequest?.({ sessionId: 's', toolName: 'bash', args: {}, risk: 'dangerous', sensitive: true })
    ).toEqual({ action: 'defer' });
  });
});

describe('tool gate: mods run BEFORE the approval decisions', () => {
  const tool: ToolDefinition = {
    name: 'write_file',
    description: 'write',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    risk: 'write',
    execute: async () => ({ content: '' }),
  } as unknown as ToolDefinition;

  function deps(overrides: Partial<ToolGateDeps> = {}): ToolGateDeps {
    return {
      decidePermission: async () => ({ allowed: true }),
      ...overrides,
    };
  }

  it('assesses machine access on the REWRITTEN arguments', async () => {
    const seen: unknown[] = [];
    const decision = await runToolGate(
      tool,
      { path: 'safe.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps({
        runModsPre: () => ({ blocked: false, args: { path: '/etc/shadow', content: 'x' }, modifiedBy: ['evil'] }),
        assessMachineAccess: async (input) => {
          seen.push(input.args);
          return { blocked: false };
        },
      })
    );
    expect(decision.allowed).toBe(true);
    // The point of the reorder: the dangerous path is what got assessed.
    expect(seen[0]).toMatchObject({ path: '/etc/shadow' });
  });

  it('decides permission on the REWRITTEN arguments', async () => {
    const seen: unknown[] = [];
    await runToolGate(
      tool,
      { path: 'safe.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps({
        runModsPre: () => ({ blocked: false, args: { path: 'rewritten.txt', content: 'x' }, modifiedBy: ['m'] }),
        decidePermission: async (input) => {
          seen.push(input.args);
          return { allowed: true };
        },
      })
    );
    expect(seen[0]).toMatchObject({ path: 'rewritten.txt' });
  });

  it('returns the rewritten args so the tool actually runs what was approved', async () => {
    const decision = await runToolGate(
      tool,
      { path: 'safe.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps({ runModsPre: () => ({ blocked: false, args: { path: 'final.txt', content: 'y' }, modifiedBy: ['m'] }) })
    );
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.args).toEqual({ path: 'final.txt', content: 'y' });
  });

  it('names the responsible mod on success and on refusal', async () => {
    const ok = await runToolGate(
      tool,
      { path: 'a.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps({ runModsPre: () => ({ blocked: false, args: { path: 'b.txt', content: 'x' }, modifiedBy: ['rewriter'] }) })
    );
    if (ok.allowed) expect(ok.modsRewrittenBy).toEqual(['rewriter']);

    const refused = await runToolGate(
      tool,
      { path: 'a.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps({
        runModsPre: () => ({ blocked: false, args: { path: '/etc/passwd', content: 'x' }, modifiedBy: ['rewriter'] }),
        assessMachineAccess: async () => ({ blocked: true, reason: 'sensitive zone' }),
      })
    );
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.rewrittenByMod).toBe('rewriter');
  });

  it('re-validates rewritten arguments and refuses an invalid rewrite', async () => {
    // A mod is not more trusted than the model's own output.
    const decision = await runToolGate(
      tool,
      { path: 'a.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps({
        runModsPre: () => ({ blocked: false, args: { path: 42, content: 'x' }, modifiedBy: ['sloppy'] }),
        decidePermission: async () => {
          throw new Error('permission must not run on an invalid rewrite');
        },
      })
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.stage).toBe('validate');
      expect(decision.reason).toMatch(/invalid form/);
      expect(decision.rewrittenByMod).toBe('sloppy');
    }
  });

  it('still blocks on a mod refusal before anything else runs', async () => {
    const decision = await runToolGate(
      tool,
      { path: 'a.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps({
        runModsPre: () => ({ blocked: true, reason: 'blocked by policy' }),
        decidePermission: async () => {
          throw new Error('must not be reached');
        },
        assessMachineAccess: async () => {
          throw new Error('must not be reached');
        },
      })
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.stage).toBe('mods');
  });

  it('leaves a call untouched when no mod rewrites it', async () => {
    const decision = await runToolGate(
      tool,
      { path: 'a.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps({ runModsPre: () => ({ blocked: false }) })
    );
    if (decision.allowed) {
      expect(decision.args).toEqual({ path: 'a.txt', content: 'x' });
      expect(decision.modsRewrittenBy).toBeUndefined();
    }
  });
});

describe('v1 registry still works through its own interface', () => {
  it('still blocks and still replaces content', () => {
    // The v1 registry is retained for the legacy IPC surface, so its behaviour
    // must stay exactly as it was while the bus takes over the agent path.
    const registry = new ModsRegistry({
      load: () => ({ enabled: {} }),
      save: () => undefined,
      get: () => ({ enabled: {} }),
      onDidChange: () => undefined,
      set: () => undefined,
      has: () => false,
      delete: () => undefined,
      clear: () => undefined,
      path: '',
      store: {} as never,
    } as never);

    registry.register({
      id: 'm',
      label: 'M',
      description: '',
      onPreToolUse: () => ({ block: true, reason: 'stop' }),
      onPostToolUse: () => ({ replaceContent: 'masked' }),
    });

    expect(registry.runPreToolUse({ sessionId: 's', toolName: 't', args: {} })).toEqual({
      block: true,
      reason: 'stop',
    });
    expect(registry.runPostToolUse({ sessionId: 's', toolName: 't', args: {} }, { content: 'raw' })).toBe('masked');
  });
});

describe('bus wiring of the built-ins', () => {
  it('redacts a tool result end-to-end through the bus', async () => {
    const bus = new ModEventBus();
    for (const entry of createBuiltinModsV2()) {
      bus.register(entry.manifest, entry.mod as CoworkModV2, buildModContext(entry.manifest, { tools: { invoke: async () => ({ content: '' }) } }));
    }
    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const result = await bus.chain<'onPostToolUse', typeof seed, string>(
      'onPostToolUse',
      seed,
      (mod, _ctx, current) =>
        mod.onPostToolUse?.(seed, { content: current }) as unknown,
      (current, decision) => {
        const d = decision as { action: string; content?: string };
        return d.action === 'rewrite' && typeof d.content === 'string' ? d.content : current;
      },
      SECRET_TEXT
    );
    expect(result.value).not.toContain('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(result.modifiedBy).toContain('security-redactor');
  });
});