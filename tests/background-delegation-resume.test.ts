import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  getDelegation,
  getDelegationSettings,
  initBackgroundDelegations,
  MAX_DELEGATION_RESUME_ATTEMPTS,
  normalizeDelegationSettings,
  resumeInterruptedDelegations,
  setDelegationSettings,
  startDelegation,
  subAgentGate,
  takePendingDelegationResults,
  type BackgroundDelegation,
} from '../src/main/agent/background-delegations';
import type { SubAgentSessionArgs, SubAgentSessionResult } from '../src/main/agent/swarm-runner';

type StartOptions = Parameters<typeof startDelegation>[0];
type ResumeStart = NonNullable<Parameters<typeof resumeInterruptedDelegations>[0]['start']>;

const STATE_FILE = 'background_delegations.json';
const SETTINGS_FILE = 'delegation_settings.json';
const dirs: string[] = [];

const testConfig = {
  provider: 'custom',
  customProtocol: 'openai',
  apiKey: 'k',
  model: 'test-model',
  subAgents: { configSetId: '', perRole: {}, timeoutMs: 5000, maxConcurrent: 2 },
} as unknown as ReturnType<NonNullable<StartOptions['getConfig']>>;

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cowork-bg-resume-'));
  dirs.push(testRoot);
  initBackgroundDelegations(testRoot);
  __resetDelegationsForTest();
  subAgentGate.reset();
  subAgentGate.setMax(2);
  mocks.log.mockClear();
  mocks.logWarn.mockClear();
  mocks.logError.mockClear();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRow(overrides: Partial<BackgroundDelegation> = {}): BackgroundDelegation {
  return {
    id: 'bg-old-1',
    sessionId: 's1',
    title: 'Interrupted research',
    prompt: 'Research the topic',
    role: 'developer',
    cwd: '/tmp/workspace',
    status: 'running',
    startedAt: 1000,
    depth: 1,
    delivered: false,
    log: [],
    ...overrides,
  };
}

