import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ log: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

let testRoot = mkdtempSync(join(tmpdir(), 'cowork-swarm-stats-'));
vi.mock('electron', () => ({
  app: { getPath: () => testRoot, getVersion: () => 't', isPackaged: false },
}));

import { recordSwarmExecution, getSwarmStats, initSwarmStats } from '../src/main/agent/swarm-stats';
import type { MultiAgentPlan } from '../src/main/agent/multi-agent-coordinator';
import type { CrossVerificationResult } from '../src/main/agent/cross-verification';

function crossResult(modelCalls: number): CrossVerificationResult {
  return {
    kind: 'reviewer_security',
    modelCalls,
    divergences: [],
    blindSpots: [],
    contradictions: [],
    hasUnresolvedDisagreement: false,
  };
}

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  testRoot = mkdtempSync(join(tmpdir(), 'cowork-swarm-stats-'));
});

function plan(overrides: Partial<MultiAgentPlan>): MultiAgentPlan {
  return {
    id: 'p',
    goal: 'g',
    tasks: [],
    status: 'done',
    aggregationPolicy: 'fail-all',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('swarm-stats', () => {
  it('counts swarms, success and fallback tasks across runs', () => {
    initSwarmStats(testRoot);
    recordSwarmExecution(
      plan({
        status: 'done',
        tasks: [
          { id: 't1', role: 'developer', title: 'a', prompt: '', status: 'completed' },
          {
            id: 't2',
            role: 'reviewer',
            title: 'b',
            prompt: '',
            status: 'completed',
            usedFallback: true,
          },
        ],
      }),
      42_000
    );
    recordSwarmExecution(plan({ status: 'failed', tasks: [] }), 5_000);

    const stats = getSwarmStats();
    expect(stats.totalSwarms).toBe(2);
    expect(stats.succeededSwarms).toBe(1);
    expect(stats.totalTasks).toBe(2);
    expect(stats.fallbackTasks).toBe(1);
    expect(stats.lastRunMs).toBe(5_000); // the MOST RECENT run, not the first
  });

  it('exposes last-run tokens only when the provider actually reported them', () => {
    initSwarmStats(testRoot);
    recordSwarmExecution(
      plan({
        tasks: [
          {
            id: 't1',
            role: 'developer',
            title: 'a',
            prompt: '',
            status: 'completed',
            tokenUsage: { input: 0, output: 0 }, // gateway reports no usage
          },
        ],
      }),
      1000
    );
    expect(getSwarmStats().lastRunTokens).toBeUndefined();

    recordSwarmExecution(
      plan({
        tasks: [
          {
            id: 't1',
            role: 'developer',
            title: 'a',
            prompt: '',
            status: 'completed',
            tokenUsage: { input: 120, output: 30 },
          },
          {
            id: 't2',
            role: 'reviewer',
            title: 'b',
            prompt: '',
            status: 'completed',
            tokenUsage: { input: 80, output: 10 },
          },
        ],
      }),
      2000
    );
    expect(getSwarmStats().lastRunTokens).toEqual({ input: 200, output: 40 });
  });

  it('measures the OPT-IN cross-verification cost separately from the default path', () => {
    initSwarmStats(testRoot);

    // Default swarm: zero cross-verification calls.
    recordSwarmExecution(plan({ tasks: [] }), 100);
    expect(getSwarmStats().crossVerificationCalls).toBe(0);
    expect(getSwarmStats().crossVerificationSwarms).toBe(0);

    // Opt-in swarm: the extra calls are summed from the results.
    recordSwarmExecution(
      plan({
        crossVerification: true,
        crossVerificationResults: [crossResult(2), crossResult(1)],
      }),
      200
    );
    const stats = getSwarmStats();
    expect(stats.crossVerificationSwarms).toBe(1);
    expect(stats.crossVerificationCalls).toBe(3);
  });

  it('measures the OPT-IN teammate question cost separately from the default path', () => {
    initSwarmStats(testRoot);

    // Default swarm: no team mode, zero teammate calls.
    recordSwarmExecution(plan({ tasks: [] }), 100);
    expect(getSwarmStats().teammateCalls).toBe(0);
    expect(getSwarmStats().teammateSwarms).toBe(0);

    // Team mode ON but nobody asked: still zero extra model calls.
    recordSwarmExecution(
      plan({
        teamMode: true,
        tasks: [{ id: 't1', role: 'developer', title: 'a', prompt: '', status: 'completed' }],
      }),
      150
    );
    expect(getSwarmStats().teammateSwarms).toBe(1);
    expect(getSwarmStats().teammateCalls).toBe(0);

    // One answered question costs 1; a timeout costs 0 (measured, not assumed).
    recordSwarmExecution(
      plan({
        teamMode: true,
        tasks: [
          {
            id: 't1',
            role: 'developer',
            title: 'a',
            prompt: '',
            status: 'completed',
            teammateExchanges: [
              {
                id: 'x1',
                fromRole: 'developer',
                fromTaskId: 't1',
                targetRole: 'architect',
                question: 'q',
                answer: 'a',
                status: 'answered',
                modelCalls: 1,
                at: 0,
                durationMs: 3,
              },
              {
                id: 'x2',
                fromRole: 'architect',
                fromTaskId: 't1',
                targetRole: 'reviewer',
                question: 'q',
                answer: 'fallback',
                status: 'timeout',
                modelCalls: 0,
                at: 0,
                durationMs: 30_000,
              },
            ],
          },
        ],
      }),
      200
    );
    expect(getSwarmStats().teammateSwarms).toBe(2);
    expect(getSwarmStats().teammateCalls).toBe(1);
  });

  it('counts a done-but-partial plan as a partial swarm, never a success', () => {
    initSwarmStats(testRoot);
    // partial-ok: the plan finished 'done' but one task never completed.
    recordSwarmExecution(
      plan({
        status: 'done',
        tasks: [
          { id: 't1', role: 'developer', title: 'a', prompt: '', status: 'completed' },
          { id: 't2', role: 'reviewer', title: 'b', prompt: '', status: 'failed' },
        ],
      }),
      1000
    );
    // A plan that failed outright is neither a success nor a partial run.
    recordSwarmExecution(plan({ status: 'failed', tasks: [] }), 500);

    const stats = getSwarmStats();
    expect(stats.succeededSwarms).toBe(0);
    expect(stats.partialSwarms).toBe(1);
    expect(stats.totalSwarms).toBe(2);
  });

  it('persists to an atomic JSON file and reloads across a simulated restart', () => {
    initSwarmStats(testRoot);
    recordSwarmExecution(plan({ tasks: [] }), 900);
    const file = join(testRoot, 'swarm_stats.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8')).totalSwarms).toBe(1);

    // Simulated app restart: same dir, fresh load.
    initSwarmStats(testRoot);
    expect(getSwarmStats().totalSwarms).toBe(1);
  });
});
