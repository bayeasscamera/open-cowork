import { mkdtempSync, rmSync } from 'node:fs';
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
  DefaultResourceLoader: vi.fn(() => ({ reload: vi.fn() })),
  SessionManager: { inMemory: vi.fn() },
  SettingsManager: { inMemory: vi.fn() },
  AuthStorage: { create: vi.fn(() => ({ setRuntimeApiKey: vi.fn() })) },
  ModelRegistry: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
}));

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

import type { AppConfig } from '../src/main/config/config-store';
import type { AgentRole, AgentTask } from '../src/main/agent/multi-agent-coordinator';
import { MultiAgentCoordinator } from '../src/main/agent/multi-agent-coordinator';
import {
  buildConfinementHook,
  collectModifiedPath,
  createSwarmRunner,
  resolveSubAgentProfile,
  SubAgentTaskTimeoutError,
  TaskSlotLimiter,
  withTaskTimeout,
  type SubAgentSessionArgs,
} from '../src/main/agent/swarm-runner';

function makeConfig(subAgents: Partial<AppConfig['subAgents']>): AppConfig {
  const profile = (apiKey: string, baseUrl: string, model: string) => ({
    apiKey,
    baseUrl,
    model,
  });
  return {
    provider: 'custom',
    customProtocol: 'openai',
    apiKey: 'k-active',
    baseUrl: 'https://active.test/v1',
    model: 'main-model',
    activeProfileKey: 'custom:openai',
    profiles: {},
    activeConfigSetId: 'default',
    configSets: [
      {
        id: 'default',
        name: 'Main',
        provider: 'custom',
        customProtocol: 'openai',
        activeProfileKey: 'custom:openai',
        profiles: { 'custom:openai': profile('k-active', 'https://active.test/v1', 'main-model') },
        enableThinking: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'cheap',
        name: 'Cheap',
        provider: 'custom',
        customProtocol: 'openai',
        activeProfileKey: 'custom:openai',
        profiles: { 'custom:openai': profile('k-cheap', 'https://cheap.test/v1', 'cheap-model') },
        enableThinking: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'role-set',
        name: 'Role',
        provider: 'custom',
        customProtocol: 'openai',
        activeProfileKey: 'custom:openai',
        profiles: { 'custom:openai': profile('k-role', 'https://role.test/v1', 'review-model') },
        enableThinking: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    defaultWorkdir: '',
    globalSkillsPath: '',
    enableDevLogs: false,
    theme: 'light',
    sandboxEnabled: false,
    memoryEnabled: true,
    coworkInstructions: '',
    tavilyApiKey: '',
    braveApiKey: '',
    trayEnabled: true,
    memoryRuntime: {
      llm: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: '',
        timeoutMs: 180_000,
      },
      embedding: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: 'text-embedding-3-small',
        timeoutMs: 180_000,
      },
      useEmbedding: false,
      maxNavSteps: 2,
      ingestionConcurrency: 1,
    },
    enableThinking: false,
    isConfigured: true,
    subAgents: {
      configSetId: 'cheap',
      perRole: { reviewer: 'role-set' },
      timeoutMs: 120_000,
      maxConcurrent: 2,
      ...subAgents,
    },
  };
}

function makeTask(role: AgentRole): AgentTask {
  return { id: `t-${role}`, role, title: role, prompt: `do ${role}`, status: 'pending' };
}

describe('resolveSubAgentProfile', () => {
  it('per-role override wins over the configSet', () => {
    const profile = resolveSubAgentProfile('reviewer', makeConfig({}));
    expect(profile.source).toBe('role');
    expect(profile.label).toBe('role-set/review-model');
    expect(profile.config.model).toBe('review-model');
    expect(profile.config.apiKey).toBe('k-role');
  });

  it('falls back to the sub-agents configSet for un-overridden roles', () => {
    const profile = resolveSubAgentProfile('developer', makeConfig({}));
    expect(profile.source).toBe('configSet');
    expect(profile.label).toBe('cheap/cheap-model');
    expect(profile.config.apiKey).toBe('k-cheap');
  });

  it('inherits the active profile by default', () => {
    const config = makeConfig({ configSetId: '', perRole: {} });
    const profile = resolveSubAgentProfile('architect', config);
    expect(profile.source).toBe('inherited');
    expect(profile.config).toBe(config);
    expect(profile.label).toBe('active/main-model');
  });

  it('degrades to inheritance when configured ids do not exist', () => {
    const config = makeConfig({
      configSetId: 'missing',
      perRole: { reviewer: 'ghost' },
    });
    const profile = resolveSubAgentProfile('reviewer', config);
    expect(profile.source).toBe('inherited');
    expect(mocks.logWarn).toHaveBeenCalled();
  });
});