/** Write persisted state (and optionally settings), then simulate a restart. */
function seed(rows: BackgroundDelegation[], settings?: Record<string, unknown>): void {
  writeFileSync(join(testRoot, STATE_FILE), JSON.stringify(rows, null, 2), 'utf-8');
  if (settings) {
    writeFileSync(join(testRoot, SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf-8');
  }
  initBackgroundDelegations(testRoot);
}

/** Resume harness: records the options, then really launches through startDelegation. */
function makeRealtimeStart(): { calls: StartOptions[]; start: ResumeStart } {
  const calls: StartOptions[] = [];
  const start: ResumeStart = (options) => {
    calls.push(options);
    return startDelegation({
      ...options,
      getConfig: () => testConfig,
      launchSession: async (_args: SubAgentSessionArgs): Promise<SubAgentSessionResult> => ({
        output: '## Summary\nresumed\n\n## Findings\nok',
        modifiedFiles: [],
      }),
    });
  };
  return { calls, start };
}

describe('background delegations — resume after restart', () => {
  it('marks still-running rows as interrupted on load and queues them for the session', () => {
    seed([makeRow({ id: 'bg-old-1', sessionId: 's1' })]);

    const record = getDelegation('bg-old-1');
    expect(record?.status).toBe('failed');
    expect(record?.interrupted).toBe(true);
    expect(record?.error).toContain('restart');
    expect(takePendingDelegationResults('s1')).toContain('Interrupted by app restart');
  });

  it('does NOT resume when resumeOnRestart is off, but still tells the session it was interrupted', () => {
    seed([makeRow({ id: 'bg-old-1', sessionId: 's1' })], { resumeOnRestart: false });
    const { calls, start } = makeRealtimeStart();

    const result = resumeInterruptedDelegations({ start });

    expect(result).toEqual({ disabled: true, resumed: [], skipped: [] });
    expect(calls).toHaveLength(0);
    expect(takePendingDelegationResults('s1')).toContain('Interrupted by app restart');
  });

  it('resumes a top-level task with its stored prompt, workspace and role, and links both records', () => {
    seed([
      makeRow({
        id: 'bg-old-1',
        sessionId: 's1',
        title: 'Deep research',
        prompt: 'Research X deeply',
        role: 'developer',
        cwd: '/tmp/ws-one',
        crossVerify: true,
      }),
    ]);
    const { calls, start } = makeRealtimeStart();

    const result = resumeInterruptedDelegations({ start });

    expect(result.disabled).toBe(false);
    expect(result.resumed).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe('s1');
    expect(calls[0].prompt).toBe('Research X deeply');
    expect(calls[0].cwd).toBe('/tmp/ws-one');
    expect(calls[0].role).toBe('developer');
    expect(calls[0].depth).toBe(1);
    expect(calls[0].crossVerify).toBe(true);

    const newId = result.resumed[0];
    const replacement = getDelegation(newId);
    expect(replacement?.resumedFrom).toBe('bg-old-1');
    expect(replacement?.resumeAttempts).toBe(MAX_DELEGATION_RESUME_ATTEMPTS);
    expect(replacement?.log.some((entry) => entry.text.includes('Resumed after app restart'))).toBe(
      true
    );
    expect(getDelegation('bg-old-1')?.resumedBy).toBe(newId);

    const persisted = JSON.parse(
      readFileSync(join(testRoot, STATE_FILE), 'utf-8')
    ) as BackgroundDelegation[];
    expect(persisted.find((d) => d.id === 'bg-old-1')?.resumedBy).toBe(newId);
  });

  it('never resumes the same task twice in one run', () => {
    seed([makeRow({ id: 'bg-old-1', sessionId: 's1' })]);
    const { calls, start } = makeRealtimeStart();

    expect(resumeInterruptedDelegations({ start }).resumed).toHaveLength(1);
    const second = resumeInterruptedDelegations({ start });

    expect(second.resumed).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('bounds resumption across restarts: a resumed task interrupted again is not resumed forever', () => {
    seed([makeRow({ id: 'bg-old-1', sessionId: 's1' })]);
    const { start } = makeRealtimeStart();
    const first = resumeInterruptedDelegations({ start });
    expect(first.resumed).toHaveLength(1);

    // The re-launched task was still running when the app quit a second time.
    __resetDelegationsForTest();
    initBackgroundDelegations(testRoot);
    const second = resumeInterruptedDelegations({ start });

    expect(second.resumed).toEqual([]);
    const replacement = getDelegation(first.resumed[0]);
    expect(replacement?.interrupted).toBe(true);
    expect(replacement?.resumeAttempts).toBe(MAX_DELEGATION_RESUME_ATTEMPTS);
  });

  it('skips depth-2 children: the parent re-run recreates them', () => {
    seed([makeRow({ id: 'bg-child', depth: 2, parentTaskId: 'bg-parent' })]);
    const { calls, start } = makeRealtimeStart();

    const result = resumeInterruptedDelegations({ start });

    expect(result.resumed).toEqual([]);
    expect(result.skipped).toEqual(['bg-child']);
    expect(calls).toHaveLength(0);
    expect(getDelegation('bg-child')?.resumedBy).toBeUndefined();
  });

  it('keeps a task resumable when the launch fails', () => {
    seed([makeRow({ id: 'bg-old-1', sessionId: 's1' })]);
    let attempts = 0;
    const failing: ResumeStart = () => {
      attempts += 1;
      throw new Error('Max concurrent delegations reached (2)');
    };

    const result = resumeInterruptedDelegations({ start: failing });

    expect(result.resumed).toEqual([]);
    expect(result.skipped).toEqual(['bg-old-1']);
    expect(getDelegation('bg-old-1')?.resumedBy).toBeUndefined();
    expect(mocks.logWarn).toHaveBeenCalled();

    // Still resumable on the next startup.
    const retry = resumeInterruptedDelegations({ start: failing });
    expect(retry.skipped).toEqual(['bg-old-1']);
    expect(attempts).toBe(2);
  });

  it('defaults resumeOnRestart to true and round-trips it through the settings file', () => {
    expect(normalizeDelegationSettings({}).resumeOnRestart).toBe(true);
    expect(normalizeDelegationSettings({ resumeOnRestart: 'yes' }).resumeOnRestart).toBe(true);
    expect(normalizeDelegationSettings({ resumeOnRestart: false }).resumeOnRestart).toBe(false);

    const saved = setDelegationSettings({ resumeOnRestart: false });
    expect(saved.resumeOnRestart).toBe(false);
    expect(getDelegationSettings().resumeOnRestart).toBe(false);

    const raw = JSON.parse(readFileSync(join(testRoot, SETTINGS_FILE), 'utf-8')) as {
      resumeOnRestart: boolean;
    };
    expect(raw.resumeOnRestart).toBe(false);
  });
});
