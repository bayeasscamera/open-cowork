import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
}));

// Mirror the mock used by config-store-config-sets.test.ts so this suite owns
// its store: the singleton configStore is shared by ~57 test files that run in
// parallel, and without isolation the assertions race each other. Every mock
// instance shares one backing object — the module-level singleton is built at
// import time, before beforeEach runs.
vi.mock('electron-store', () => {
  const backing: Record<string, unknown> = {};

  class MockStore<T extends Record<string, unknown>> {
    public path = '/tmp/mock-config-store-session-resume.json';

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

import { ConfigStore } from '../src/main/config/config-store';

/**
 * `session.activate` persists the resume point through `configStore.set()` and
 * the handler clears it when the session is deleted. Both depend on the
 * `lastActive*` keys surviving `normalizeConfig()` — they used to be dropped
 * there, which silently made session restore a no-op on every startup.
 */
describe('ConfigStore — session resume keys', () => {
  let store: ConfigStore;

  beforeEach(() => {
    mocks.seed = {};
    store = new ConfigStore();
  });

  it('persists the resume point written by session.activate', () => {
    store.set('lastActiveSessionId', 'session-42');
    store.set('lastActiveCwd', '/tmp/project');
    store.set('lastActiveSessionUpdatedAt', 1234567890);

    const stored = store.getAll();
    expect(stored.lastActiveSessionId).toBe('session-42');
    expect(stored.lastActiveCwd).toBe('/tmp/project');
    expect(stored.lastActiveSessionUpdatedAt).toBe(1234567890);
  });

  it('leaves the resume point untouched when other settings change', () => {
    store.set('lastActiveSessionId', 'session-42');

    store.update({ enableDevLogs: true });

    expect(store.getAll().lastActiveSessionId).toBe('session-42');
  });

  it('survives a full restart round-trip (seeded from persisted state)', () => {
    store.set('lastActiveSessionId', 'session-42');
    mocks.seed = { lastActiveSessionId: 'session-42', lastActiveCwd: '/tmp/project' };

    const restarted = new ConfigStore();

    expect(restarted.getAll().lastActiveSessionId).toBe('session-42');
    expect(restarted.getAll().lastActiveCwd).toBe('/tmp/project');
  });

  it('clears the resume point when the active session is deleted', () => {
    store.set('lastActiveSessionId', 'session-42');
    store.set('lastActiveCwd', '/tmp/project');

    store.clearSessionResumePoint();

    const stored = store.getAll();
    expect(stored.lastActiveSessionId).toBeUndefined();
    expect(stored.lastActiveCwd).toBeUndefined();
    expect(stored.lastActiveSessionUpdatedAt).toBeUndefined();
  });
});
