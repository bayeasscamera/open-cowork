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
  cancelDelegation,
  retryDelegation,
  deleteDelegation,
  getDelegationSettings,
  setDelegationSettings,
  getDelegationStats,
  parseDelegationReport,
  subAgentGate,
  runDelegationSync,
  buildSubAgentDelegationTool,
  MAX_DELEGATION_DEPTH,
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
  subAgentGate.reset();
  subAgentGate.setMax(2);
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

  it('AUTONOMY: the launched prompt carries the no-questions contract and the report format', async () => {
    const launch = makeDeferredLaunch();
    startDelegation({
      sessionId: 's7',
      cwd: testRoot,
      title: 'Autonomous research',
      prompt: 'Research X',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    const sent = launch.calls[0].task.prompt;
    // The sub-agent is told explicitly: never ask back, signalled assumptions,
    // mandatory structured report sections.
    expect(sent).toContain('You work ALONE');
    expect(sent).toContain('make a reasonable assumption and record it');
    expect(sent).toContain('## Summary');
    expect(sent).toContain('## Assumptions');
    expect(sent).toContain('## Limits');
    expect(sent).toContain('## Modified files');
  });

  it('a completed delegation produces a PARSED structured report (UI-ready) and injection', async () => {
    const launch = makeDeferredLaunch();
    const { taskId } = startDelegation({
      sessionId: 's8',
      cwd: testRoot,
      title: 'Structured outcome',
      prompt: 'p',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    launch.resolve({
      output: [
        '## Summary',
        'Researched X across 5 sources.',
        '## Findings',
        'X leads in Europe.',
        '## Assumptions',
        'Assumed 2026 data.',
        '## Limits',
        'Could not access paywalled source.',
        '## Modified files',
        'notes.md',
      ].join('\n'),
      modifiedFiles: [join(testRoot, 'notes.md')],
    });
    await flushAsync();

    const task = listDelegations('s8').find((d) => d.id === taskId);
    expect(task?.status).toBe('completed');
    expect(task?.report?.summary).toBe('Researched X across 5 sources.');
    expect(task?.report?.findings).toBe('X leads in Europe.');
    expect(task?.report?.assumptions).toBe('Assumed 2026 data.');
    expect(task?.report?.limits).toBe('Could not access paywalled source.');
    expect(task?.modifiedFiles).toEqual([join(testRoot, 'notes.md')]);

    // Injection renders the structured sections for the model.
    const injected = takePendingDelegationResults('s8');
    expect(injected).toContain('Summary: Researched X across 5 sources.');
    expect(injected).toContain('Findings: X leads in Europe.');
    expect(injected).toContain('Assumptions: Assumed 2026 data.');
    expect(injected).toContain('Limits: Could not access paywalled source.');
  });

  it('CANCEL actually aborts the sub-agent session (AbortSignal fired) and the task never completes', async () => {
    const launch = makeDeferredLaunch();
    const { taskId } = startDelegation({
      sessionId: 's9',
      cwd: testRoot,
      title: 'Will be cancelled',
      prompt: 'p',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    expect(launch.calls[0]?.signal).toBeTruthy(); // a real AbortSignal was handed down

    expect(cancelDelegation(taskId)).toBe(true);
    expect(launch.calls[0].signal!.aborted).toBe(true); // the session is told to stop
    expect(listDelegations('s9')[0].status).toBe('cancelled');

    // Late completion of the aborted session must NOT resurrect the task nor
    // inject anything (no ghost result after a real cancellation).
    launch.resolve({ output: 'too late', modifiedFiles: [] });
    await flushAsync();
    expect(listDelegations('s9')[0].status).toBe('cancelled');
    expect(takePendingDelegationResults('s9')).toBe('');

    // Cancelling a non-running task is refused.
    expect(cancelDelegation(taskId)).toBe(false);
  });

  it('RETRY re-launches the same prompt as a new delegation (running task cannot retry)', async () => {
    const launch = makeDeferredLaunch();
    const { taskId } = startDelegation({
      sessionId: 's10',
      cwd: testRoot,
      title: 'To retry',
      prompt: 'original task text',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    // Running tasks cannot be retried.
    expect(retryDelegation(taskId)).toBeUndefined();

    // Fail it, then retry with the same overrides.
    launch.reject(new Error('boom'));
    await flushAsync();
    const retryLaunch = makeDeferredLaunch();
    const retried = retryDelegation(taskId, {
      launchSession: retryLaunch.launch,
      getConfig: () => testConfig,
    });
    expect(retried).toBeTruthy();
    expect(retried!.taskId).not.toBe(taskId); // a NEW delegation id
    await flushAsync();
    expect(retryLaunch.calls).toHaveLength(1);
    expect(retryLaunch.calls[0].task.prompt).toContain('original task text');
  });

  it('DELETE removes finished tasks from the tracking list (never a running one)', async () => {
    const launch = makeDeferredLaunch();
    const { taskId } = startDelegation({
      sessionId: 's11',
      cwd: testRoot,
      title: 'Deletable',
      prompt: 'p',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    expect(deleteDelegation(taskId)).toBe(false); // still running — refused

    launch.resolve({ output: 'done', modifiedFiles: [] });
    await flushAsync();
    expect(deleteDelegation(taskId)).toBe(true);
    expect(listDelegations('s11').find((d) => d.id === taskId)).toBeUndefined();
  });

  it('dedicated settings: normalize, persist, cap enforcement, notification flag', async () => {
    // Normalization + clamps.
    const saved = setDelegationSettings({
      configSetId: ' set-jan ',
      modelId: 'glm-x',
      timeoutMs: 50, // below floor
      maxConcurrent: 99, // above cap
    });
    expect(saved.configSetId).toBe('set-jan');
    expect(saved.modelId).toBe('glm-x');
    expect(saved.timeoutMs).toBe(10_000); // clamped to floor
    expect(saved.maxConcurrent).toBe(4); // clamped to cap
    expect(getDelegationSettings().notifyOnCompletion).toBe(true);

    // Settings file persisted separately from task state.
    expect(existsSync(join(testRoot, 'delegation_settings.json'))).toBe(true);

    // Concurrency cap enforced at start time. Reset the pin first: the test
    // config above has no 'set-jan', and an unresolvable profile would make
    // the first task fail instead of occupying the single slot.
    setDelegationSettings({ configSetId: '', modelId: null, maxConcurrent: 1 });
    const a = makeDeferredLaunch();
    startDelegation({
      sessionId: 's12',
      cwd: testRoot,
      title: 'First',
      prompt: 'p',
      launchSession: a.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    const b = makeDeferredLaunch();
    expect(() =>
      startDelegation({
        sessionId: 's12',
        cwd: testRoot,
        title: 'Second',
        prompt: 'p',
        launchSession: b.launch,
        getConfig: () => testConfig,
      })
    ).toThrow(/Max concurrent delegations/);
    expect(b.calls).toHaveLength(0); // never launched
  });

  it('live progress: tool calls stream into the task log and as progress events', async () => {
    const launch = makeDeferredLaunch();
    const { taskId } = startDelegation({
      sessionId: 's13',
      cwd: testRoot,
      title: 'Watched task',
      prompt: 'p',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();

    // Drive the onEvent hook the delegation handed to the launcher.
    const onEvent = launch.calls[0].onEvent;
    expect(onEvent).toBeTruthy();
    onEvent!({ toolName: 'web_search', at: Date.now() });
    expect(sendToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ eventKind: 'progress', summary: 'web_search' }),
      })
    );
    const task = listDelegations('s13').find((d) => d.id === taskId)!;
    expect(task.log.some((entry) => entry.kind === 'tool' && entry.text === 'web_search')).toBe(
      true
    );
    launch.resolve({ output: 'x', modifiedFiles: [] });
  });

  it('getDelegationStats aggregates totals, statuses and fallbacks', async () => {
    // Success WITH a real fallback: the pinned ConfigSet profile fails, the
    // swarm runner retries once on the active profile and reports usedFallback.
    const pinnedConfig = {
      ...testConfig,
      configSets: [
        {
          id: 'set-jan',
          name: 'JAN',
          provider: 'custom',
          customProtocol: 'openai',
          activeProfileKey: 'custom:openai',
          profiles: {
            'custom:openai': { apiKey: 'k', baseUrl: 'https://x/v1', model: 'jan-model' },
          },
        },
      ],
    } as unknown as typeof testConfig;
    setDelegationSettings({ configSetId: 'set-jan', maxConcurrent: 4 });
    let firstCall = true;
    let resolveSecond!: (r: SubAgentSessionResult) => void;
    const secondPromise = new Promise<SubAgentSessionResult>((res) => {
      resolveSecond = res;
    });
    const fallbackLaunch = ((args: SubAgentSessionArgs) => {
      if (firstCall) {
        firstCall = false;
        return Promise.reject(new Error('configured model down'));
      }
      void args;
      return secondPromise;
    }) as unknown as (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
    startDelegation({
      sessionId: 's14',
      cwd: testRoot,
      title: 'Fell back',
      prompt: 'p',
      launchSession: fallbackLaunch,
      getConfig: () => pinnedConfig,
    });
    await flushAsync();
    resolveSecond({ output: 'ok on active profile', modifiedFiles: [] });
    await flushAsync();

    const okTask = listDelegations('s14').find((d) => d.title === 'Fell back');
    expect(okTask?.status).toBe('completed');
    expect(okTask?.usedFallback).toBe(true);

    const bad = makeDeferredLaunch();
    startDelegation({
      sessionId: 's14',
      cwd: testRoot,
      title: 'Bad',
      prompt: 'p',
      launchSession: bad.launch,
      getConfig: () => pinnedConfig,
    });
    await flushAsync();
    bad.reject(new Error('nope'));
    await flushAsync();

    const stats = getDelegationStats();
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.completed).toBeGreaterThanOrEqual(1);
    expect(stats.failed).toBeGreaterThanOrEqual(1);
    expect(stats.fallbacks).toBe(1);
    // Reset the pin for any later test in this file.
    setDelegationSettings({ configSetId: '' });
  });
});

describe('parseDelegationReport', () => {
  it('falls back to a text summary when the sub-agent ignored the format', () => {
    const report = parseDelegationReport('Just a blob of free-form text, no sections at all.');
    expect(report.summary).toContain('Just a blob');
    expect(report.findings).toBe('');
  });
});

describe('RECURSIVE delegation — bounded hierarchy', () => {
  it('HARD CAP: depth > 2 is refused at the source, even with a leaked palette tool', () => {
    expect(MAX_DELEGATION_DEPTH).toBe(2);
    expect(() =>
      startDelegation({
        sessionId: 'r1',
        cwd: testRoot,
        title: 'Too deep',
        prompt: 'p',
        depth: 3, // a depth-2 agent attempting its own delegation
        launchSession: makeDeferredLaunch().launch,
        getConfig: () => testConfig,
      })
    ).toThrow(/depth 3 exceeds the hard cap/);
    expect(listDelegations().some((d) => d.title === 'Too deep')).toBe(false);
  });

  it('depth-2 delegation works; depth and parent linkage recorded for the UI', async () => {
    const childLaunch = makeDeferredLaunch();
    const { taskId } = startDelegation({
      sessionId: 'r2',
      cwd: testRoot,
      title: 'Parent',
      prompt: 'p',
      depth: 1,
      launchSession: makeDeferredLaunch().launch,
      getConfig: () => testConfig,
    });
    // The depth-1 sub-agent delegates its own subordinate (depth 2), waiting
    // synchronously for the report.
    const syncPromise = runDelegationSync({
      sessionId: 'r2',
      cwd: testRoot,
      title: 'Grandchild',
      prompt: 'subtask brief',
      depth: 2,
      parentTaskId: taskId,
      launchSession: childLaunch.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    expect(childLaunch.calls).toHaveLength(1);
    childLaunch.resolve({ output: 'grandchild findings', modifiedFiles: [] });
    const syncResult = await syncPromise;
    expect(syncResult.report.summary).toBe('grandchild findings');
    expect(syncResult.raw).toBe('grandchild findings');

    const child = listDelegations('r2').find((d) => d.title === 'Grandchild');
    expect(child?.depth).toBe(2);
    expect(child?.parentTaskId).toBe(taskId);
    expect(child?.cwd).toBe(testRoot); // SAME workspace as the parent chain
  });

  it('the GLOBAL gate bounds active sub-agents across levels', async () => {
    // Probed via the delegation records: maxConcurrent=1 means the second
    // start is refused even though the first is a depth-2 child.
    setDelegationSettings({ configSetId: '', timeoutMs: 5000, maxConcurrent: 1 });
    const first = makeDeferredLaunch();
    startDelegation({
      sessionId: 'r3',
      cwd: testRoot,
      title: 'Chain A',
      prompt: 'p',
      depth: 2,
      launchSession: first.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    expect(() =>
      startDelegation({
        sessionId: 'r3',
        cwd: testRoot,
        title: 'Chain B',
        prompt: 'p',
        depth: 1,
        launchSession: makeDeferredLaunch().launch,
        getConfig: () => testConfig,
      })
    ).toThrow(/Max concurrent delegations/);
    // Restore for other tests.
    setDelegationSettings({ configSetId: '', maxConcurrent: 2 });
  });

  it('child tokens roll up onto the parent delegation (honest whole-hierarchy cost)', async () => {
    const childLaunch = makeDeferredLaunch();
    const { taskId: parentId } = startDelegation({
      sessionId: 'r4',
      cwd: testRoot,
      title: 'Parent with child',
      prompt: 'p',
      depth: 1,
      launchSession: makeDeferredLaunch().launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    // Child runs and completes with its own token usage.
    const { taskId: childId } = startDelegation({
      sessionId: 'r4',
      cwd: testRoot,
      title: 'Recursive child',
      prompt: 'subtask',
      depth: 2,
      parentTaskId: parentId,
      launchSession: childLaunch.launch,
      getConfig: () => testConfig,
    });
    await flushAsync();
    childLaunch.resolve({
      output: 'child report',
      modifiedFiles: [],
      tokenUsage: { input: 700, output: 50 },
    });
    await flushAsync();

    const parent = listDelegations('r4').find((d) => d.id === parentId);
    // The parent's own session resolved with its tokens, PLUS the child's
    // usage rolled up — the hierarchy cost is cumulative, not per-level.
    // Parent had no own tokens; the child's usage rolled up onto it.
    expect(parent?.tokenUsage).toEqual({ input: 700, output: 50 });
    void childId;
  });

  it('the depth-2 palette OMITS the delegation tool (double enforcement)', () => {
    const depth1Tool = buildSubAgentDelegationTool({
      rootSessionId: 's',
      cwd: testRoot,
      depth: 1,
      parentTaskId: 'bg-p',
    });
    const depth2Tool = buildSubAgentDelegationTool({
      rootSessionId: 's',
      cwd: testRoot,
      depth: 2,
      parentTaskId: 'bg-p',
    });
    expect(depth1Tool.description).not.toContain('Delegation refused');
    expect(depth2Tool.description).toContain('depth cap (2 levels) is reached');
    // Even if invoked (leaked), the execute refuses without launching.
    void depth1Tool;
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
    expect(runner).toContain('...buildWebTools({');
  });

  it('finished results are injected at the NEXT turn; running ones are marked every turn', () => {
    const agent = flat(read('src/main/agent/agent-runner.ts'));
    // Prompt assembly (incl. delegation blocks) now lives in contextual-prompt.ts
    const promptAssembly = flat(read('src/main/agent/contextual-prompt.ts'));
    expect(promptAssembly).toContain('takePendingDelegationResults(deps.sessionId)');
    expect(promptAssembly).toContain('describeRunningDelegations(deps.sessionId)');
    expect(agent).toContain('assembleContextualPrompt({');
    // Tool assembly (incl. meta-tools) now lives in pi-session-tools.ts
    const toolsAssembly = flat(read('src/main/agent/pi-session-tools.ts'));
    expect(toolsAssembly).toContain(
      'buildAgentMetaTools({ sessionId: deps.sessionId, cwd: deps.cwd })'
    );
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
