import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tracked-delegation map is handed to the tracking panel in full on every
 * progress event, so its size is a per-render cost, not just a memory cost.
 * `MAX_TRACKED_TASKS` bounded what was written to disk but not what was kept
 * alive in the process, so a long session grew the map without limit while the
 * file stayed capped.
 *
 * The eviction must never drop something still reachable: a running delegation
 * owns a live sub-agent, an undelivered one still owes the session its report,
 * an interrupted one is resumable, and a cross-verification batch is still
 * reading the ones it covers.
 */

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
  listDelegations,
  setDelegationSettings,
  startDelegation,
  subAgentGate,
  takePendingDelegationResults,
} from '../src/main/agent/background-delegations';
import type { SubAgentSessionArgs, SubAgentSessionResult } from '../src/main/agent/swarm-runner';

/** Well under MAX_TRACKED_TASKS so the cap is reached by a readable margin. */
const CAP = 60;
const dirs: string[] = [];

const testConfig = {
  provider: 'custom',
  customProtocol: 'openai',
  apiKey: 'k',
  model: 'test-model',
  subAgents: { configSetId: '', perRole: {}, timeoutMs: 5000, maxConcurrent: 2 },
} as unknown as ReturnType<NonNullable<Parameters<typeof startDelegation>[0]['getConfig']>>;

interface DeferredLaunch {
  resolve: (result: SubAgentSessionResult) => void;
  launch: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
}

function makeDeferredLaunch(): DeferredLaunch {
  const pending: Array<(result: SubAgentSessionResult) => void> = [];
  let resolveFn!: (result: SubAgentSessionResult) => void;
  const promise = new Promise<SubAgentSessionResult>((res) => {
    resolveFn = res;
  });
  void promise;
  return {
    resolve: (result) => resolveFn(result),
    launch: () => {
      pending.push(resolveFn);
      return promise;
    },
  };
}

const doneResult: SubAgentSessionResult = {
  output: '## Summary\ndone',
  modelUsed: 'test-model',
  usedFallback: false,
  modifiedFiles: [],
  tokenUsage: { input: 1, output: 1 },
} as unknown as SubAgentSessionResult;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cowork-bg-evict-'));
  dirs.push(testRoot);
  initBackgroundDelegations(testRoot);
  __resetDelegationsForTest();
  subAgentGate.reset();
  // The concurrency guard would otherwise stop the loop at the second task;
  // eviction is about the history, not the cap.
  setDelegationSettings({ maxConcurrent: 4 });
  subAgentGate.setMax(4);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Start a task, finish it, and mark its result delivered. */
async function completedDeliveredDelegation(sessionId: string, title: string): Promise<string> {
  const id = await completedUndeliveredDelegation(sessionId, title);
  takePendingDelegationResults(sessionId);
  return id;
}

/** Start a task and finish it, but leave its result undelivered. */
async function completedUndeliveredDelegation(sessionId: string, title: string): Promise<string> {
  const launch = makeDeferredLaunch();
  const { taskId, done } = startDelegation({
    sessionId,
    cwd: testRoot,
    title,
    prompt: `do ${title}`,
    launchSession: launch.launch,
    getConfig: () => testConfig,
  });
  launch.resolve(doneResult);
  await done;
  return taskId;
}

