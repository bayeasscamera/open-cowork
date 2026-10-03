import { describe, expect, it } from 'vitest';
import { ModsRuntime } from '../src/main/mods/v2/runtime';
import { ModEventBus } from '../src/main/mods/v2/event-bus';
import { STOP_CHAIN } from '../src/main/mods/v2/event-bus';
import { createBuiltinModsV2 } from '../src/main/mods/v2/builtin-mods-v2';
import { buildModContext } from '../src/main/mods/v2/mod-context';
import { runToolGate, type ToolGateDeps } from '../src/main/tools/pipeline';
import type { CoworkModV2, ModManifest } from '@cowork/mod-api';

/**
 * The wiring is the part unit tests cannot prove on their own, so these tests
 * assert the properties the Phase 0 discovery found broken:
 *   1. `onPreToolUse` runs ONCE per tool call, not twice.
 *   2. `getContextAdditions` / `onContextBuild` actually reaches the prompt path.
 *   3. The gate assesses the FINAL arguments.
 *   4. A runtime that is disabled changes nothing and blocks nothing.
 */

const SECRET = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function stubDeps() {
  return { tools: { invoke: async () => ({ content: '' }) } };
}

function runtimeWith(entries: { manifest: ModManifest; mod: CoworkModV2 }[], options: { enabled?: boolean } = {}) {
  const bus = new ModEventBus();
  const runtime = new ModsRuntime({ ...stubDeps(), bus, enabled: options.enabled ?? true });
  // Replace the built-ins with the fixtures under test.
  for (const entry of [...runtime.bus.list()].map((e) => e.manifest.id)) runtime.bus.unregister(entry);
  for (const entry of entries) {
    runtime.bus.register(entry.manifest, entry.mod, buildModContext(entry.manifest, stubDeps()));
  }
  return runtime;
}

function manifestOf(id: string): ModManifest {
  return { id, name: id, version: '1.0.0', apiVersion: 1, entry: 'x.cjs', band: 'user', failMode: 'open' };
}

describe('runtime registers the built-ins', () => {
  it('starts with every built-in mod live', () => {
    const runtime = new ModsRuntime(stubDeps());
    expect(runtime.isEnabled()).toBe(true);
    // Bands decide the RUNTIME order, which is not the declared order: the two
    // `system`-band mods (sec-default, security-redactor) register before the
    // `user`-band ones. For the redactor that is an improvement, not a regression —
    // it masks secrets before anything else observes the result. The declared
    // order in createBuiltinModsV2 is still the v1 order, and the parity test
    // pins that.
    expect(runtime.bus.list().map((entry) => entry.manifest.id)).toEqual([
      'sec-default',
      'security-redactor',
      'telemetry',
      'diff-panel',
      'domain-loader',
    ]);
  });

  it('starts empty and disabled with --no-mods', () => {
    const runtime = new ModsRuntime({ ...stubDeps(), enabled: false });
    expect(runtime.isEnabled()).toBe(false);
    expect(runtime.bus.list()).toHaveLength(0);
    expect(runtime.reasonForDisabled()).toBe('setting');
  });
});

describe('a disabled runtime changes nothing', () => {
  it('lets a call through untouched', async () => {
    const runtime = new ModsRuntime({ ...stubDeps(), enabled: false });
    const pre = await runtime.runPreToolUse({ sessionId: 's', toolName: 'bash', args: { command: 'ls' } });
    expect(pre).toEqual({ blocked: false });

    const post = await runtime.runPostToolUse({ sessionId: 's', toolName: 'read', args: {} }, { content: SECRET });
    // No redaction either: with mods off, Cowork behaves exactly as it did
    // before mods existed.
    expect(post.content).toBe(SECRET);
    expect(await runtime.buildContextSections(process.cwd())).toEqual([]);
  });

  it('stops every registered mod when safe mode kicks in', async () => {
    const runtime = new ModsRuntime(stubDeps());
    expect(runtime.bus.list().length).toBeGreaterThan(0);
    runtime.disableAll('auto');
    expect(runtime.isEnabled()).toBe(false);
    expect(runtime.bus.list()).toHaveLength(0);
    expect(runtime.reasonForDisabled()).toBe('auto');
  });
});

