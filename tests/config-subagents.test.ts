import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-subagents.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
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

import { normalizeSubAgentsConfig } from '../src/main/config/config-store';

describe('sub-agents config normalization', () => {
  it('defaults to inheriting the active profile with sane guardrails', () => {
    expect(normalizeSubAgentsConfig(undefined)).toEqual({
      configSetId: '',
      perRole: {},
      timeoutMs: 120_000,
      maxConcurrent: 2,
    });
  });

  it('clamps the timeout between 10s and 300s', () => {
    expect(normalizeSubAgentsConfig({ timeoutMs: 1 }).timeoutMs).toBe(10_000);
    expect(normalizeSubAgentsConfig({ timeoutMs: 9_999_999 }).timeoutMs).toBe(300_000);
    expect(normalizeSubAgentsConfig({ timeoutMs: 'nope' as unknown as number }).timeoutMs).toBe(
      120_000
    );
  });

  it('clamps concurrency between 1 and 8', () => {
    expect(normalizeSubAgentsConfig({ maxConcurrent: 0 }).maxConcurrent).toBe(1);
    expect(normalizeSubAgentsConfig({ maxConcurrent: 99 }).maxConcurrent).toBe(8);
  });

  it('keeps only valid role keys with non-empty trimmed ids', () => {
    const normalized = normalizeSubAgentsConfig({
      configSetId: '  cheap  ',
      perRole: {
        reviewer: ' role-set ',
        developer: '   ',
        bogus: 'whatever',
      } as unknown as Parameters<typeof normalizeSubAgentsConfig>[0],
    });
    expect(normalized.configSetId).toBe('cheap');
    expect(normalized.perRole).toEqual({ reviewer: 'role-set' });
  });
});