/**
 * @module main/ipc/metrics-harness-handlers
 *
 * Cowork 4.0 — Phase 5.5 / 7.5: benchmark history, reference-suite execution
 * and end-to-end model routing validation. Running a suite actually drives the
 * agent over the reference scenarios, so it is only exposed when a runner was
 * injected at bootstrap; otherwise the channel reports that it is unavailable
 * instead of returning a fake green result.
 */

import { ipcMain } from 'electron';
import type { ModelBenchmark } from '../../shared/model-routing-types';
import {
  MetricsHistory,
  compareSuiteResults,
  runReferenceScenarios,
  type ScenarioRunner,
  type ScenarioSuiteResult,
} from '../agent/metrics-harness';
import type { MetricsDelta } from '../agent/reference-scenarios';
import {
  DEFAULT_ROUTING_CASES,
  validateRoutingEndToEnd,
  type RoutingValidationReport,
} from '../agent/routing-validation';
import { logError } from '../utils/logger';

export interface MetricsIpcContext {
  /** In-memory benchmark history, shared with the routing service. */
  history?: MetricsHistory;
  /** Drives the agent over the reference scenarios. */
  runSuite?: ScenarioRunner;
  /** Benchmarks that the routing validator should take into account. */
  benchmarks?: () => readonly ModelBenchmark[];
  /** Called after a suite is recorded so the caller can persist the history. */
  onRecord?: (history: MetricsHistory) => void;
}

const UNAVAILABLE = 'Benchmark execution is not available in this build.';

export function registerMetricsIpcHandlers(context: MetricsIpcContext = {}): void {
  const history = context.history ?? new MetricsHistory();

  ipcMain.handle('metrics.history', (): ScenarioSuiteResult[] => history.serialize());

  ipcMain.handle('metrics.compare', (_event, baseline?: unknown, candidate?: unknown): MetricsDelta | null => {
    try {
      const baselineVersion = typeof baseline === 'string' && baseline.length > 0 ? baseline : null;
      const candidateVersion =
        typeof candidate === 'string' && candidate.length > 0 ? candidate : null;

      if (baselineVersion && candidateVersion) {
        const from = history.get(baselineVersion);
        const to = history.get(candidateVersion);
        return from && to ? compareSuiteResults(from, to) : null;
      }
      return history.compareLatest();
    } catch (error: unknown) {
      logError('[metrics] compare failed', error);
      throw error;
    }
  });

  ipcMain.handle('metrics.runSuite', async (_event, version?: unknown): Promise<ScenarioSuiteResult> => {
    const runSuite = context.runSuite;
    if (!runSuite) {
      throw new Error(UNAVAILABLE);
    }
    const label =
      typeof version === 'string' && version.trim().length > 0 ? version.trim() : 'unversioned';
    try {
      const result = await runReferenceScenarios({ runScenario: runSuite, version: label });
      history.record(result);
      context.onRecord?.(history);
      return result;
    } catch (error: unknown) {
      logError('[metrics] runSuite failed', error);
      throw error;
    }
  });

  ipcMain.handle('metrics.validateRouting', (): RoutingValidationReport => {
    try {
      return validateRoutingEndToEnd({
        cases: DEFAULT_ROUTING_CASES,
        benchmarks: context.benchmarks?.() ?? [],
      });
    } catch (error: unknown) {
      logError('[metrics] validateRouting failed', error);
      throw error;
    }
  });

  ipcMain.handle('metrics.clearHistory', (): { cleared: number } => ({ cleared: history.clear() }));
}
