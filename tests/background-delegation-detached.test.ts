import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: vi.fn(),
  createReadTool: vi.fn(() => ({})),
  createWriteTool: vi.fn(() => ({})),
  createEditTool: vi.fn(() => ({})),
  createFindTool: vi.fn(() => ({})),
  createGrepTool: vi.fn(() => ({})),
  createLsTool: vi.fn(() => ({})),
  DefaultResourceLoader: vi.fn(function (this: unknown) {
    return { reload: vi.fn() };
  }),
  SessionManager: { inMemory: vi.fn() },
  SettingsManager: { inMemory: vi.fn() },
  AuthStorage: { create: vi.fn(() => ({ setRuntimeApiKey: vi.fn() })) },
  ModelRegistry: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({ getModel: vi.fn() }));

vi.mock('../src/main/config/config-store', () => ({
  configStore: { getAll: vi.fn() },
  normalizeSubAgentsConfig: vi.fn(() => ({
    configSetId: '',
    perRole: {},
    timeoutMs: 120_000,
    maxConcurrent: 2,
  })),
}));

vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logWarn: mocks.logWarn,
  logError: mocks.logError,
}));

vi.mock('../src/main/events/renderer-sender', () => ({
  sendToRenderer: vi.fn(),
}));

let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getPath: () => testRoot,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import {
  __resetDelegationsForTest,
  cancelDelegation,
  getDelegation,
  initBackgroundDelegations,
  normalizeDelegationSettings,
  pollDetachedDelegations,
  resumeInterruptedDelegations,
  setDelegationSettings,
  startDelegation,
  subAgentGate,
  takePendingDelegationResults,
  type BackgroundDelegation,
} from '../src/main/agent/background-delegations';
import { isProcessAlive, type DetachedLaunchPlan } from '../src/main/agent/detached-delegation';
import type { SubAgentSessionArgs, SubAgentSessionResult } from '../src/main/agent/swarm-runner';

type StartOptions = Parameters<typeof startDelegation>[0];
type ResumeStart = NonNullable<Parameters<typeof resumeInterruptedDelegations>[0]['start']>;

const STATE_FILE = 'background_delegations.json';
const dirs: string[] = [];

const testConfig = {
  provider: 'custom',
  customProtocol: 'openai',
  apiKey: 'k',
  model: 'test-model',
  subAgents: { configSetId: '', perRole: {}, timeoutMs: 5000, maxConcurrent: 2 },
} as unknown as ReturnType<NonNullable<StartOptions['getConfig']>>;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cowork-detached-del-'));
  dirs.push(testRoot);
  initBackgroundDelegations(testRoot);
  __resetDelegationsForTest();
  subAgentGate.reset();
  subAgentGate.setMax(2);
  setDelegationSettings({ detachedExecution: true, detachedAutoApprove: false, maxConcurrent: 2 });
  mocks.log.mockClear();
  mocks.logWarn.mockClear();
  mocks.logError.mockClear();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A pid that is guaranteed reaped, so liveness probes see it as dead. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '0']);
  const pid = result.pid;
  if (!pid || isProcessAlive(pid)) {
    throw new Error('Could not obtain a reaped pid for this test');
  }
  return pid;
}

/** A launcher that records plans and pretends a process started with `pid`. */
function makeLauncher(pid: number): {
  plans: DetachedLaunchPlan[];
  launcher: (plan: DetachedLaunchPlan) => { pid: number };
} {
  const plans: DetachedLaunchPlan[] = [];
  return {
    plans,
    launcher: (plan: DetachedLaunchPlan) => {
      plans.push(plan);
      return { pid };
    },
  };
}

function makeRow(overrides: Partial<BackgroundDelegation> = {}): BackgroundDelegation {
  return {
    id: 'bg-old',
    sessionId: 's1',
    title: 'Detached task',
    prompt: 'Do the thing',
    role: 'developer',
    cwd: testRoot,
    status: 'running',
    startedAt: 1000,
    depth: 1,
    delivered: false,
    log: [],
    ...overrides,
  };
}

function writeResult(taskId: string, payload: Record<string, unknown>): string {
  const dir = join(testRoot, 'delegations');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, taskId + '.result.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, ...payload }), 'utf-8');
  return file;
}

