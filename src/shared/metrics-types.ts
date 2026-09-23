/**
 * @module shared/metrics-types
 *
 * Cowork 4.0 — the IPC-facing benchmark and routing-validation shapes.
 *
 * These live in shared/ because the preload bridge must describe the payloads
 * it returns without importing anything from the main process. The main-process
 * modules re-export them so their existing call sites stay unchanged.
 */

export type ScenarioKind =
  | 'bugfix'
  | 'multi-file-feature'
  | 'security-audit'
  | 'long-task'
  | 'session-resume';

export interface RunMetrics {
  scenarioId: string;
  /** Overall success as judged by the scenario success criteria. */
  success: boolean;
  /** Number of agent turns. */
  turns: number;
  costUsd: number;
  durationMs: number;
  /** Number of test regressions introduced. */
  regressions: number;
  /** Number of times a human had to intervene. */
  humanInterventions: number;
  evidenceCount: number;
}

export interface MetricsSummary {
  runs: number;
  successRate: number;
  avgTurns: number;
  avgCostUsd: number;
  avgDurationMs: number;
  regressionRate: number;
  humanInterventionRate: number;
  avgEvidence: number;
}

export interface MetricsDelta {
  successRate: number;
  avgTurns: number;
  avgCostUsd: number;
  avgDurationMs: number;
  regressionRate: number;
  humanInterventionRate: number;
  /** True when the candidate is not worse on any tracked axis. */
  noRegression: boolean;
}

/** Raw facts one scenario run produced, before they are turned into metrics. */
export interface ScenarioRunFacts {
  success: boolean;
  turns: number;
  costUsd: number;
  durationMs: number;
  regressions: number;
  humanInterventions: number;
  evidenceCount: number;
}

export interface ScenarioRunRecord {
  scenarioId: string;
  kind: ScenarioKind;
  startedAt: number;
  facts: ScenarioRunFacts;
  metrics: RunMetrics;
  error?: string;
}

export interface ScenarioSuiteResult {
  version: string;
  startedAt: number;
  finishedAt: number;
  records: ScenarioRunRecord[];
  summary: MetricsSummary;
}

export interface RoutingValidationOutcome {
  caseId: string;
  ok: boolean;
  /** The routing decision that was produced, kept for diagnosis. */
  decision: import('./model-routing-types').RoutingDecision;
  violations: string[];
}

export interface RoutingValidationReport {
  ok: boolean;
  outcomes: RoutingValidationOutcome[];
  checkedAt: number;
}
