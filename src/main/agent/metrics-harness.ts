/**
 * @module main/agent/metrics-harness
 *
 * Cowork 4.0 — Phase 0.4/5: runs the reference scenarios against the live agent
 * and keeps the results per version so two releases can be compared.
 *
 * The agent call is injected as a `ScenarioRunner`, so the harness itself is
 * deterministic and the app decides how a scenario is executed.
 */

import type {
  MetricsDelta,
  RunMetrics,
  ScenarioRunFacts,
  ScenarioRunRecord,
  ScenarioSuiteResult,
} from '../../shared/metrics-types';
import {
  REFERENCE_SCENARIOS,
  compareMetrics,
  summarizeMetrics,
  type ReferenceScenario,
} from './reference-scenarios';

export type {
  ScenarioRunFacts,
  ScenarioRunRecord,
  ScenarioSuiteResult,
} from '../../shared/metrics-types';

export type ScenarioRunner = (scenario: ReferenceScenario) => Promise<ScenarioRunFacts>;

export const EMPTY_FACTS: ScenarioRunFacts = Object.freeze({
  success: false,
  turns: 0,
  costUsd: 0,
  durationMs: 0,
  regressions: 0,
  humanInterventions: 0,
  evidenceCount: 0,
});

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Project raw facts onto the comparable metric model. */
export function toRunMetrics(scenarioId: string, facts: ScenarioRunFacts): RunMetrics {
  return {
    scenarioId,
    success: facts.success === true,
    turns: Math.floor(nonNegative(facts.turns)),
    costUsd: nonNegative(facts.costUsd),
    durationMs: nonNegative(facts.durationMs),
    regressions: Math.floor(nonNegative(facts.regressions)),
    humanInterventions: Math.floor(nonNegative(facts.humanInterventions)),
    evidenceCount: Math.floor(nonNegative(facts.evidenceCount)),
  };
}

export interface RunReferenceScenariosOptions {
  runScenario: ScenarioRunner;
  scenarios?: readonly ReferenceScenario[];
  version?: string;
  now?: () => number;
  onRecord?: (record: ScenarioRunRecord) => void;
}

/** Run every scenario once and summarize the suite. Never throws. */
export async function runReferenceScenarios(
  options: RunReferenceScenariosOptions
): Promise<ScenarioSuiteResult> {
  const scenarios = options.scenarios ?? REFERENCE_SCENARIOS;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const records: ScenarioRunRecord[] = [];

  for (const scenario of scenarios) {
    const recordStartedAt = now();
    let facts: ScenarioRunFacts = { ...EMPTY_FACTS };
    let error: string | undefined;
    try {
      const produced = await options.runScenario(scenario);
      facts = { ...EMPTY_FACTS, ...produced };
    } catch (caught: unknown) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const record: ScenarioRunRecord = {
      scenarioId: scenario.id,
      kind: scenario.kind,
      startedAt: recordStartedAt,
      facts,
      metrics: toRunMetrics(scenario.id, facts),
      ...(error ? { error } : {}),
    };
    records.push(record);
    options.onRecord?.(record);
  }

  return {
    version: options.version ?? 'unversioned',
    startedAt,
    finishedAt: now(),
    records,
    summary: summarizeMetrics(records.map((record) => record.metrics)),
  };
}

/** Compare a candidate suite against a baseline (positive delta = better). */
export function compareSuiteResults(
  baseline: ScenarioSuiteResult,
  candidate: ScenarioSuiteResult
): MetricsDelta {
  return compareMetrics(baseline.summary, candidate.summary);
}

/** True when the candidate is not worse on any tracked axis. */
export function isNonRegression(delta: MetricsDelta): boolean {
  return delta.noRegression;
}

/** In-memory history of suite results, keyed by version. */
export class MetricsHistory {
  private readonly results = new Map<string, ScenarioSuiteResult>();

  public record(result: ScenarioSuiteResult): void {
    this.results.set(result.version, result);
  }

  public get(version: string): ScenarioSuiteResult | null {
    return this.results.get(version) ?? null;
  }

  public versions(): string[] {
    return Array.from(this.results.keys());
  }

  public latest(): ScenarioSuiteResult | null {
    const versions = this.versions();
    const last = versions[versions.length - 1];
    return last ? (this.results.get(last) ?? null) : null;
  }

  /** The result recorded just before the latest one. */
  public previous(): ScenarioSuiteResult | null {
    const versions = this.versions();
    const candidate = versions[versions.length - 2];
    return candidate ? (this.results.get(candidate) ?? null) : null;
  }

  /** Compare the latest version against the one before it. */
  public compareLatest(): MetricsDelta | null {
    const candidate = this.latest();
    const baseline = this.previous();
    if (!candidate || !baseline) {
      return null;
    }
    return compareSuiteResults(baseline, candidate);
  }

  public serialize(): ScenarioSuiteResult[] {
    return Array.from(this.results.values());
  }

  /** Restore a persisted history; malformed entries are skipped. */
  public restore(entries: readonly unknown[]): number {
    let restored = 0;
    for (const entry of entries) {
      const candidate = entry as Partial<ScenarioSuiteResult> | null;
      if (
        !candidate ||
        typeof candidate.version !== 'string' ||
        !Array.isArray(candidate.records) ||
        !candidate.summary
      ) {
        continue;
      }
      this.results.set(candidate.version, candidate as ScenarioSuiteResult);
      restored += 1;
    }
    return restored;
  }

  public clear(): number {
    const size = this.results.size;
    this.results.clear();
    return size;
  }

  public size(): number {
    return this.results.size;
  }
}
