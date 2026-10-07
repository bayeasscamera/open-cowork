import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A key file that cannot be decoded must never cost the user their config.
 *
 * `config.json` is encrypted with the per-installation keyring key. When that
 * key cannot be read — a re-signed build whose keychain entry is denied, a
 * login keychain still locked after the machine slept — the store used to be
 * opened anyway, fail to decrypt with every available key, move `config.json`
 * aside and restart from defaults. Every configured provider went with it.
 *
 * These tests pin the replacement: the session runs on a throwaway directory
 * and the real store location is never touched.
 */
const mocks = vi.hoisted(() => {
  class StoreKeyUnreadableError extends Error {
    readonly keyPath: string;

    constructor(keyPath: string, reason: string) {
      super(`Store encryption key is present but unreadable (${reason}): ${keyPath}`);
      this.name = 'StoreKeyUnreadableError';
      this.keyPath = keyPath;
    }
  }

  return {
    StoreKeyUnreadableError,
    mode: 'unreadable' as 'unreadable' | 'readable',
    capturedOptions: [] as Array<Record<string, unknown>>,
    logError: vi.fn(),
  };
});

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      mocks.capturedOptions.push(options as Record<string, unknown>);
      this.store = { ...(options?.defaults || {}) };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = { ...this.store, ...key };
    }

    clear(): void {
      this.store = {};
    }
  }

  return { default: MockStore };
});

vi.mock('../src/main/utils/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/utils/logger')>();
  return { ...actual, log: vi.fn(), logWarn: vi.fn(), logError: mocks.logError };
});

vi.mock('../src/main/utils/store-key-manager', () => ({
  StoreKeyUnreadableError: mocks.StoreKeyUnreadableError,
  resolveStoreEncryptionKey: () => {
    if (mocks.mode === 'unreadable') {
      throw new mocks.StoreKeyUnreadableError(
        '/Users/someone/Library/Application Support/open-cowork/keyring/encryption-key.bin',
        'the OS keyring rejected it'
      );
    }
    return 'test-key';
  },
}));

import { ConfigStore } from '../src/main/config/config-store';

describe('ConfigStore with an unreadable store key', () => {
  beforeEach(() => {
    mocks.capturedOptions.length = 0;
    mocks.logError.mockClear();
  });

  it('opens a throwaway store instead of the real one, and says so', () => {
    mocks.mode = 'unreadable';

    new ConfigStore();

    expect(mocks.capturedOptions).toHaveLength(1);
    const cwd = mocks.capturedOptions[0].cwd;
    expect(typeof cwd).toBe('string');
    // Never the user's real config directory: pointing electron-store there is
    // exactly what replaced their config with defaults.
    expect(cwd).toContain('cowork-config-unreadable-key-');
    expect(cwd).not.toContain('Application Support');
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it('uses the real store location when the key resolves', () => {
    mocks.mode = 'readable';

    new ConfigStore();

    expect(mocks.capturedOptions).toHaveLength(1);
    expect(mocks.capturedOptions[0].cwd).toBeUndefined();
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
