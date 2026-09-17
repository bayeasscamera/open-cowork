import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
        ...mocks.seed,
      };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = {
        ...this.store,
        ...key,
      };
    }

    clear(): void {
      this.store = {};
    }
  }

  return {
    default: MockStore,
  };
});

import { ConfigStore } from '../src/main/config/config-store';

describe('ConfigStore personalization (coworkInstructions)', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('defaults coworkInstructions to an empty string', () => {
    const store = new ConfigStore();
    expect(store.getAll().coworkInstructions).toBe('');
    expect(store.get('coworkInstructions')).toBe('');
  });

  it('persists coworkInstructions via update()', () => {
    const store = new ConfigStore();
    store.update({ coworkInstructions: 'Answer in French.' });
    expect(store.getAll().coworkInstructions).toBe('Answer in French.');
  });

  it('coerces non-string coworkInstructions back to the default', () => {
    mocks.seed = { coworkInstructions: 42 };
    const store = new ConfigStore();
    expect(store.getAll().coworkInstructions).toBe('');
  });

  it('preserves coworkInstructions across unrelated updates', () => {
    const store = new ConfigStore();
    store.update({ coworkInstructions: 'Be concise.' });
    store.update({ theme: 'dark' });
    expect(store.getAll().coworkInstructions).toBe('Be concise.');
    expect(store.getAll().theme).toBe('dark');
  });
});