describe('buildConfinementHook', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cowork-swarm-confine-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks write calls escaping the workspace', async () => {
    const hook = buildConfinementHook(root);
    const blocked = await hook({ toolName: 'write', args: { path: '../outside.md' } });
    expect(blocked).toEqual({ block: true, reason: expect.stringContaining('escapes') });
  });

  it('blocks absolute paths outside the workspace', async () => {
    const hook = buildConfinementHook(root);
    const blocked = await hook({ toolName: 'write', args: { path: '/etc/passwd' } });
    expect(blocked?.block).toBe(true);
  });

  it('allows paths inside the workspace', async () => {
    const hook = buildConfinementHook(root);
    const allowed = await hook({ toolName: 'write', args: { path: 'notes/a.md' } });
    expect(allowed).toBeUndefined();
  });

  it('also confines read calls outside the workspace', async () => {
    const hook = buildConfinementHook(root);
    const blocked = await hook({ toolName: 'read', args: { path: '../../secrets.env' } });
    expect(blocked?.block).toBe(true);
  });

  it('ignores calls without a path argument', async () => {
    const hook = buildConfinementHook(root);
    const result = await hook({ toolName: 'write', args: { content: 'no path' } });
    expect(result).toBeUndefined();
  });
});

describe('collectModifiedPath', () => {
  const root = '/workspace';

  it('records confined write and edit paths as absolute paths', () => {
    expect(collectModifiedPath(root, 'write', { path: 'a.md' })).toBe('/workspace/a.md');
    expect(collectModifiedPath(root, 'edit', { path: 'sub/b.md' })).toBe('/workspace/sub/b.md');
  });

  it('ignores reads and paths escaping the workspace', () => {
    expect(collectModifiedPath(root, 'read', { path: 'a.md' })).toBeNull();
    expect(collectModifiedPath(root, 'write', { path: '../x.md' })).toBeNull();
    expect(collectModifiedPath(root, 'edit', { path: '/etc/hosts' })).toBeNull();
  });
});

describe('withTaskTimeout', () => {
  it('returns the work result when it completes in time', async () => {
    const value = await withTaskTimeout(async () => 'ok', 5_000, 'task');
    expect(value).toBe('ok');
  });

  it('aborts and rejects slow work with a typed timeout error', async () => {
    let aborted = false;
    await expect(
      withTaskTimeout(
        (signal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              reject(new Error('work aborted'));
            });
          }),
        30,
        'slow-task'
      )
    ).rejects.toBeInstanceOf(SubAgentTaskTimeoutError);
    expect(aborted).toBe(true);
  });
});

describe('TaskSlotLimiter', () => {
  it('bounds concurrency and hands freed slots to waiters', async () => {
    const limiter = new TaskSlotLimiter(2);
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.activeCount).toBe(2);

    const third = limiter.acquire().then(() => limiter.activeCount);
    await Promise.resolve();
    expect(limiter.activeCount).toBe(2);

    limiter.release();
    expect(await third).toBe(2);
    limiter.release();
    limiter.release();
    expect(limiter.activeCount).toBe(0);
  });
});

