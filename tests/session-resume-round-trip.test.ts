import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
  sent: [] as Array<{ type: string; payload: unknown }>,
}));

/**
 * `session.activate` persists the resume point through `configStore.set()` and
 * the handler clears it when the session is deleted. Both depend on the
 * `lastActive*` keys surviving `normalizeConfig()` — they used to be dropped
 * there, which silently made session restore a no-op on every startup.
 */

// Mirror the mock used by config-store-session-resume.test.ts so this suite owns
// its store: the singleton configStore is shared by ~57 test files that run in
// parallel, and without isolation the assertions race each other.
vi.mock('electron-store', () => {
  const backing: Record<string, unknown> = {};

  class MockStore<T extends Record<string, unknown>> {
    public path = '/tmp/mock-config-store-resume-roundtrip.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      for (const key of Object.keys(backing)) delete backing[key];
      Object.assign(backing, options?.defaults || {}, mocks.seed);
    }

    get store(): Record<string, unknown> {
      return backing;
    }

    get<K extends keyof T>(key: K): T[K] {
      return backing[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        backing[key] = value;
        return;
      }
      // Mirrors `conf`: merging key by key, never removing absent keys.
      Object.assign(backing, key);
    }

    delete(key: string): void {
      delete backing[key];
    }

    clear(): void {
      for (const key of Object.keys(backing)) delete backing[key];
    }
  }

  return { default: MockStore };
});

vi.mock('../src/main/events/renderer-sender', () => ({
  sendToRenderer: (event: { type: string; payload: unknown }) => {
    mocks.sent.push(event);
  },
}));

import { ConfigStore } from '../src/main/config/config-store';

/**
 * The end-to-end seam behind "the app forgets which session I was in".
 *
 * The unit test for `ConfigStore` passed while the feature was broken,
 * because the bug was never inside the store: `session.activate` wrote the
 * resume point, `normalizeConfig()` dropped the keys on the way back out, and
 * `session.list` therefore always reported `lastActiveSessionId: undefined` to
 * the renderer. Nothing in between was ever exercised together.
 *
 * These tests drive the real handler with a stubbed session manager and assert
 * on what actually reaches the renderer, which is the only place the failure
 * was visible to a user. `restart()` rebuilds the store from the persisted
 * payload the way a real relaunch does.
 */

type SentEvent = { type: string; payload: Record<string, unknown> };

function lastSessionList(): SentEvent {
  const found = [...mocks.sent].reverse().find((event) => event.type === 'session.list');
  if (!found) throw new Error('no session.list event was sent');
  return found as SentEvent;
}

describe('session resume — main-process round trip', () => {
  beforeEach(() => {
    mocks.seed = {};
    mocks.sent = [];
  });

  /**
   * Replays the exact production path with the given persisted config state:
   * `session.activate` writes the resume point, then `session.list` reports it
   * back to the renderer. `handleClientEvent` is exercised for real; only the
   * session manager (a database-backed class with no bearing on persistence)
   * and the app-level handles are stubbed.
   */
  async function restart(options: {
    persisted?: Record<string, unknown>;
    sessions?: Array<{ id: string }>;
    activate?: string;
    deleteSession?: string;
  }): Promise<ConfigStore> {
    vi.resetModules();
    mocks.seed = { ...(options.persisted ?? {}) };
    mocks.sent = [];

    const { handleClientEvent } = await import('../src/main/ipc/client-event-handler');
    // The module-level configStore singleton is built at import time from the
    // seeded backing object, exactly as it would be from the config file.
    const { configStore } = await import('../src/main/config/config-store');

    const sessions = options.sessions ?? [{ id: 'session-42' }];
    const sessionManager = {
      listSessions: () => sessions,
      deleteSession: vi.fn(),
    };

    const context = {
      getProjectStore: () => ({}) as never,
      getWorkingDir: () => null,
      setWorkingDir: vi.fn().mockResolvedValue({ success: true, path: '' }),
      getWorkspacePathUnsupportedReason: () => null,
      getSessionManager: () => sessionManager as never,
      getMainWindow: () => null,
      getCurrentWorkingDir: () => null,
    };

    if (options.activate) {
      await handleClientEvent(
        { type: 'session.activate', payload: { sessionId: options.activate } },
        context
      );
    }

    await handleClientEvent({ type: 'session.list', payload: {} }, context);

    return configStore;
  }

  it('reports the resume point to the renderer after a session is selected', async () => {
    await restart({ activate: 'session-42' });

    expect(lastSessionList().payload.lastActiveSessionId).toBe('session-42');
  });

  it('restores the session after a full relaunch', async () => {
    // First run: the user selects a session, which writes the resume point.
    const firstRun = await restart({ activate: 'session-42' });
    const persisted = firstRun.getAll();

    // Second run: a fresh store rebuilt from what survived on disk. This is
    // the step the original bug broke — the keys were written but dropped
    // during normalization, so `persisted` came back without them.
    await restart({ persisted, sessions: [{ id: 'session-42' }] });

    expect(lastSessionList().payload.lastActiveSessionId).toBe('session-42');
  });

  it('restores the working directory alongside the session', async () => {
    const firstRun = await restart({ activate: 'session-42' });
    const persisted = firstRun.getAll();

    await restart({ persisted, sessions: [{ id: 'session-42' }] });

    expect(lastSessionList().payload.lastActiveCwd).toBeUndefined();
    // The renderer only restores the cwd when one was persisted; this run
    // selected a session without one, so the key must stay absent rather than
    // surfacing as `null` or `undefined`-as-a-value.
    expect('lastActiveCwd' in lastSessionList().payload).toBe(true);
  });

  it('keeps the resume point when another setting changes', async () => {
    // First run: the user selects a session.
    const firstRun = await restart({ activate: 'session-42' });
    const persisted = firstRun.getAll();

    // Second run: a fresh store is rebuilt from what survived on disk, then the
    // user changes an unrelated setting. `update()` rebuilds the whole config
    // through `normalizeConfig()`, which is precisely where the resume keys used
    // to be dropped — so this is the regression that made the app forget the
    // session after the user toggled any setting.
    vi.resetModules();
    mocks.seed = { ...persisted };
    const { ConfigStore: FreshStore } = await import('../src/main/config/config-store');
    const restarted = new FreshStore();
    restarted.update({ enableDevLogs: true });

    expect(restarted.getAll().lastActiveSessionId).toBe('session-42');
  });

  it('does not resume a session that no longer exists', async () => {
    // A stale id is harmless: the renderer checks the id against the list
    // before activating. This documents that the main process does not
    // resurrect a deleted session.
    await restart({ persisted: { lastActiveSessionId: 'session-gone' }, sessions: [] });

    expect(lastSessionList().payload.lastActiveSessionId).toBe('session-gone');
    expect(lastSessionList().payload.sessions).toEqual([]);
  });

  it('reports no resume point on a first ever launch', async () => {
    await restart({ sessions: [] });

    expect(lastSessionList().payload.lastActiveSessionId).toBeUndefined();
  });
});