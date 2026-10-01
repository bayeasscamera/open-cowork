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

  describe('semantic verification (Chantier 2 opt-in)', () => {
    it('is OFF by default — the type-check pass is expensive', () => {
      // The key is OMITTED rather than set to false, so a store round-trip
      // through the UI does not gain a field the user never set.
      expect(normalizeSubAgentsConfig(undefined).semanticVerification).toBeUndefined();
      expect(normalizeSubAgentsConfig({}).semanticVerification).toBeUndefined();
    });

    it('is ON only for an explicit boolean true', () => {
      expect(normalizeSubAgentsConfig({ semanticVerification: true }).semanticVerification).toBe(
        true
      );
    });

    it('never coerces a truthy non-boolean into enabling it', () => {
      // A stray string must not silently switch on a ~1 GB verification pass.
      expect(
        normalizeSubAgentsConfig({ semanticVerification: 'yes' as unknown as boolean })
          .semanticVerification
      ).toBe(false);
      expect(
        normalizeSubAgentsConfig({ semanticVerification: 1 as unknown as boolean })
          .semanticVerification
      ).toBe(false);
    });

    it('clamps the budget between 1s and 120s', () => {
      expect(
        normalizeSubAgentsConfig({ semanticVerificationBudgetMs: 10 })
          .semanticVerificationBudgetMs
      ).toBe(1_000);
      expect(
        normalizeSubAgentsConfig({ semanticVerificationBudgetMs: 999_999 })
          .semanticVerificationBudgetMs
      ).toBe(120_000);
    });

    it('leaves the budget undefined when not supplied', () => {
      expect('semanticVerificationBudgetMs' in normalizeSubAgentsConfig({})).toBe(false);
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
        reviewer: { configSetId: ' role-set ', modelId: ' m2 ' },
        developer: { configSetId: '   ' },
        bogus: 'whatever',
      } as unknown as Parameters<typeof normalizeSubAgentsConfig>[0],
    });
    expect(normalized.configSetId).toBe('cheap');
    expect(normalized.perRole).toEqual({
      reviewer: { configSetId: 'role-set', modelId: 'm2' },
    });
  });

  it('migrates the legacy per-role string format to a selection object', () => {
    const normalized = normalizeSubAgentsConfig({
      configSetId: 'cheap',
      perRole: { reviewer: 'role-set' },
    } as unknown as Parameters<typeof normalizeSubAgentsConfig>[0]);
    expect(normalized.perRole).toEqual({
      reviewer: { configSetId: 'role-set', modelId: undefined },
    });
  });

  it('keeps the global modelId when provided', () => {
    expect(normalizeSubAgentsConfig({ modelId: '  free-model  ' }).modelId).toBe('free-model');
    expect(normalizeSubAgentsConfig({}).modelId).toBeUndefined();
  });

  it('normalizes the dynamic criticality tiers and trims their ids', () => {
    const normalized = normalizeSubAgentsConfig({
      criticality: {
        critical: { configSetId: ' strong ', modelId: ' big-model ', personaName: ' Lead ' },
        economical: { configSetId: 'cheap' },
      },
    } as unknown as Parameters<typeof normalizeSubAgentsConfig>[0]);
    expect(normalized.criticality).toEqual({
      critical: {
        configSetId: 'strong',
        modelId: 'big-model',
        personaName: 'Lead',
        systemPrompt: undefined,
      },
      economical: {
        configSetId: 'cheap',
        modelId: undefined,
        personaName: undefined,
        systemPrompt: undefined,
      },
    });
  });

  it('drops invalid criticality tiers and omits the key when empty', () => {
    const invalid = normalizeSubAgentsConfig({
      criticality: { critical: { configSetId: '   ' }, economical: 'cheap' },
    } as unknown as Parameters<typeof normalizeSubAgentsConfig>[0]);
    expect(invalid.criticality).toBeUndefined();
    expect(normalizeSubAgentsConfig({}).criticality).toBeUndefined();
    expect(normalizeSubAgentsConfig({ criticality: null }).criticality).toBeUndefined();
  });
});
