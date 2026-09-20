import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
  startDelegation,
  takePendingDelegationResults,
  describeRunningDelegations,
  listDelegations,
  initBackgroundDelegations,
  __resetDelegationsForTest,
} from '../src/main/agent/background-delegations';
import type { SubAgentSessionArgs, SubAgentSessionResult } from '../src/main/agent/swarm-runner';
import { sendToRenderer } from '../src/main/events/renderer-sender';

const dirs: string[] = [];

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cowork-bg-del-'));
  dirs.push(testRoot);
  initBackgroundDelegations(testRoot);
  __resetDelegationsForTest();
  vi.mocked(sendToRenderer).mockClear();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface DeferredLaunch {
  promise: Promise<SubAgentSessionResult>;
  resolve: (result: SubAgentSessionResult) => void;
  reject: (err: Error) => void;
  calls: SubAgentSessionArgs[];
}

function makeDeferredLaunch(): DeferredLaunch {
  const calls: SubAgentSessionArgs[] = [];
  let resolve!: (result: SubAgentSessionResult) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<SubAgentSessionResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const launch = (args: SubAgentSessionArgs) => {
    calls.push(args);
    return promise;
  };
  return { promise, resolve, reject, calls, launch } as DeferredLaunch & {
    launch: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
  };
}

const flushAsync = () => new Promise((r) => setTimeout(r, 5));

const testConfig = {
  provider: 'custom',
  customProtocol: 'openai',
  apiKey: 'k',
  model: 'test-model',
  subAgents: { configSetId: '', perRole: {}, timeoutMs: 5000, maxConcurrent: 2 },
} as unknown as Parameters<typeof startDelegation>[0]['getConfig'] extends never
  ? never
  : ReturnType<NonNullable<Parameters<typeof startDelegation>[0]['getConfig']>>;