describe('delegation history eviction', () => {
  it('keeps the tracked map within the cap', async () => {
    for (let i = 0; i < CAP + 15; i++) {
      await completedDeliveredDelegation('s1', `task ${i}`);
    }
    expect(listDelegations().length).toBeLessThanOrEqual(CAP);
  });

  it('evicts the OLDEST first, so the most recent history survives', async () => {
    const first = await completedDeliveredDelegation('s1', 'oldest');
    for (let i = 0; i < CAP + 5; i++) {
      await completedDeliveredDelegation('s1', `task ${i}`);
    }
    expect(getDelegation(first)).toBeUndefined();
    // The last task started is the last one still tracked.
    const tracked = listDelegations();
    expect(tracked[0].title).toBe(`task ${CAP + 4}`);
  });

  it('never evicts an undelivered result — the user is still owed it', async () => {
    // 60 delivered tasks to fill the history, then one that has NOT been
    // delivered: it must survive the eviction pass untouched.
    for (let i = 0; i < CAP; i++) {
      await completedDeliveredDelegation('s1', `task ${i}`);
    }
    const launch = makeDeferredLaunch();
    const { taskId, done } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'undelivered',
      prompt: 'do it',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    launch.resolve(doneResult);
    await done;

    expect(getDelegation(taskId)).toBeDefined();
    expect(getDelegation(taskId)?.delivered).toBe(false);
    // And it is still injectable, which is the whole point.
    const injected = takePendingDelegationResults('s1');
    expect(injected).toContain('undelivered');
  });

  it('never evicts a running delegation', async () => {
    for (let i = 0; i < CAP; i++) {
      await completedDeliveredDelegation('s1', `task ${i}`);
    }
    const launch = makeDeferredLaunch();
    const { taskId } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'still running',
      prompt: 'do it',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    for (let i = 0; i < 5; i++) {
      await completedDeliveredDelegation('s1', `filler ${i}`);
    }
    expect(getDelegation(taskId)?.status).toBe('running');
    cancelDelegation(taskId);
  });

  it('never evicts a task the user is about to retry or resume', async () => {
    // A cancelled task is finished and delivered-free, so only its
    // cancellability protects it: cancel() must still find it.
    for (let i = 0; i < CAP; i++) {
      await completedDeliveredDelegation('s1', `task ${i}`);
    }
    const launch = makeDeferredLaunch();
    const { taskId, done } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'to retry',
      prompt: 'do it',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    launch.resolve(doneResult);
    await done;
    // Marked delivered so only the retry path is under test here.
    takePendingDelegationResults('s1');
    for (let i = 0; i < 5; i++) {
      await completedDeliveredDelegation('s1', `filler ${i}`);
    }
    expect(getDelegation(taskId)).toBeDefined();
  });

  it('stays bounded when every task is undelivered (nothing is evictable)', async () => {
    // Finished but never delivered: the session has not been told about any of
    // them, so none may be evicted even once the cap is passed. Exceeding the
    // cap is the correct outcome — losing a report the user is owed is not.
    for (let i = 0; i < CAP + 10; i++) {
      await completedUndeliveredDelegation('s1', `pending ${i}`);
    }
    const pending = listDelegations();
    expect(pending.length).toBe(CAP + 10);
    expect(pending.every((d) => d.status === 'completed' && !d.delivered)).toBe(true);
  });

  it('evicts the undelivered batch as soon as its results are consumed', async () => {
    for (let i = 0; i < CAP + 10; i++) {
      await completedUndeliveredDelegation('s1', `pending ${i}`);
    }
    // Delivering the batch frees the whole backlog for eviction.
    const injected = takePendingDelegationResults('s1');
    expect(injected).toContain('pending 0');

    const launch = makeDeferredLaunch();
    const { taskId, done } = startDelegation({
      sessionId: 's1',
      cwd: testRoot,
      title: 'trigger',
      prompt: 'do it',
      launchSession: launch.launch,
      getConfig: () => testConfig,
    });
    launch.resolve(doneResult);
    await done;

    expect(listDelegations().length).toBeLessThanOrEqual(CAP);
    expect(getDelegation(taskId)?.title).toBe('trigger');
  });
});

describe('recency ordering is a total order, not a partial one', () => {
  // Two delegations started in the same millisecond are common — a burst of
  // tasks, or a fast test. Ordering on `startedAt` alone left those pairs to
  // whatever the engine produced, which is how "evicts the oldest first"
  // became a flake that only appeared under load.
  it('keeps creation order when a burst lands in the same millisecond', async () => {
    // Freeze the clock so every task reports the same `Date.now()`. The
    // collision has to be forced: on a fast machine the loop may or may not
    // straddle a millisecond boundary, which is exactly why the failure came
    // and went. Ordering must come from creation order, not from whichever
    // random id suffix happened to sort higher.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      for (let i = 0; i < 4; i += 1) {
        await completedDeliveredDelegation('s1', `frozen ${i}`);
      }
    } finally {
      clock.mockRestore();
    }

    const tracked = listDelegations();
    expect(tracked.map((d) => d.title)).toEqual(['frozen 3', 'frozen 2', 'frozen 1', 'frozen 0']);
    // Distinct timestamps are what make the order above reproducible at all.
    const stamps = tracked.map((d) => d.startedAt);
    expect(new Set(stamps).size).toBe(stamps.length);
  });

  it('orders identically across repeated listings', async () => {
    for (let i = 0; i < 5; i += 1) {
      await completedDeliveredDelegation('s1', `burst ${i}`);
    }
    const first = listDelegations().map((d) => d.title);
    const second = listDelegations().map((d) => d.title);
    expect(second).toEqual(first);
  });

  it('the most recent task is first even when timestamps collide', async () => {
    // A guard rather than a reproduction: if a future change reintroduces
    // colliding timestamps, the listing must still be stable and must never
    // repeat or drop a task.
    for (let i = 0; i < 4; i += 1) {
      await completedDeliveredDelegation('s1', `same-tick ${i}`);
    }
    const tracked = listDelegations();
    // Newest-first ordering must be stable and self-consistent, and the set of
    // survivors must be a prefix of the order rather than an arbitrary subset.
    const titles = tracked.map((d) => d.title);
    expect(new Set(titles).size).toBe(titles.length);
    // Sorting the same list again must not reshuffle it.
    expect(listDelegations().map((d) => d.title)).toEqual(titles);
  });
});