function makeDeferredLaunch(): {
  calls: SubAgentSessionArgs[];
  launch: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
} {
  const calls: SubAgentSessionArgs[] = [];
  const promise = new Promise<SubAgentSessionResult>(() => {
    // Never settles: we only assert the in-process path was taken.
  });
  return {
    calls,
    launch: (args: SubAgentSessionArgs) => {
      calls.push(args);
      return promise;
    },
  };
}

describe('detached delegations — launching', () => {
  it('launches through the detached launcher and records the pid and file paths', () => {
    const { plans, launcher } = makeLauncher(process.pid);

    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Detached research',
      prompt: 'Research X',
      spawnDetached: launcher,
      getConfig: () => testConfig,
    });

    const delegation = getDelegation(taskId);
    expect(plans).toHaveLength(1);
    expect(plans[0].args).toContain('--headless');
    expect(plans[0].args).toContain('--result-file');
    expect(plans[0].prompt ?? plans[0].args).toBeTruthy();
    expect(delegation?.detached).toBe(true);
    expect(delegation?.pid).toBe(process.pid);
    expect(delegation?.resultFile).toContain(taskId);
    expect(delegation?.logFile).toContain(taskId);
    expect(delegation?.status).toBe('running');
    expect(delegation?.log.some((entry) => entry.text.includes('Detached process started'))).toBe(
      true
    );
  });

  it('adds --auto-approve only when the user enabled it', () => {
    setDelegationSettings({ detachedAutoApprove: true });
    const { plans, launcher } = makeLauncher(process.pid);
    startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Trusted automation',
      prompt: 'p',
      spawnDetached: launcher,
      getConfig: () => testConfig,
    });
    expect(plans[0].args).toContain('--auto-approve');
  });

  it('fails the task instead of hanging when the launcher reports no pid', () => {
    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Broken launcher',
      prompt: 'p',
      spawnDetached: () => ({ pid: 0 }),
      getConfig: () => testConfig,
    });
    const delegation = getDelegation(taskId);
    expect(delegation?.status).toBe('failed');
    expect(delegation?.error).toContain('Could not start the detached process');
  });

  it('keeps depth-2 children in-process (a parent awaits them synchronously)', async () => {
    const { plans, launcher } = makeLauncher(process.pid);
    const inProcess = makeDeferredLaunch();
    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Recursive child',
      prompt: 'p',
      depth: 2,
      launchSession: inProcess.launch,
      spawnDetached: launcher,
      getConfig: () => testConfig,
    });
    // The in-process runner resolves its profile asynchronously before launching.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(plans).toHaveLength(0);
    expect(inProcess.calls).toHaveLength(1);
    expect(getDelegation(taskId)?.detached).toBeFalsy();
  });
});

describe('detached delegations — polling', () => {
  it('settles the task from its result file and injects the report', () => {
    const { launcher } = makeLauncher(process.pid);
    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Detached report',
      prompt: 'p',
      spawnDetached: launcher,
      getConfig: () => testConfig,
    });

    pollDetachedDelegations();
    expect(getDelegation(taskId)?.status).toBe('running');

    writeResult(taskId, {
      status: 'completed',
      output: '## Summary\nDone fast\n\n## Findings\nF',
      finishedAt: 42,
    });
    pollDetachedDelegations();

    const delegation = getDelegation(taskId);
    expect(delegation?.status).toBe('completed');
    expect(delegation?.report?.summary).toBe('Done fast');
    expect(delegation?.completedAt).toBe(42);
    expect(takePendingDelegationResults('s1')).toContain('Done fast');
  });

  it('fails a detached task whose process died without writing a result', () => {
    const { launcher } = makeLauncher(deadPid());
    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Vanished',
      prompt: 'p',
      spawnDetached: launcher,
      getConfig: () => testConfig,
    });
    pollDetachedDelegations();
    const delegation = getDelegation(taskId);
    expect(delegation?.status).toBe('failed');
    expect(delegation?.error).toContain('without writing a result');
  });

  it('tails the detached log for live progress without repeating it', () => {
    const { launcher } = makeLauncher(process.pid);
    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Chatty',
      prompt: 'p',
      spawnDetached: launcher,
      getConfig: () => testConfig,
    });
    const logFile = getDelegation(taskId)?.logFile as string;
    mkdirSync(join(testRoot, 'delegations'), { recursive: true });
    writeFileSync(logFile, '{"type":"trace.step","title":"Read","toolName":"read"}\n');

    pollDetachedDelegations();
    const delegation = getDelegation(taskId);
    expect(delegation?.log.some((entry) => entry.text === 'Tool: Read (read)')).toBe(true);

    const seen = delegation?.log.length ?? 0;
    pollDetachedDelegations();
    expect(getDelegation(taskId)?.log.length).toBe(seen);
  });

  it('resolves the done promise when the detached task settles', async () => {
    const { launcher } = makeLauncher(process.pid);
    const { taskId, done } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Awaitable',
      prompt: 'p',
      spawnDetached: launcher,
      getConfig: () => testConfig,
    });
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);

    writeResult(taskId, { status: 'completed', output: 'ok' });
    pollDetachedDelegations();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(true);
  });

  it('cancels a detached task and stops tracking it as running', () => {
    const { launcher } = makeLauncher(deadPid());
    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Cancelled',
      prompt: 'p',
      spawnDetached: launcher,
      getConfig: () => testConfig,
    });

    expect(cancelDelegation(taskId)).toBe(true);

    const delegation = getDelegation(taskId);
    expect(delegation?.status).toBe('cancelled');
    expect(
      delegation?.log.some((entry) => entry.kind === 'cancelled' && entry.text.includes('detached'))
    ).toBe(true);
    pollDetachedDelegations();
    expect(getDelegation(taskId)?.status).toBe('cancelled');
  });
});

