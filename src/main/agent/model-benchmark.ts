/**
 * @module main/agent/model-benchmark
 *
 * Cowork 4.0 — Phase 7.2: a local benchmark per model and task kind. Results are
 * aggregated locally only; nothing is uploaded.
 */

import type { BenchmarkRecordInput, ModelBenchmark, TaskKind } from '../../shared/model-routing-types';
import { TASK_KINDS } from '../../shared/model-routing-types';

export type { BenchmarkRecordInput } from '../../shared/model-routing-types';

interface Accumulator {
  modelId: string;
  taskKind: TaskKind;
  runs: number;
  successes: number;
  totalLatencyMs: number;
  totalCostUsd: number;
}

const LATENCY_SCALE_MS = 10_000;

/** Composite score in [0, 1]: success rate, lightly weighted by speed. */
export function computeBenchmarkScore(
  runs: number,
  successes: number,
  avgLatencyMs: number
): number {
  if (runs <= 0) {
    return 0;
  }
  const successRate = successes / runs;
  const speed = 1 / (1 + Math.max(0, avgLatencyMs) / LATENCY_SCALE_MS);
  return Number((successRate * (0.7 + 0.3 * speed)).toFixed(4));
}

export function aggregateBenchmarks(records: readonly BenchmarkRecordInput[]): ModelBenchmark[] {
  const store = new ModelBenchmarkStore();
  for (const record of records) {
    store.record(record);
  }
  return store.list();
}

export class ModelBenchmarkStore {
  private readonly accumulators = new Map<string, Accumulator>();

  private static key(modelId: string, taskKind: TaskKind): string {
    return modelId + '::' + taskKind;
  }

  public record(input: BenchmarkRecordInput): ModelBenchmark {
    const key = ModelBenchmarkStore.key(input.modelId, input.taskKind);
    const existing = this.accumulators.get(key) ?? {
      modelId: input.modelId,
      taskKind: input.taskKind,
      runs: 0,
      successes: 0,
      totalLatencyMs: 0,
      totalCostUsd: 0,
    };
    existing.runs += 1;
    existing.successes += input.success ? 1 : 0;
    existing.totalLatencyMs += Math.max(0, input.latencyMs);
    existing.totalCostUsd += Math.max(0, input.costUsd ?? 0);
    this.accumulators.set(key, existing);
    return ModelBenchmarkStore.summarize(existing);
  }

  public get(modelId: string, taskKind: TaskKind): ModelBenchmark | null {
    const accumulator = this.accumulators.get(ModelBenchmarkStore.key(modelId, taskKind));
    return accumulator ? ModelBenchmarkStore.summarize(accumulator) : null;
  }

  public list(modelId?: string, taskKind?: TaskKind): ModelBenchmark[] {
    return Array.from(this.accumulators.values())
      .filter((entry) => (modelId ? entry.modelId === modelId : true))
      .filter((entry) => (taskKind ? entry.taskKind === taskKind : true))
      .map((entry) => ModelBenchmarkStore.summarize(entry))
      .sort((a, b) => {
        if (a.taskKind !== b.taskKind) {
          return a.taskKind.localeCompare(b.taskKind);
        }
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return a.modelId.localeCompare(b.modelId);
      });
  }

  /** Score in [0, 1]; 0 when the model has never been benchmarked for the task. */
  public score(modelId: string, taskKind: TaskKind): number {
    return this.get(modelId, taskKind)?.score ?? 0;
  }

  public bestFor(taskKind: TaskKind, modelIds?: readonly string[]): ModelBenchmark | null {
    const allowed = modelIds ? new Set(modelIds) : null;
    return (
      this.list(undefined, taskKind).find((entry) => !allowed || allowed.has(entry.modelId)) ?? null
    );
  }

  public size(): number {
    return this.accumulators.size;
  }

  public clear(): number {
    const cleared = this.accumulators.size;
    this.accumulators.clear();
    return cleared;
  }

  public serialize(): ModelBenchmark[] {
    return this.list();
  }

  /** Restore an aggregate snapshot. Returns how many entries were restored. */
  public restore(entries: readonly ModelBenchmark[]): number {
    let restored = 0;
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry.modelId !== 'string' ||
        !(TASK_KINDS as readonly string[]).includes(entry.taskKind) ||
        typeof entry.runs !== 'number' ||
        !Number.isFinite(entry.runs) ||
        entry.runs <= 0 ||
        typeof entry.successes !== 'number' ||
        typeof entry.avgLatencyMs !== 'number' ||
        typeof entry.avgCostUsd !== 'number'
      ) {
        continue;
      }
      this.accumulators.set(ModelBenchmarkStore.key(entry.modelId, entry.taskKind), {
        modelId: entry.modelId,
        taskKind: entry.taskKind,
        runs: entry.runs,
        successes: entry.successes,
        totalLatencyMs: entry.avgLatencyMs * entry.runs,
        totalCostUsd: entry.avgCostUsd * entry.runs,
      });
      restored += 1;
    }
    return restored;
  }

  private static summarize(accumulator: Accumulator): ModelBenchmark {
    const avgLatencyMs = accumulator.totalLatencyMs / accumulator.runs;
    return {
      modelId: accumulator.modelId,
      taskKind: accumulator.taskKind,
      runs: accumulator.runs,
      successes: accumulator.successes,
      avgLatencyMs: Number(avgLatencyMs.toFixed(2)),
      avgCostUsd: Number((accumulator.totalCostUsd / accumulator.runs).toFixed(6)),
      score: computeBenchmarkScore(accumulator.runs, accumulator.successes, avgLatencyMs),
    };
  }
}
