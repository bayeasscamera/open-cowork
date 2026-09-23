import { describe, it, expect, vi } from 'vitest';
import {
  EMPTY_FACTS,
  MetricsHistory,
  compareSuiteResults,
  isNonRegression,
  runReferenceScenarios,
  toRunMetrics,
  type ScenarioRunner,
} from '../src/main/agent/metrics-harness';
import { REFERENCE_SCENARIOS } from '../src/main/agent/reference-scenarios';
import type { ScenarioSuiteResult } from '../src/shared/metrics-types';

function suite(
  version: string,
  overrides: Partial<ScenarioSuiteResult['summary']> = {}
): ScenarioSuiteResult {
  return {
    version,
    startedAt: 0,
    finishedAt: 1,
    records: [],
    summary: {
      runs: 5,
      successRate: 0.6,
      avgTurns: 20,
      avgCostUsd: 1,
      avgDurationMs: 60_000,
      regressionRate: 0.2,
      humanInterventionRate: 0.4,
      avgEvidence: 1,
      ...overrides,
    },
  };
}

describe('toRunMetrics', () => {
  it('clamps nonsense to zero', () => {
    const metrics = toRunMetrics('s1', {
      success: true,
      turns: -3,
      costUsd: Number.NaN,
      durationMs: Number.POSITIVE_INFINITY,
      regressions: -1,
      humanInterventions: -1,
      evidenceCount: -1,
    });
    expect(metrics.success).toBe(true);
    expect(metrics.turns).toBe(0);
    expect(metrics.costUsd).toBe(0);
    expect(metrics.durationMs).toBe(0);
  });

  it('keeps real values', () => {
    const metrics = toRunMetrics('s1', { ...EMPTY_FACTS, turns: 7.9, costUsd: 0.25 });
    expect(metrics.turns).toBe(7);
    expect(metrics.costUsd).toBeCloseTo(0.25);
  });
});

describe('runReferenceScenarios', () => {
  it('runs every reference scenario and summarizes the suite', async () => {
    const runScenario = vi.fn(async () => ({
      ...EMPTY_FACTS,
      success: true,
      turns: 4,
      costUsd: 0.1,
      durationMs: 1000,
      evidenceCount: 2,
    }));

    const result = await runReferenceScenarios({ runScenario, version: '1.0.0' });

    expect(runScenario).toHaveBeenCalledTimes(REFERENCE_SCENARIOS.length);
    expect(result.version).toBe('1.0.0');
    expect(result.records).toHaveLength(REFERENCE_SCENARIOS.length);
    expect(result.summary.successRate).toBe(1);
    expect(result.summary.avgTurns).toBe(4);
    expect(result.summary.avgEvidence).toBe(2);
  });

  it('records a failure per scenario instead of throwing', async () => {
    const runScenario: ScenarioRunner = async (scenario) => {
      if (scenario.id === 'security-audit') {
        throw new Error('provider exploded');
      }
      return { ...EMPTY_FACTS, success: true };
    };

    const result = await runReferenceScenarios({ runScenario, version: '1.0.0' });
    const failed = result.records.find((record) => record.scenarioId === 'security-audit');

    expect(failed?.error).toBe('provider exploded');
    expect(failed?.metrics.success).toBe(false);
    expect(result.summary.successRate).toBeCloseTo(
      (REFERENCE_SCENARIOS.length - 1) / REFERENCE_SCENARIOS.length
    );
  });

  it('streams each record to the caller as it completes', async () => {
    const seen: string[] = [];
    await runReferenceScenarios({
      runScenario: async () => ({ ...EMPTY_FACTS, success: true }),
      onRecord: (record) => seen.push(record.scenarioId),
    });
    expect(seen).toEqual(REFERENCE_SCENARIOS.map((scenario) => scenario.id));
  });
});

describe('compareSuiteResults', () => {
  it('marks an improvement as a non-regression', () => {
    const delta = compareSuiteResults(
      suite('1.0.0'),
      suite('1.1.0', { successRate: 0.9, avgTurns: 12, avgCostUsd: 0.4, regressionRate: 0 })
    );

    expect(delta.successRate).toBeCloseTo(0.3);
    expect(delta.avgTurns).toBe(8);
    expect(delta.noRegression).toBe(true);
    expect(isNonRegression(delta)).toBe(true);
  });

  it('flags a drop in the success rate as a regression', () => {
    const delta = compareSuiteResults(suite('1.0.0'), suite('1.1.0', { successRate: 0.2 }));
    expect(delta.successRate).toBeLessThan(0);
    expect(delta.noRegression).toBe(false);
    expect(isNonRegression(delta)).toBe(false);
  });

  it('flags more human interventions as a regression', () => {
    const delta = compareSuiteResults(
      suite('1.0.0'),
      suite('1.1.0', { humanInterventionRate: 0.8 })
    );
    expect(delta.humanInterventionRate).toBeLessThan(0);
    expect(delta.noRegression).toBe(false);
  });
});

describe('MetricsHistory', () => {
  it('keeps one result per version and compares the last two', () => {
    const history = new MetricsHistory();
    history.record(suite('1.0.0'));
    history.record(suite('1.1.0', { successRate: 0.9 }));

    expect(history.size()).toBe(2);
    expect(history.versions()).toEqual(['1.0.0', '1.1.0']);
    expect(history.latest()?.version).toBe('1.1.0');
    expect(history.previous()?.version).toBe('1.0.0');
    expect(history.compareLatest()?.successRate).toBeCloseTo(0.3);
    expect(history.get('1.0.0')?.version).toBe('1.0.0');
    expect(history.get('nope')).toBeNull();
  });

  it('re-recording the same version replaces it, keeping the order', () => {
    const history = new MetricsHistory();
    history.record(suite('1.0.0'));
    history.record(suite('1.0.0', { successRate: 0.99 }));
    expect(history.size()).toBe(1);
    expect(history.latest()?.summary.successRate).toBeCloseTo(0.99);
  });

  it('compares nothing when fewer than two versions are known', () => {
    const history = new MetricsHistory();
    expect(history.compareLatest()).toBeNull();
    history.record(suite('1.0.0'));
    expect(history.compareLatest()).toBeNull();
  });

  it('skips malformed entries when restoring', () => {
    const history = new MetricsHistory();
    const restored = history.restore([
      suite('1.0.0'),
      { version: 42 },
      null,
      { version: '2.0.0', records: [], summary: null },
    ]);
    expect(restored).toBe(1);
    expect(history.versions()).toEqual(['1.0.0']);
  });

  it('clears everything on request', () => {
    const history = new MetricsHistory();
    history.record(suite('1.0.0'));
    history.record(suite('1.1.0'));
    expect(history.clear()).toBe(2);
    expect(history.size()).toBe(0);
  });
});