describe('detached delegations — startup reconciliation', () => {
  it('completes a finished detached task from its result file instead of relaunching it', () => {
    const resultFile = writeResult('bg-old', {
      status: 'completed',
      output: '## Summary\nFinished while the app was closed',
      finishedAt: 7,
    });
    writeFileSync(
      join(testRoot, STATE_FILE),
      JSON.stringify([makeRow({ id: 'bg-old', detached: true, pid: deadPid(), resultFile })]),
      'utf-8'
    );

    initBackgroundDelegations(testRoot);

    const delegation = getDelegation('bg-old');
    expect(delegation?.status).toBe('completed');
    expect(delegation?.interrupted).toBeFalsy();
    expect(takePendingDelegationResults('s1')).toContain('Finished while the app was closed');

    const start: ResumeStart = () => ({ taskId: 'bg-new', done: Promise.resolve() });
    expect(resumeInterruptedDelegations({ start }).resumed).toEqual([]);
  });

  it('reattaches to a detached task whose process is still alive', () => {
    writeFileSync(
      join(testRoot, STATE_FILE),
      JSON.stringify([makeRow({ id: 'bg-live', detached: true, pid: process.pid })]),
      'utf-8'
    );

    initBackgroundDelegations(testRoot);

    const delegation = getDelegation('bg-live');
    expect(delegation?.status).toBe('running');
    expect(delegation?.interrupted).toBeFalsy();

    const start: ResumeStart = () => ({ taskId: 'bg-new', done: Promise.resolve() });
    expect(resumeInterruptedDelegations({ start }).resumed).toEqual([]);
  });

  it('marks a dead detached process without a result as interrupted and resumable', () => {
    writeFileSync(
      join(testRoot, STATE_FILE),
      JSON.stringify([makeRow({ id: 'bg-dead', detached: true, pid: deadPid() })]),
      'utf-8'
    );

    initBackgroundDelegations(testRoot);

    const delegation = getDelegation('bg-dead');
    expect(delegation?.status).toBe('failed');
    expect(delegation?.interrupted).toBe(true);
    expect(delegation?.error).toContain('interrupted by app restart');

    const start: ResumeStart = () => ({ taskId: 'bg-new', done: Promise.resolve() });
    expect(resumeInterruptedDelegations({ start }).resumed).toEqual(['bg-new']);
    expect(getDelegation('bg-dead')?.resumedBy).toBe('bg-new');
  });
});

describe('detached delegations — settings', () => {
  it('defaults to opt-in booleans and round-trips them', () => {
    expect(normalizeDelegationSettings({}).detachedExecution).toBe(false);
    expect(normalizeDelegationSettings({}).detachedAutoApprove).toBe(false);
    expect(normalizeDelegationSettings({ detachedExecution: 'yes' }).detachedExecution).toBe(false);
    expect(
      normalizeDelegationSettings({ detachedExecution: true, detachedAutoApprove: true })
    ).toEqual(expect.objectContaining({ detachedExecution: true, detachedAutoApprove: true }));

    const saved = setDelegationSettings({ detachedExecution: true, detachedAutoApprove: true });
    expect(saved.detachedExecution).toBe(true);
    expect(saved.detachedAutoApprove).toBe(true);
  });
});
