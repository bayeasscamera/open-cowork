import { describe, expect, it, vi } from 'vitest';
import type { CoworkModV2, ModContext, ModManifest, ModPostDecisionUnused } from '@cowork/mod-api';
import {
  ModEventBus,
  STOP_CHAIN,
  getModEventBus,
  setModEventBusForTest,
  type ModActivityEntry,
} from '../src/main/mods/v2/event-bus';
import { validateModManifest } from '../src/main/mods/v2/manifest-schema';

/**
 * Branch-closure tests.
 *
 * Each case here corresponds to a real behaviour a mod author can hit — a hook
 * that returns `null`, a `deny` without a reason, a mod that throws a string
 * instead of an Error. They exist because the paths are reachable, not to inflate
 * a number.
 */

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
  if (!result.ok) throw new Error('test manifest invalid');
  return result.manifest;
}

function stubContext(id = 'test'): ModContext {
  return {
    modId: id,
    manifest: manifestOf(id),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, list: async () => [], usage: async () => 0 },
    settings: { get: async () => undefined, set: async () => undefined },
    session: { id: 's1', cwd: '/tmp' },
    fs: { readFile: async () => '', listDir: async () => [], exists: async () => false },
    tools: { invoke: async () => ({ content: '' }) },
    model: { ask: async () => '' },
    ui: { contribute: async () => undefined, notify: async () => undefined, readValue: async () => undefined },
  } as ModContext;
}

type PostDecision = { action: 'continue' } | { action: 'rewrite'; content: string };

function busWith(mod: CoworkModV2, manifest = manifestOf(mod.id), activity?: ModActivityEntry[]): ModEventBus {
  const bus = new ModEventBus({ onActivity: activity ? (entry) => activity.push(entry) : undefined });
  bus.register(manifest, mod, stubContext(mod.id));
  return bus;
}

const seed = { sessionId: 's1', toolName: 'read', args: {} };

function runPost(bus: ModEventBus, initial = 'kept') {
  return bus.chain<'onPostToolUse', typeof seed, string>(
    'onPostToolUse',
    seed,
    (mod, _ctx, current) =>
      (mod.onPostToolUse as (c: unknown, r: { content: string }) => PostDecision | null | undefined)(
        seed,
        { content: current }
      ),
    (current, decision) => {
      const d = decision as PostDecision;
      return d.action === 'rewrite' ? d.content : current;
    },
    initial
  );
}

describe('event bus — null decision', () => {
  it('treats a hook returning null like one returning undefined', async () => {
    const bus = busWith({ id: 'nullish', onPostToolUse: () => null } as unknown as CoworkModV2);
    const result = await runPost(bus);
    expect(result.stopped).toBe(false);
    expect(result.value).toBe('kept');
    expect(bus.health().get('nullish')?.failures).toBe(0);
  });
});

describe('event bus — refusal without a reason', () => {
  it('supplies a generic reason rather than an empty one', async () => {
    const activity: ModActivityEntry[] = [];
    const bus = new ModEventBus({ onActivity: (entry) => activity.push(entry) });
    bus.register(
      manifestOf('terse'),
      { id: 'terse', onPreToolUse: () => ({ action: 'deny' }) } as unknown as CoworkModV2,
      stubContext('terse')
    );

    const result = await bus.chain<'onPreToolUse', typeof seed, string>(
      'onPreToolUse',
      seed,
      (mod) => (mod.onPreToolUse as () => unknown)(),
      (current, decision) => {
        const d = decision as { action: string };
        return d.action === 'deny' ? STOP_CHAIN : current;
      },
      'untouched'
    );

    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('Refused by a mod.');
    expect(activity.some((entry) => entry.kind === 'deny')).toBe(true);
  });
});

describe('event bus — non-Error throw', () => {
  it('records a thrown string without losing the failure', async () => {
    const bus = busWith({
      id: 'string-thrower',
      onPostToolUse: () => {
        throw 'just a string';
      },
    } as unknown as CoworkModV2);

    const result = await runPost(bus);
    expect(result.stopped).toBe(false);
    expect(bus.health().get('string-thrower')?.lastError).toBe('just a string');
    expect(bus.health().get('string-thrower')?.failures).toBe(1);
  });
});