describe('createSwarmRunner', () => {
  let cwd: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), 'cowork-swarm-runner-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('routes the distinct sub-agent model and reports it', async () => {
    const launchSession = vi.fn(
      async (args: SubAgentSessionArgs) => ({
        output: `done:${args.config.model}`,
        modifiedFiles: [join(args.cwd, 'a.ts')],
      })
    );
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({}),
      launchSession,
    });

    const result = await runner(makeTask('developer'), '');

    expect(launchSession).toHaveBeenCalledTimes(1);
    expect(launchSession.mock.calls[0][0].config.model).toBe('cheap-model');
    expect(result).toEqual({
      output: 'done:cheap-model',
      modifiedFiles: [join(cwd, 'a.ts')],
      usedFallback: false,
      modelUsed: 'cheap/cheap-model',
    });
  });

  it('uses the per-role model for the reviewer role', async () => {
    const launchSession = vi.fn(
      async (args: SubAgentSessionArgs) => ({ output: 'ok', modifiedFiles: [] })
    );
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({}),
      launchSession,
    });
    await runner(makeTask('reviewer'), '');
    expect(launchSession.mock.calls[0][0].config.model).toBe('review-model');
  });

  it('falls back to the active profile exactly once when the sub-agent model fails', async () => {
    const launchSession = vi.fn(async (args: SubAgentSessionArgs) => {
      if (args.config.model === 'cheap-model') {
        throw new Error('429 rate limit exceeded');
      }
      return { output: 'recovered', modifiedFiles: [join(args.cwd, 'b.ts')] };
    });
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({}),
      launchSession,
    });

    const result = await runner(makeTask('developer'), '');

    expect(launchSession).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      output: 'recovered',
      modifiedFiles: [join(cwd, 'b.ts')],
      usedFallback: true,
      modelUsed: 'active/main-model',
    });
    const warn = mocks.logWarn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(warn).toContain('cheap/cheap-model');
    expect(warn).toContain('falling back to "active/main-model"');
  });

  it('propagates the failure without a fallback loop when already inherited', async () => {
    const launchSession = vi.fn(async () => {
      throw new Error('provider down');
    });
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({ configSetId: '', perRole: {} }),
      launchSession,
    });

    await expect(runner(makeTask('developer'), '')).rejects.toThrow('provider down');
    expect(launchSession).toHaveBeenCalledTimes(1);
  });

  it('falls back when the sub-agent model times out', async () => {
    const launchSession = vi.fn(async (args: SubAgentSessionArgs) => {
      if (args.config.model === 'cheap-model') {
        return new Promise<{ output: string; modifiedFiles: string[] }>(() => undefined);
      }
      return { output: 'slow recovered', modifiedFiles: [] };
    });
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({ timeoutMs: 50 }),
      launchSession,
    });

    const result = await runner(makeTask('developer'), '');
    expect(result.usedFallback).toBe(true);
    expect(result.modelUsed).toBe('active/main-model');
    expect(result.output).toBe('slow recovered');
  });

  it('caps concurrent sub-agents at maxConcurrent', async () => {
    let active = 0;
    let peak = 0;
    const launchSession = vi.fn(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { output: 'ok', modifiedFiles: [] };
    });
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({ maxConcurrent: 1 }),
      launchSession,
    });

    const results = await Promise.all([
      runner(makeTask('architect'), ''),
      runner(makeTask('developer'), ''),
      runner(makeTask('security'), ''),
    ]);

    expect(peak).toBe(1);
    expect(results.every((r) => r.output === 'ok')).toBe(true);
  });

  it('runs a full plan through the coordinator with per-task model traces', async () => {
    const launchSession = vi.fn(async (args: SubAgentSessionArgs) => ({
      output: `${args.task.role}:${args.config.model}`,
      modifiedFiles: [join(cwd, `${args.task.role}.txt`)],
    }));
    const coordinator = new MultiAgentCoordinator();
    coordinator.setRunner(
      createSwarmRunner({ cwd, getConfig: () => makeConfig({}), launchSession })
    );

    const plan = coordinator.createCollaborativePlan('e2e goal');
    const executed = await coordinator.executePlan(plan.id);

    expect(executed.status).toBe('done');
    expect(executed.tasks.every((t) => t.status === 'completed')).toBe(true);
    const byRole = new Map(executed.tasks.map((t) => [t.role, t]));
    expect(byRole.get('reviewer')?.modelUsed).toBe('role-set/review-model');
    expect(byRole.get('developer')?.modelUsed).toBe('cheap/cheap-model');
    expect(byRole.get('architect')?.modelUsed).toBe('cheap/cheap-model');
    expect(byRole.get('developer')?.usedFallback).toBeFalsy();
    expect(byRole.get('developer')?.modifiedFiles).toEqual([join(cwd, 'developer.txt')]);
    // The DAG dependency context flows into the sessions.
    const developerCall = launchSession.mock.calls.find(
      (c) => c[0].task.role === 'developer'
    );
    expect(developerCall?.[0].context).toContain('architect');
  });
});