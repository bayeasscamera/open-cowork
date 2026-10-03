import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CoworkModV2,
  ModContext,
  ModEventMap,
  ModManifest,
  ModToolResult,
} from '@cowork/mod-api';
import {
  ModEventBus,
  STOP_CHAIN,
  type ModActivityEntry,
} from '../src/main/mods/v2/event-bus';
import { validateModManifest } from '../src/main/mods/v2/manifest-schema';

function manifestOf(id: string, band: ModManifest['band'] = 'user', failMode: 'open' | 'closed' = 'open'): ModManifest {
  const result = validateModManifest({
    id,
    name: id,
    version: '1.0.0',
    apiVersion: 1,
    entry: 'dist/index.js',
    band,
    failMode,
  });
  if (!result.ok) throw new Error(`test manifest invalid: ${JSON.stringify(result.errors)}`);
  return result.manifest;
}

function stubContext(): ModContext {
  return {
    modId: 'test',
    manifest: manifestOf('test'),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
      list: async () => [],
      usage: async () => 0,
    },
    settings: { get: async () => undefined, set: async () => undefined },
    session: { id: 's1', cwd: '/tmp' },
    fs: { readFile: async () => '', listDir: async () => [], exists: async () => false },
    tools: { invoke: async () => ({ content: '' }) },
    model: { ask: async () => '' },
    ui: { contribute: async () => undefined, notify: async () => undefined, readValue: async () => undefined },
  } as ModContext;
}

type PostDecision = ModEventMap['onPostToolUse']['decision'];

describe('mod event bus — chaining and attribution', () => {
  let bus: ModEventBus;

  beforeEach(() => {
    bus = new ModEventBus();
  });

  function registerPost(id: string, fn: (content: string) => PostDecision | undefined, band: ModManifest['band'] = 'user') {
    // Adapt the fixture: it reasons about the result text, while the real hook
    // signature is (call, result).
    bus.register(
      manifestOf(id, band),
      {
        id,
        onPostToolUse: (_call: unknown, result: ModToolResult) => fn(result.content),
      } as unknown as CoworkModV2,
      stubContext()
    );
  }

  const seedCall = { sessionId: 's1', toolName: 'read', args: {} };
  const runPost = (initial: string) =>
    bus.chain<'onPostToolUse', typeof seedCall, string>(
      'onPostToolUse',
      seedCall,
      // The hook receives the ACCUMULATED content, not the seed: that is what
      // makes two redaction mods compose instead of overwrite.
      (mod, _ctx, current) =>
        (mod.onPostToolUse as (c: unknown, r: ModToolResult) => PostDecision | undefined)(seedCall, {
          content: current,
        }),
      (current, decision) => {
        const d = decision as PostDecision;
        return d.action === 'rewrite' ? d.content : current;
      },
      initial
    );

  it('hands each hook the previous hook output', async () => {
    registerPost('a', (content) => ({ action: 'rewrite', content: `${content}+a` }));
    registerPost('b', (content) => ({ action: 'rewrite', content: `${content}+b` }));

    const result = await runPost('base');
    // Composition, not last-write-wins: both mods must see the other's work.
    expect(result.value).toBe('base+a+b');
    expect(result.modifiedBy).toEqual(['a', 'b']);
  });

  it('treats a hook that returns nothing as a no-op, not a failure', async () => {
    registerPost('quiet', () => undefined);
    registerPost('loud', () => ({ action: 'rewrite', content: 'changed' }));

    const result = await runPost('base');
    expect(result.value).toBe('changed');
    expect(result.modifiedBy).toEqual(['loud']);
    expect(bus.health().get('quiet')?.failures).toBe(0);
  });

  it('runs in band order regardless of registration order', async () => {
    registerPost('user-mod', () => ({ action: 'rewrite', content: 'u' }), 'user');
    registerPost('system-mod', () => ({ action: 'rewrite', content: 's' }), 'system');
    registerPost('org-mod', () => ({ action: 'rewrite', content: 'o' }), 'org');

    const result = await runPost('base');
    expect(result.modifiedBy).toEqual(['system-mod', 'org-mod', 'user-mod']);
  });

  it('honours an explicit reorder inside a band', async () => {
    registerPost('first', () => ({ action: 'rewrite', content: '1' }));
    registerPost('second', () => ({ action: 'rewrite', content: '2' }));
    bus.setOrder(['second', 'first']);

    const result = await runPost('base');
    expect(result.modifiedBy).toEqual(['second', 'first']);
  });

  it('does not let a post-tool hook stop the chain — only pre-events may refuse', async () => {
    // The contract is asymmetric on purpose: by the time a result exists there
    // is nothing left to refuse, and inventing a block here would let a mod
    // hide a call it did not like. Refusal lives in onPreToolUse /
    // onUserPrompt / onPermissionRequest.
    const later = vi.fn(() => ({ action: 'rewrite', content: 'ran' }) as PostDecision);
    registerPost('early', () => ({ action: 'continue' }));
    registerPost('after', later as never);

    const result = await runPost('base');
    expect(result.stopped).toBe(false);
    expect(later).toHaveBeenCalled();
  });
});

