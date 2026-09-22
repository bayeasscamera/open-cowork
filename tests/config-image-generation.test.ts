import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-images.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
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

import { normalizeImageGenerationConfig } from '../src/main/config/config-store';

describe('image generation config normalization', () => {
  it('inherits the active profile by default with a $0.05 confirmation threshold', () => {
    expect(normalizeImageGenerationConfig(undefined)).toEqual({
      configSetId: '',
      modelId: undefined,
      costConfirmThresholdUsd: 0.05,
    });
  });

  it('trims a pinned ConfigSet and model, dropping an empty model', () => {
    expect(
      normalizeImageGenerationConfig({ configSetId: '  images  ', modelId: '  gpt-image-1.5  ' })
    ).toEqual({ configSetId: 'images', modelId: 'gpt-image-1.5', costConfirmThresholdUsd: 0.05 });
    expect(
      normalizeImageGenerationConfig({ configSetId: 'images', modelId: '   ' }).modelId
    ).toBeUndefined();
  });

  it('clamps the cost threshold to [0, 100] and keeps 0 as "always confirm"', () => {
    expect(normalizeImageGenerationConfig({ costConfirmThresholdUsd: -5 }).costConfirmThresholdUsd).toBe(0);
    expect(normalizeImageGenerationConfig({ costConfirmThresholdUsd: 0 }).costConfirmThresholdUsd).toBe(0);
    expect(normalizeImageGenerationConfig({ costConfirmThresholdUsd: 500 }).costConfirmThresholdUsd).toBe(100);
    expect(
      normalizeImageGenerationConfig({ costConfirmThresholdUsd: Number.NaN }).costConfirmThresholdUsd
    ).toBe(0.05);
    expect(
      normalizeImageGenerationConfig({ costConfirmThresholdUsd: 'nope' as unknown as number })
        .costConfirmThresholdUsd
    ).toBe(0.05);
  });

  it('keeps an explicit provider profile so ANY provider can serve images', () => {
    const config = normalizeImageGenerationConfig({
      configSetId: '',
      provider: 'custom',
      customProtocol: 'openai',
      apiKey: '  vendor-key  ',
      baseUrl: ' https://images.example.com/v1 ',
      model: ' vendor-image-1 ',
    });
    expect(config.provider).toBe('custom');
    expect(config.customProtocol).toBe('openai');
    expect(config.apiKey).toBe('vendor-key');
    expect(config.baseUrl).toBe('https://images.example.com/v1');
    expect(config.model).toBe('vendor-image-1');
  });

  it('drops an unknown provider or protocol instead of trusting it', () => {
    const config = normalizeImageGenerationConfig({
      provider: 'not-a-provider' as unknown as 'openai',
      customProtocol: 'soap' as unknown as 'openai',
    });
    expect(config.provider).toBeUndefined();
    expect(config.customProtocol).toBeUndefined();
  });

  it('tolerates a non-object payload', () => {
    expect(normalizeImageGenerationConfig('nope' as unknown)).toEqual({
      configSetId: '',
      modelId: undefined,
      costConfirmThresholdUsd: 0.05,
    });
  });
});
