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

import {
  recordSwarmExecution,
  getSwarmStats,
  initSwarmStats,
} from '../src/main/agent/swarm-stats';
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