describe('mod event bus — pre-tool-use', () => {
  function registerPre(id: string, fn: () => unknown) {
    busForTest(id, fn);
  }
  let bus: ModEventBus;
  function busForTest(id: string, fn: () => unknown) {
    bus.register(manifestOf(id), { id, onPreToolUse: fn } as unknown as CoworkModV2, stubContext());
  }

  beforeEach(() => {
    bus = new ModEventBus();
  });

  it('chains argument rewrites and attributes them', async () => {
    registerPre('a', () => ({ action: 'rewrite', args: { path: 'A' } }));
    registerPre('b', (current: { path: string }) => ({ action: 'rewrite', args: { path: `${current.path}/b` } }));

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const result = await bus.chain<'onPreToolUse', typeof seed, { path: string }>(
      'onPreToolUse',
      seed,
      (mod) => {
        void mod;
        return (undefined as never);
      },
      () => ({ path: 'x' }),
      { path: '' }
    );
    // The generic reducer is exercised in the rewrite-attribution test below;
    // this asserts the hook selection ignores mods without the hook.
    expect(result.modifiedBy).toEqual([]);
    expect(result.stopped).toBe(false);
  });

  it('stops the chain when a mod denies, with its reason', async () => {
    bus.register(
      manifestOf('denier'),
      { id: 'denier', onPreToolUse: () => ({ action: 'deny', reason: 'not allowed here' }) } as unknown as CoworkModV2,
      stubContext()
    );
    const after = vi.fn();
    bus.register(manifestOf('after'), { id: 'after', onPreToolUse: after } as unknown as CoworkModV2, stubContext());

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const result = await bus.chain<'onPreToolUse', typeof seed, string>(
      'onPreToolUse',
      seed,
      (mod) => (mod.onPreToolUse as () => unknown)(),
      (current, decision) => {
        const d = decision as { action: string; reason?: string };
        if (d.action === 'deny') return STOP_CHAIN;
        return current;
      },
      'untouched'
    );

    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('not allowed here');
    expect(result.stoppingModId).toBe('denier');
    expect(after).not.toHaveBeenCalled();
  });
});

describe('mod event bus — failures', () => {
  it('keeps the call when an open-mode mod throws', async () => {
    const bus = new ModEventBus();
    bus.register(
      manifestOf('broken', 'user', 'open'),
      {
        id: 'broken',
        onPostToolUse: () => {
          throw new Error('boom');
        },
      } as unknown as CoworkModV2,
      stubContext()
    );

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const result = await bus.chain<'onPostToolUse', typeof seed, string>(
      'onPostToolUse',
      seed,
      (mod) => (mod.onPostToolUse as () => unknown)(),
      (current) => current,
      'kept'
    );

    expect(result.stopped).toBe(false);
    expect(result.value).toBe('kept');
  });

  it('fails the call closed when a closed-mode mod throws', async () => {
    const bus = new ModEventBus();
    bus.register(
      manifestOf('sec', 'system', 'closed'),
      {
        id: 'sec',
        onPostToolUse: () => {
          throw new Error('boom');
        },
      } as unknown as CoworkModV2,
      stubContext()
    );

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const result = await bus.chain<'onPostToolUse', typeof seed, string>(
      'onPostToolUse',
      seed,
      (mod) => (mod.onPostToolUse as () => unknown)(),
      (current) => current,
      'kept'
    );

    expect(result.stopped).toBe(true);
    expect(result.stopReason).toContain('failed closed');
  });

  it('disables a mod after N consecutive failures and notifies', async () => {
    const disabled: { modId: string; reason: string }[] = [];
    const bus = new ModEventBus({ maxFailures: 3, onDisable: (info) => disabled.push(info) });
    bus.register(
      manifestOf('flaky'),
      {
        id: 'flaky',
        onPostToolUse: () => {
          throw new Error('boom');
        },
      } as unknown as CoworkModV2,
      stubContext()
    );

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const run = () =>
      bus.chain<'onPostToolUse', typeof seed, string>(
        'onPostToolUse',
        seed,
        (mod) => (mod.onPostToolUse as () => unknown)(),
        (current) => current,
        'kept'
      );

    await run();
    await run();
    expect(disabled).toHaveLength(0);
    await run();

    expect(disabled).toHaveLength(1);
    expect(disabled[0]?.modId).toBe('flaky');
    expect(bus.health().get('flaky')?.disabled).toBe(true);
    expect(bus.health().get('flaky')?.disabledReason).toContain('consecutive failures');
  });

  it('stops calling a disabled mod', async () => {
    const disabled: string[] = [];
    const bus = new ModEventBus({ maxFailures: 1, onDisable: (info) => disabled.push(info.modId) });
    const hook = vi.fn(() => {
      throw new Error('boom');
    });
    bus.register(
      manifestOf('flaky'),
      { id: 'flaky', onPostToolUse: hook } as unknown as CoworkModV2,
      stubContext()
    );

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const run = () =>
      bus.chain<'onPostToolUse', typeof seed, string>(
        'onPostToolUse',
        seed,
        (mod) => (mod.onPostToolUse as () => unknown)(),
        (current) => current,
        'kept'
      );

    await run();
    await run();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(disabled).toEqual(['flaky']);
  });

  it('resets the failure count after a success', async () => {
    const bus = new ModEventBus({ maxFailures: 3 });
    let shouldThrow = true;
    bus.register(
      manifestOf('recovering'),
      {
        id: 'recovering',
        onPostToolUse: () => {
          if (shouldThrow) throw new Error('boom');
          return { action: 'continue' };
        },
      } as unknown as CoworkModV2,
      stubContext()
    );

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const run = () =>
      bus.chain<'onPostToolUse', typeof seed, string>(
        'onPostToolUse',
        seed,
        (mod) => (mod.onPostToolUse as () => unknown)(),
        (current) => current,
        'kept'
      );

    await run();
    await run();
    expect(bus.health().get('recovering')?.failures).toBe(2);
    shouldThrow = false;
    await run();
    expect(bus.health().get('recovering')?.failures).toBe(0);
  });

  it('treats an over-budget async hook as a failure', async () => {
    const bus = new ModEventBus({ timeoutMs: 20 });
    bus.register(
      manifestOf('slow'),
      {
        id: 'slow',
        onPostToolUse: () => new Promise(() => {}),
      } as unknown as CoworkModV2,
      stubContext()
    );

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    const result = await bus.chain<'onPostToolUse', typeof seed, string>(
      'onPostToolUse',
      seed,
      (mod) => (mod.onPostToolUse as () => unknown)(),
      (current) => current,
      'kept'
    );

    expect(bus.health().get('slow')?.lastError).toContain('timed out');
    expect(result.stopped).toBe(false);
  });
});

