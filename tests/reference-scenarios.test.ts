import { describe, it, expect } from 'vitest';
import {
  REFERENCE_SCENARIOS,
  compareMetrics,
  summarizeMetrics,
  type RunMetrics,
} from '../src/main/agent/reference-scenarios';

const run = (overrides: Partial<RunMetrics> = {}): RunMetrics => ({
  scenarioId: 's1',
  success: true,
  turns: 10,
  costUsd: 0.1,
  durationMs: 1000,
  regressions: 0,
  humanInterventions: 0,
  evidenceCount: 2,
  ...overrides,
});

describe('reference-scenarios', () => {
  it('covers the five Phase 0 scenarios with unique ids', () => {
    expect(REFERENCE_SCENARIOS).toHaveLength(5);
    const ids = REFERENCE_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);

    const kinds = REFERENCE_SCENARIOS.map((scenario) => scenario.kind).sort();
    expect(kinds).toEqual([
      'bugfix',
      'long-task',
      'multi-file-feature',
      'security-audit',
      'session-resume',
    ]);
  });

  it('gives every scenario a budget, criteria and expected evidence', () => {
    for (const scenario of REFERENCE_SCENARIOS) {
      expect(scenario.budget.maxTokens).toBeGreaterThan(0);
      expect(scenario.successCriteria.length).toBeGreaterThan(0);
      expect(scenario.expectedEvidence.length).toBeGreaterThan(0);
    }
  });

  it('returns zeroed metrics for an empty run set', () => {
    expect(summarizeMetrics([])).toEqual({
      runs: 0,
      successRate: 0,
      avgTurns: 0,
      avgCostUsd: 0,
      avgDurationMs: 0,
      regressionRate: 0,
      humanInterventionRate: 0,
      avgEvidence: 0,
    });
  });

  it('summarizes success, cost and intervention rates', () => {
    const summary = summarizeMetrics([
      run({ success: true, turns: 10, costUsd: 0.2, durationMs: 1000 }),
      run({ success: false, turns: 20, costUsd: 0.4, durationMs: 3000, regressions: 1, humanInterventions: 2 }),
    ]);

    expect(summary.runs).toBe(2);
    expect(summary.successRate).toBe(0.5);
    expect(summary.avgTurns).toBe(15);
    expect(summary.avgCostUsd).toBeCloseTo(0.3);
    expect(summary.avgDurationMs).toBe(2000);
    expect(summary.regressionRate).toBe(0.5);
    expect(summary.humanInterventionRate).toBe(0.5);
  });

  it('detects a candidate that regresses on any axis', () => {
    const baseline = summarizeMetrics([run({ turns: 10, costUsd: 0.1 })]);
    const better = summarizeMetrics([run({ turns: 8, costUsd: 0.08 })]);
    const worse = summarizeMetrics([run({ turns: 12, costUsd: 0.08 })]);

    const improved = compareMetrics(baseline, better);
    expect(improved.noRegression).toBe(true);
    expect(improved.avgTurns).toBe(2);

    const regressed = compareMetrics(baseline, worse);
    expect(regressed.noRegression).toBe(false);
    expect(regressed.avgTurns).toBe(-2);
  });
});