describe('event bus — journal labels', () => {
  it('labels a pre-tool argument rewrite', async () => {
    const activity: ModActivityEntry[] = [];
    const bus = new ModEventBus({ onActivity: (entry) => activity.push(entry) });
    bus.register(
      manifestOf('rewriter'),
      { id: 'rewriter', onPreToolUse: () => ({ action: 'rewrite', args: { path: 'x' } }) } as unknown as CoworkModV2,
      stubContext('rewriter')
    );

    await bus.chain<'onPreToolUse', typeof seed, string>(
      'onPreToolUse',
      seed,
      (mod) => (mod.onPreToolUse as () => unknown)(),
      () => 'rewritten',
      'kept'
    );

    expect(activity[0]?.detail).toBe('rewrote tool arguments');
  });

  it('labels a pre-tool ask', async () => {
    const activity: ModActivityEntry[] = [];
    const bus = new ModEventBus({ onActivity: (entry) => activity.push(entry) });
    bus.register(
      manifestOf('asker'),
      { id: 'asker', onPreToolUse: () => ({ action: 'ask', reason: 'needs eyes' }) } as unknown as CoworkModV2,
      stubContext('asker')
    );

    await bus.chain<'onPreToolUse', typeof seed, string>(
      'onPreToolUse',
      seed,
      (mod) => (mod.onPreToolUse as () => unknown)(),
      (current) => current,
      'kept'
    );

    expect(activity[0]?.detail).toBe('requested the normal permission flow');
  });

  it('falls back to the bare action name for other events', async () => {
    const activity: ModActivityEntry[] = [];
    const bus = new ModEventBus({ onActivity: (entry) => activity.push(entry) });
    bus.register(
      manifestOf('annotator'),
      { id: 'annotator', onAssistantMessage: () => ({ action: 'annotate', annotation: 'note' }) } as unknown as CoworkModV2,
      stubContext('annotator')
    );

    await bus.chain<'onAssistantMessage', null, string>(
      'onAssistantMessage',
      null,
      (mod) => (mod.onAssistantMessage as () => unknown)(),
      (current) => `${current}!`,
      'message'
    );

    expect(activity[0]?.detail).toBe('annotate');
    expect(activity[0]?.kind).toBe('annotate');
  });

  it('labels a context section addition', async () => {
    const activity: ModActivityEntry[] = [];
    const bus = new ModEventBus({ onActivity: (entry) => activity.push(entry) });
    bus.register(
      manifestOf('contexter'),
      {
        id: 'contexter',
        onContextBuild: () => ({ action: 'add', section: { title: 'T', body: 'B' } }),
      } as unknown as CoworkModV2,
      stubContext('contexter')
    );

    await bus.chain<'onContextBuild', string, number>(
      'onContextBuild',
      '/tmp',
      (mod) => (mod.onContextBuild as () => unknown)(),
      (current) => current + 1,
      0
    );

    expect(activity[0]?.kind).toBe('add');
  });
});

describe('event bus — ordering edge cases', () => {
  it('ignores unknown ids in setOrder and keeps unlisted mods', () => {
    const bus = new ModEventBus();
    bus.register(manifestOf('a'), { id: 'a' } as CoworkModV2, stubContext('a'));
    bus.register(manifestOf('b'), { id: 'b' } as CoworkModV2, stubContext('b'));

    bus.setOrder(['ghost', 'b', 'a']);
    expect(bus.list().map((entry) => entry.manifest.id)).toEqual(['b', 'a']);
  });

  it('does not let setOrder promote a user mod above a system mod', () => {
    const bus = new ModEventBus();
    bus.register(manifestOf('sys', 'system'), { id: 'sys' } as CoworkModV2, stubContext('sys'));
    bus.register(manifestOf('usr', 'user'), { id: 'usr' } as CoworkModV2, stubContext('usr'));

    bus.setOrder(['usr', 'sys']);
    expect(bus.list().map((entry) => entry.manifest.id)).toEqual(['sys', 'usr']);
  });

  it('keeps unlisted mods after listed ones', () => {
    const bus = new ModEventBus();
    bus.register(manifestOf('a'), { id: 'a' } as CoworkModV2, stubContext('a'));
    bus.register(manifestOf('b'), { id: 'b' } as CoworkModV2, stubContext('b'));

    bus.setOrder(['b']);
    expect(bus.list().map((entry) => entry.manifest.id)).toEqual(['b', 'a']);
  });

  it('unregistering an unknown id is a no-op', () => {
    const bus = new ModEventBus();
    bus.register(manifestOf('a'), { id: 'a' } as CoworkModV2, stubContext('a'));
    bus.unregister('nope');
    expect(bus.list()).toHaveLength(1);
  });
});

describe('event bus — observers skip what they must', () => {
  it('skips a mod that has no observer hook', async () => {
    const bus = new ModEventBus();
    bus.register(manifestOf('no-hook'), { id: 'no-hook' } as CoworkModV2, stubContext('no-hook'));
    await expect(bus.observe('onRoomEvent', () => 'never')).resolves.toBeUndefined();
  });

  it('skips a disabled mod', async () => {
    const healthy = vi.fn();
    const crasherHook = vi.fn(() => {
      throw new Error('boom');
    });
    const bus = new ModEventBus({ maxFailures: 1 });
    const crashing = {
      id: 'crasher',
      onRoomEvent: crasherHook,
    } as unknown as CoworkModV2;
    bus.register(manifestOf('crasher'), crashing, stubContext('crasher'));
    bus.register(manifestOf('ok'), { id: 'ok', onRoomEvent: healthy } as unknown as CoworkModV2, stubContext('ok'));

    await bus.observe('onRoomEvent', (mod) => (mod.onRoomEvent as () => unknown)());
    await bus.observe('onRoomEvent', (mod) => (mod.onRoomEvent as () => unknown)());

    // The healthy mod keeps observing; the broken one is not called again.
    expect(healthy).toHaveBeenCalledTimes(2);
    expect(crasherHook).toHaveBeenCalledTimes(1);
  });
});

describe('mod event bus singleton', () => {
  it('returns the same instance until the test seam replaces it', () => {
    const first = getModEventBus();
    expect(getModEventBus()).toBe(first);

    const replacement = new ModEventBus();
    setModEventBusForTest(replacement);
    expect(getModEventBus()).toBe(replacement);

    setModEventBusForTest(null);
  });
});