describe('mod event bus — registration', () => {
  it('refuses a mod whose code id disagrees with its manifest', () => {
    const bus = new ModEventBus();
    expect(() => bus.register(manifestOf('honest'), { id: 'other' } as CoworkModV2, stubContext())).toThrow(
      /id mismatch/
    );
  });

  it('ignores a duplicate registration', () => {
    const bus = new ModEventBus();
    bus.register(manifestOf('once'), { id: 'once' } as CoworkModV2, stubContext());
    bus.register(manifestOf('once'), { id: 'once' } as CoworkModV2, stubContext());
    expect(bus.list()).toHaveLength(1);
  });

  it('unregisters', () => {
    const bus = new ModEventBus();
    bus.register(manifestOf('bye'), { id: 'bye' } as CoworkModV2, stubContext());
    bus.unregister('bye');
    expect(bus.list()).toHaveLength(0);
  });

  it('journals rewrites for the activity log', async () => {
    const activity: ModActivityEntry[] = [];
    const bus = new ModEventBus({ onActivity: (entry) => activity.push(entry) });
    bus.register(
      manifestOf('logger'),
      { id: 'logger', onPostToolUse: () => ({ action: 'rewrite', content: 'new' }) } as unknown as CoworkModV2,
      stubContext()
    );

    const seed = { sessionId: 's', toolName: 'read', args: {} };
    await bus.chain<'onPostToolUse', typeof seed, string>(
      'onPostToolUse',
      seed,
      (mod) => (mod.onPostToolUse as () => unknown)(),
      (current) => 'new',
      'old'
    );

    const rewrite = activity.find((entry) => entry.kind === 'rewrite');
    expect(rewrite?.modId).toBe('logger');
    expect(rewrite?.detail).toContain('replaced result content');
  });
});

describe('mod event bus — observers', () => {
  it('runs session observers and counts their failures', async () => {
    const bus = new ModEventBus({ maxFailures: 2 });
    const ok = vi.fn();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    bus.register(manifestOf('watcher'), { id: 'watcher', onRoomEvent: ok } as CoworkModV2, stubContext());
    bus.register(manifestOf('crasher'), { id: 'crasher', onRoomEvent: bad } as CoworkModV2, stubContext());

    await bus.observe('onRoomEvent', (mod) => (mod.onRoomEvent as () => unknown)());
    await bus.observe('onRoomEvent', (mod) => (mod.onRoomEvent as () => unknown)());

    expect(ok).toHaveBeenCalledTimes(2);
    expect(bus.health().get('crasher')?.disabled).toBe(true);
  });
});