describe('background delegations — async delegation mode', () => {
  it('NON-BLOCKING: startDelegation returns a task id immediately while the sub-agent still runs', async () => {
    const launch = makeDeferredLaunch();
    const startedAt = Date.now();

    // Returns BEFORE the fake sub-agent resolves — the whole point of the mode.
    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'Research X on the web',
      prompt: 'Research X and summarize with sources',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });

    expect(taskId).toBeTruthy();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    // The launch lands on the next microtask (concurrency slot acquisition);
    // the deferred is still unresolved — startDelegation did NOT wait for it.
    await flushAsync();
    expect(launch.calls).toHaveLength(1); // sub-agent launched…
    expect(listDelegations('s1')[0].status).toBe('running'); // …but still running

    // Nothing to inject yet: the main agent can keep chatting meanwhile.
    expect(takePendingDelegationResults('s1')).toBe('');

    // The sub-agent finishes LATER.
    launch.resolve({ output: 'Key finding: X is Y.', modifiedFiles: [] });
    await flushAsync();

    expect(listDelegations('s1')[0].status).toBe('completed');
    const block = takePendingDelegationResults('s1');
    expect(block).toContain('Research X on the web');
    expect(block).toContain('Key finding: X is Y.');
    // Delivered exactly once.
    expect(takePendingDelegationResults('s1')).toBe('');
  });

  it('the running task is visible at every turn and disappears once finished', async () => {
    const launch = makeDeferredLaunch();
    startDelegation({
      sessionId: 's2',
      cwd: testRoot,
      title: 'Slow research',
      prompt: 'p',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });

    const runningBlock = describeRunningDelegations('s2');
    expect(runningBlock).toContain('Slow research');
    expect(runningBlock).toContain('background_tasks_running');

    launch.resolve({ output: 'done', modifiedFiles: [] });
    await flushAsync();
    expect(describeRunningDelegations('s2')).toBe('');
  });

  it('a failed delegation queues a failure notice (the agent is not left waiting)', async () => {
    const launch = makeDeferredLaunch();
    startDelegation({
      sessionId: 's3',
      cwd: testRoot,
      title: 'Doomed task',
      prompt: 'p',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });

    launch.reject(new Error('provider exploded'));
    await flushAsync();

    expect(listDelegations('s3')[0].status).toBe('failed');
    const block = takePendingDelegationResults('s3');
    expect(block).toContain('Doomed task');
    expect(block).toContain('provider exploded');
  });

  it('persists state: completed-but-undelivered results survive a restart; running tasks are marked interrupted', async () => {
    const launchDone = makeDeferredLaunch();
    startDelegation({
      sessionId: 's4',
      cwd: testRoot,
      title: 'Finished before restart',
      prompt: 'p',
      launchSession: launchDone.launch,
      getConfig: () => testConfig,
    });
    launchDone.resolve({ output: 'surviving result', modifiedFiles: [] });
    await flushAsync();
    // NOT delivered yet — the user has not sent the next turn.

    const launchRunning = makeDeferredLaunch();
    startDelegation({
      sessionId: 's4',
      cwd: testRoot,
      title: 'Still running at restart',
      prompt: 'p',
      launchSession: launchRunning.launch,
      getConfig: () => testConfig,
    });

    // Simulate an app restart: fresh in-memory state, same storage file.
    __resetDelegationsForTest();
    initBackgroundDelegations(testRoot);

    const statuses = listDelegations('s4');
    const finished = statuses.find((d) => d.title === 'Finished before restart');
    const interrupted = statuses.find((d) => d.title === 'Still running at restart');
    expect(finished?.status).toBe('completed');
    expect(interrupted?.status).toBe('failed');
    expect(interrupted?.error).toContain('restart');

    // The surviving result is still injected on the next turn after restart.
    const block = takePendingDelegationResults('s4');
    expect(block).toContain('surviving result');
  });

  it('emits background.task events to the renderer (badge + notification path)', async () => {
    const launch = makeDeferredLaunch();
    startDelegation({
      sessionId: 's5',
      cwd: testRoot,
      title: 'Visible task',
      prompt: 'p',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    expect(sendToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'background.task',
        payload: expect.objectContaining({ sessionId: 's5', status: 'running' }),
      })
    );

    launch.resolve({ output: 'ok', modifiedFiles: [] });
    await flushAsync();
    expect(sendToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'background.task',
        payload: expect.objectContaining({ status: 'completed' }),
      })
    );
  });

  it('persists delegations to an atomic JSON state file in userData', async () => {
    const launch = makeDeferredLaunch();
    startDelegation({
      sessionId: 's6',
      cwd: testRoot,
      title: 'Persisted',
      prompt: 'p',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    launch.resolve({ output: 'result', modifiedFiles: [] });
    await flushAsync();

    const stateFile = join(testRoot, 'background_delegations.json');
    expect(existsSync(stateFile)).toBe(true);
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Array<{ title: string }>;
    expect(raw.some((d) => d.title === 'Persisted')).toBe(true);
  });
});

describe('wiring — source contracts', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  const flat = (s: string) => s.replace(/\s+/g, ' ');

  it('delegations run through the SWARM runner (confinement + idle timeout + fallback reused, not duplicated)', () => {
    const mod = read('src/main/agent/background-delegations.ts');
    expect(mod).toContain("from './swarm-runner'");
    expect(mod).toContain('createSwarmRunner(');
  });

  it('sub-agent sessions now include WEB tools (research delegations are not blind)', () => {
    const runner = flat(read('src/main/agent/swarm-runner.ts'));
    expect(runner).toContain('customTools: buildWebTools(');
  });

  it('finished results are injected at the NEXT turn; running ones are marked every turn', () => {
    const agent = flat(read('src/main/agent/agent-runner.ts'));
    expect(agent).toContain('takePendingDelegationResults(session.id)');
    expect(agent).toContain('describeRunningDelegations(session.id)');
    expect(agent).toContain('buildAgentMetaTools({ sessionId: session.id, cwd: effectiveCwd })');
  });

  it('the tools are registered and the delegate tool acknowledges without awaiting', () => {
    const tools = read('src/main/tools/dynamic-tool-creator.ts');
    expect(tools).toContain("name: 'delegate_background_task'");
    expect(tools).toContain("name: 'background_task_status'");
    expect(tools).toContain('startDelegation({');
    // The execute body must not await the sub-agent: it returns the ack right away.
    expect(tools).not.toContain('await startDelegation');
  });
});