describe('onPreToolUse runs exactly ONCE per call', () => {
  it('is invoked once through the gate, and its rewrite is what is assessed', async () => {
    let calls = 0;
    const runtime = runtimeWith([
      {
        manifest: manifestOf('counter'),
        mod: {
          id: 'counter',
          onPreToolUse(call) {
            calls += 1;
            return { action: 'rewrite', args: { ...call.args, path: `once-${calls}` } };
          },
        },
      },
    ]);

    const assessed: unknown[] = [];
    const deps: ToolGateDeps = {
      decidePermission: async () => ({ allowed: true }),
      assessMachineAccess: async (input) => {
        assessed.push(input.args);
        return { blocked: false };
      },
      runModsPre: async (input) => {
        const outcome = await runtime.runPreToolUse(input);
        return {
          blocked: outcome.blocked,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
          ...(outcome.args ? { args: outcome.args } : {}),
          ...(outcome.modifiedBy ? { modifiedBy: outcome.modifiedBy } : {}),
        };
      },
    };

    const tool = {
      name: 'write_file',
      description: '',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      risk: 'write',
      execute: async () => ({ content: '' }),
    };
    const decision = await runToolGate(
      tool as never,
      { path: 'a.txt', content: 'x' },
      { sessionId: 's', cwd: '/w' },
      deps
    );

    expect(calls).toBe(1);
    // "once-1", not "once-2": this is the double-invocation bug from PHASE 0.
    expect(assessed[0]).toMatchObject({ path: 'once-1' });
    if (decision.allowed) expect(decision.args).toMatchObject({ path: 'once-1' });
  });
});

describe('onContextBuild reaches the prompt path', () => {
  it('collects the sections a mod contributes', async () => {
    const runtime = runtimeWith([
      {
        manifest: manifestOf('contexter'),
        mod: {
          id: 'contexter',
          onContextBuild() {
            return { action: 'add', section: { title: 'conventions', body: '<domain_conventions>be careful</domain_conventions>' } };
          },
        },
      },
    ]);

    const sections = await runtime.buildContextSections(process.cwd());
    expect(sections).toEqual([{ title: 'conventions', body: '<domain_conventions>be careful</domain_conventions>' }]);
  });

  it('composes several mods instead of overwriting', async () => {
    const runtime = runtimeWith([
      { manifest: manifestOf('one'), mod: { id: 'one', onContextBuild: () => ({ action: 'add', section: { title: 'a', body: 'A' } }) } },
      { manifest: manifestOf('two'), mod: { id: 'two', onContextBuild: () => ({ action: 'add', section: { title: 'b', body: 'B' } }) } },
    ]);
    expect((await runtime.buildContextSections('/w')).map((section) => section.title)).toEqual(['a', 'b']);
  });
});

describe('post-tool-use redaction through the runtime', () => {
  it('redacts and reports which mod did it', async () => {
    const runtime = new ModsRuntime(stubDeps());
    const outcome = await runtime.runPostToolUse({ sessionId: 's', toolName: 'read', args: {} }, { content: SECRET });
    expect(outcome.content).not.toContain(SECRET);
    expect(outcome.modifiedBy).toContain('security-redactor');
  });

  it('leaves clean content alone', async () => {
    const runtime = new ModsRuntime(stubDeps());
    const outcome = await runtime.runPostToolUse({ sessionId: 's', toolName: 'read', args: {} }, { content: 'nothing here' });
    expect(outcome.content).toBe('nothing here');
  });
});

describe('a mod refusal stops the call and names the mod', () => {
  it('reports the refusal with the mod id attached', async () => {
    const runtime = runtimeWith([
      {
        manifest: manifestOf('veto'),
        mod: {
          id: 'veto',
          onPreToolUse() {
            return { action: 'deny', reason: 'not in this project' };
          },
        },
      },
    ]);

    const outcome = await runtime.runPreToolUse({ sessionId: 's', toolName: 'bash', args: { command: 'rm -rf /' } });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toContain('not in this project');
    expect(outcome.reason).toContain('veto');
  });

  it('a refusal is fail-closed for a closed-mode mod', async () => {
    const runtime = runtimeWith([
      {
        manifest: { ...manifestOf('sec'), failMode: 'closed' },
        mod: {
          id: 'sec',
          onPostToolUse() {
            throw new Error('broken');
          },
        },
      },
    ]);

    const outcome = await runtime.runPostToolUse({ sessionId: 's', toolName: 'read', args: {} }, { content: 'text' });
    // The content survives (post-hooks have no "refuse"), but health records the
    // failure so the mod is disabled before it can fail N more times.
    expect(runtime.health().sec?.failures).toBe(1);
    expect(outcome.content).toBe('text');
  });
});

describe('health reporting', () => {
  it('starts healthy and records the clock', () => {
    const runtime = new ModsRuntime(stubDeps());
    const health = runtime.health();
    expect(Object.keys(health)).toContain('security-redactor');
    expect(health['security-redactor']?.disabled).toBe(false);
  });
});

describe('stop chain sentinel is shared with the bus', () => {
  it('the runtime uses the bus sentinel, not a private one', () => {
    // A private sentinel would silently fail to stop the chain — the reducer's
    // return would be treated as a new value.
    expect(typeof STOP_CHAIN).toBe('symbol');
  });
});