import { describe, expect, it } from 'vitest';
import {
  ModelBenchmarkStore,
  aggregateBenchmarks,
  computeBenchmarkScore,
} from '../src/main/agent/model-benchmark';
import type { ModelBenchmark } from '../src/shared/model-routing-types';

describe('computeBenchmarkScore', () => {
  it('returns zero without runs and one for a perfect, instant model', () => {
    expect(computeBenchmarkScore(0, 0, 0)).toBe(0);
    expect(computeBenchmarkScore(4, 4, 0)).toBe(1);
  });

  it('weights success more than speed', () => {
    expect(computeBenchmarkScore(4, 2, 10_000)).toBe(0.425);
  });
});

describe('ModelBenchmarkStore', () => {
  it('aggregates runs, successes, latency and cost', () => {
    const store = new ModelBenchmarkStore();
    store.record({ modelId: 'm1', taskKind: 'implementation', success: true, latencyMs: 100, costUsd: 0.01 });
    store.record({ modelId: 'm1', taskKind: 'implementation', success: false, latencyMs: 200, costUsd: 0.02 });
    const summary = store.record({ modelId: 'm1', taskKind: 'implementation', success: true, latencyMs: 300, costUsd: 0.03 });

    expect(summary).toEqual({
      modelId: 'm1',
      taskKind: 'implementation',
      runs: 3,
      successes: 2,
      avgLatencyMs: 200,
      avgCostUsd: 0.02,
      score: 0.6627,
    });
  });

  it('reports unknown models as unscored', () => {
    const store = new ModelBenchmarkStore();
    expect(store.get('m1', 'review')).toBeNull();
    expect(store.score('m1', 'review')).toBe(0);
    expect(store.bestFor('review')).toBeNull();
  });

  it('lists sorted by task kind then score', () => {
    const store = new ModelBenchmarkStore();
    store.record({ modelId: 'slow', taskKind: 'review', success: true, latencyMs: 60_000 });
    store.record({ modelId: 'fast', taskKind: 'review', success: true, latencyMs: 100 });
    store.record({ modelId: 'other', taskKind: 'exploration', success: true, latencyMs: 100 });

    expect(store.list().map((entry) => entry.modelId)).toEqual(['other', 'fast', 'slow']);
    expect(store.list(undefined, 'review').map((entry) => entry.modelId)).toEqual(['fast', 'slow']);
    expect(store.list('fast').map((entry) => entry.modelId)).toEqual(['fast']);
  });

  it('finds the best model for a task, optionally restricted', () => {
    const store = new ModelBenchmarkStore();
    store.record({ modelId: 'a', taskKind: 'review', success: true, latencyMs: 100 });
    store.record({ modelId: 'b', taskKind: 'review', success: true, latencyMs: 100 });

    expect(store.bestFor('review')?.modelId).toBe('a');
    expect(store.bestFor('review', ['b'])?.modelId).toBe('b');
    expect(store.bestFor('review', ['missing'])).toBeNull();
  });

  it('round-trips a snapshot and clears', () => {
    const store = new ModelBenchmarkStore();
    store.record({ modelId: 'm1', taskKind: 'implementation', success: true, latencyMs: 100, costUsd: 0.01 });
    const snapshot = store.serialize();

    const restored = new ModelBenchmarkStore();
    expect(restored.restore(snapshot)).toBe(1);
    expect(restored.get('m1', 'implementation')).toEqual(snapshot[0]);
    expect(restored.size()).toBe(1);

    expect(restored.restore([{ modelId: 'x' } as never])).toBe(0);
    expect(restored.clear()).toBe(1);
    expect(restored.size()).toBe(0);
  });

  it('aggregates a batch of records', () => {
    const summary = aggregateBenchmarks([
      { modelId: 'm1', taskKind: 'general', success: true, latencyMs: 10 },
      { modelId: 'm1', taskKind: 'general', success: true, latencyMs: 20 },
    ]);
    expect(summary).toHaveLength(1);
    expect(summary[0].runs).toBe(2);
  });
});
