import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  buildChildSystemPrompt,
  buildConfinementHook,
  collectModifiedPath,
  createSwarmRunner,
  resolveSubAgentProfile,
  SubAgentTaskTimeoutError,
  TaskSlotLimiter,
  withConfinement,
  withTaskTimeout,
  type SubAgentSessionArgs,
} from '../src/main/agent/swarm-runner';
import { ASK_TEAMMATE_TRIGGER_RULE } from '../src/main/agent/teammate-tool';
import {
  __resetTeammateTeamsForTest,
  getTeammateTeam,
  markTeammateBoundary,
  registerTeammate,
} from '../src/main/agent/teammate-bus';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createAgentSession } from '@mariozechner/pi-coding-agent';

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
      perRole: { reviewer: { configSetId: 'role-set' } },
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

  it('pins the exact model selected inside a configSet', () => {
    const config = makeConfig({
      configSetId: 'cheap',
      perRole: { developer: { configSetId: 'role-set', modelId: 'qwen3.6-35b-a3b:free' } },
    });
    const profile = resolveSubAgentProfile('developer', config);
    expect(profile.source).toBe('role');
    expect(profile.label).toBe('role-set/qwen3.6-35b-a3b:free');
    expect(profile.config.model).toBe('qwen3.6-35b-a3b:free');
    // Without a modelId the set's active model is used.
    expect(resolveSubAgentProfile('architect', config).label).toBe('cheap/cheap-model');
  });

  it('migrates legacy per-role string selections on read', () => {
    // The normalize step converts bare configSet ids to selections.
    const migrated = JSON.parse(
      JSON.stringify(makeConfig({ perRole: { reviewer: { configSetId: 'role-set' } } }))
    );
    expect(migrated.subAgents.perRole.reviewer).toEqual({
      configSetId: 'role-set',
      modelId: undefined,
    });
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

  it('routes critical-path tasks to the criticality tier', () => {
    const config = makeConfig({ criticality: { critical: { configSetId: 'default' } } });
    const profile = resolveSubAgentProfile('developer', config, true);
    expect(profile.source).toBe('criticality');
    expect(profile.label).toBe('default/main-model');
    expect(profile.config.apiKey).toBe('k-active');
  });

  it('routes non-critical tasks to the economical tier', () => {
    const config = makeConfig({ criticality: { economical: { configSetId: 'cheap' } } });
    const profile = resolveSubAgentProfile('security', config, false);
    expect(profile.source).toBe('criticality');
    expect(profile.label).toBe('cheap/cheap-model');
    expect(profile.config.apiKey).toBe('k-cheap');
  });

  it('lets the criticality tier override a per-role selection', () => {
    const config = makeConfig({
      configSetId: 'cheap',
      perRole: { reviewer: { configSetId: 'role-set' } },
      criticality: { critical: { configSetId: 'default' } },
    });
    // Reviewer is normally pinned to role-set, but on the critical path the
    // criticality tier wins.
    expect(resolveSubAgentProfile('reviewer', config, true).label).toBe('default/main-model');
    // Off the critical path the per-role selection still applies.
    expect(resolveSubAgentProfile('reviewer', config, false).source).toBe('role');
  });

  it('pins the model selected inside a criticality tier', () => {
    const config = makeConfig({
      criticality: { critical: { configSetId: 'cheap', modelId: 'strong-model' } },
    });
    const profile = resolveSubAgentProfile('architect', config, true);
    expect(profile.source).toBe('criticality');
    expect(profile.label).toBe('cheap/strong-model');
  });

  it('keeps the legacy precedence when no criticality tier is configured', () => {
    const config = makeConfig({});
    expect(resolveSubAgentProfile('reviewer', config, true).source).toBe('role');
    expect(resolveSubAgentProfile('reviewer', config, false).source).toBe('role');
    expect(resolveSubAgentProfile('developer', config, true).source).toBe('configSet');
    // Without an explicit criticality flag the static behaviour is unchanged.
    expect(resolveSubAgentProfile('reviewer', config).source).toBe('role');
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('degrades to the next level when the criticality configSet is unknown', () => {
    const config = makeConfig({ criticality: { critical: { configSetId: 'ghost' } } });
    const profile = resolveSubAgentProfile('reviewer', config, true);
    expect(profile.source).toBe('role');
    expect(profile.label).toBe('role-set/review-model');
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

  it('blocks writes through a symlink escaping the workspace', async () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'cowork-swarm-secret-'));
    try {
      writeFileSync(join(secretDir, 'target.txt'), 'secret');
      symlinkSync(join(secretDir, 'target.txt'), join(root, 'escape-link.txt'));
      const hook = buildConfinementHook(root);
      const blocked = await hook({ toolName: 'write', args: { path: 'escape-link.txt' } });
      expect(blocked?.block).toBe(true);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('blocks new files written through a symlinked directory', async () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'cowork-swarm-secret-'));
    try {
      const linkDir = join(root, 'linked');
      symlinkSync(secretDir, linkDir);
      const hook = buildConfinementHook(root);
      const blocked = await hook({ toolName: 'write', args: { path: 'linked/new.txt' } });
      expect(blocked?.block).toBe(true);
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
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

describe('withConfinement', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cowork-wrap-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fakeWriteTool(): { tool: AgentTool; execute: ReturnType<typeof vi.fn> } {
    const execute = vi.fn(async () => ({
      content: [{ type: 'text', text: 'written' }],
      details: undefined,
    }));
    const tool = {
      name: 'write',
      label: 'write',
      execute,
    } as unknown as AgentTool;
    return { tool, execute };
  }

  it('refuses calls escaping the workspace without invoking the real tool', async () => {
    const { tool, execute } = fakeWriteTool();
    const confined = withConfinement(tool, root);
    const result = await confined.execute('call-1', { path: '../escape.md' }, undefined, undefined);
    expect(execute).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Blocked'),
    });
  });

  it('lets confined calls reach the real tool', async () => {
    const { tool, execute } = fakeWriteTool();
    const confined = withConfinement(tool, root);
    const result = await confined.execute('call-2', { path: 'inside.md' }, undefined, undefined);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'written' });
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
    const launchSession = vi.fn(async (args: SubAgentSessionArgs) => ({
      output: `done:${args.config.model}`,
      modifiedFiles: [join(args.cwd, 'a.ts')],
    }));
    writeFileSync(join(cwd, 'a.ts'), 'export const a = 1;\n');
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
    const launchSession = vi.fn(async (args: SubAgentSessionArgs) => ({
      output: 'ok',
      modifiedFiles: [],
    }));
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
    writeFileSync(join(cwd, 'b.ts'), 'export const b = 1;\n');
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

  it('falls back when the sub-agent session is silent past the idle timeout', async () => {
    // First launch (cheap-model): a session that never emits events and never
    // resolves — the idle timeout aborts it. Second launch (fallback): works.
    let call = 0;
    vi.mocked(createAgentSession).mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        return {
          session: {
            subscribe: () => () => undefined,
            prompt: () => new Promise(() => undefined),
            abort: vi.fn(),
            dispose: vi.fn(),
          },
        } as never;
      }
      return {
        session: {
          subscribe: (cb: (event: unknown) => void) => {
            cb({
              type: 'agent_end',
              messages: [{ role: 'assistant', content: [{ type: 'text', text: 'recovered' }] }],
            });
            return () => undefined;
          },
          prompt: async () => undefined,
        },
      } as never;
    });
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({ timeoutMs: 50 }),
    });

    const result = await runner(makeTask('developer'), '');
    expect(result.usedFallback).toBe(true);
    expect(result.modelUsed).toBe('active/main-model');
    expect(result.output).toBe('recovered');
  });

  it('routes a per-role modelId to the exact sub-agent session config', async () => {
    const launchSession = vi.fn(async (args: SubAgentSessionArgs) => ({
      output: `done:${args.config.model}`,
      modifiedFiles: [],
    }));
    const runner = createSwarmRunner({
      cwd,
      getConfig: () =>
        makeConfig({
          perRole: { developer: { configSetId: 'role-set', modelId: 'qwen3.6-35b-a3b:free' } },
        }),
      launchSession,
    });

    const result = await runner(makeTask('developer'), '');

    expect(launchSession.mock.calls[0][0].config.model).toBe('qwen3.6-35b-a3b:free');
    expect(result).toMatchObject({
      output: 'done:qwen3.6-35b-a3b:free',
      usedFallback: false,
      modelUsed: 'role-set/qwen3.6-35b-a3b:free',
    });
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
    const developerCall = launchSession.mock.calls.find((c) => c[0].task.role === 'developer');
    expect(developerCall?.[0].context).toContain('architect');
  });

  function mockSessionEmitting(events: Array<{ type: string; message?: unknown }>): void {
    vi.mocked(createAgentSession).mockResolvedValue({
      session: {
        subscribe: (cb: (event: unknown) => void) => {
          for (const event of events) {
            cb(event);
          }
          return () => undefined;
        },
        prompt: async () => undefined,
      },
    } as never);
  }

  it('cumulates sub-agent token usage from message_end events', async () => {
    mockSessionEmitting([
      { type: 'message_end', message: { usage: { input: 100, output: 40 } } },
      { type: 'message_end', message: { usage: { input_tokens: 50, output_tokens: 10 } } },
    ]);
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({ configSetId: '', perRole: {} }),
    });

    const result = await runner(makeTask('developer'), '');

    expect(result.tokenUsage).toEqual({ input: 150, output: 50 });
  });

  it('leaves tokenUsage undefined when the provider reports no usage', async () => {
    mockSessionEmitting([{ type: 'message_end', message: {} }]);
    const runner = createSwarmRunner({
      cwd,
      getConfig: () => makeConfig({ configSetId: '', perRole: {} }),
    });

    const result = await runner(makeTask('developer'), '');

    expect(result.tokenUsage).toBeUndefined();
  });

  it('adds exactly the ask_teammate tool in team mode, and nothing on the default path', async () => {
    __resetTeammateTeamsForTest();
    const palettes: string[][] = [];
    vi.mocked(createAgentSession).mockImplementation(async (options) => {
      palettes.push((options.customTools ?? []).map((tool) => tool.name));
      return {
        session: { subscribe: () => () => undefined, prompt: async () => undefined },
      } as never;
    });
    const runner = createSwarmRunner({ cwd, getConfig: () => makeConfig({}) });

    const plain = await runner({ ...makeTask('developer'), id: 'plain-1' }, '');
    const teamed = await runner(
      { ...makeTask('developer'), id: 'teamed-1', teamMode: true, teamId: 'team-x' },
      ''
    );

    // Never-invoked team mode adds ZERO teammate exchanges and ZERO model calls.
    expect(plain.teammateExchanges).toBeUndefined();
    expect(teamed.teammateExchanges).toBeUndefined();
    expect(getTeammateTeam('team-x').exchanges).toHaveLength(0);

    // Strict structural proof: team mode adds exactly ONE tool, removes none.
    expect(palettes).toHaveLength(2);
    const [plainPalette, teamedPalette] = palettes;
    expect(plainPalette).not.toContain('ask_teammate');
    expect(teamedPalette).toContain('ask_teammate');
    expect(teamedPalette.filter((name) => !plainPalette.includes(name))).toEqual(['ask_teammate']);
    expect(plainPalette.filter((name) => !teamedPalette.includes(name))).toEqual([]);

    // The classic prompt is unchanged without team mode, and gains the rule with it.
    expect(buildChildSystemPrompt(makeTask('developer'))).not.toContain('ask_teammate');
    expect(buildChildSystemPrompt(makeTask('developer'))).toContain('Do not ask questions.');
    const teamedPrompt = buildChildSystemPrompt({
      ...makeTask('developer'),
      teamMode: true,
      teamId: 'team-x',
    });
    expect(teamedPrompt).toContain(ASK_TEAMMATE_TRIGGER_RULE);
    expect(teamedPrompt).not.toContain('Do not ask questions.');
  });

  it('team mode: a blocked sub-agent gets its teammate answer and the cost is traced', async () => {
    __resetTeammateTeamsForTest();
    const team = getTeammateTeam('team-e2e');
    registerTeammate(team, {
      role: 'architect',
      taskId: 'arch-1',
      responder: async () => 'Use FooService through the container.',
    });

    let toolText = '';
    vi.mocked(createAgentSession).mockImplementation(async (options) => {
      const askTool = (options.customTools ?? []).find((tool) => tool.name === 'ask_teammate');
      return {
        session: {
          subscribe: () => () => undefined,
          prompt: async () => {
            if (!askTool) return;
            const pending = askTool.execute('call-1', {
              target_role: 'architect',
              question: 'Which service?',
            });
            // The architect reaches a task boundary and answers.
            markTeammateBoundary(team, 'arch-1');
            const result = (await pending) as { content: Array<{ text: string }> };
            toolText = result.content[0].text;
          },
        },
      } as never;
    });

    const runner = createSwarmRunner({ cwd, getConfig: () => makeConfig({}) });
    const result = await runner(
      { ...makeTask('developer'), id: 'dev-1', teamMode: true, teamId: 'team-e2e' },
      ''
    );

    expect(toolText).toContain('Use FooService');
    expect(result.teammateExchanges).toHaveLength(1);
    expect(result.teammateExchanges?.[0]).toMatchObject({
      status: 'answered',
      targetRole: 'architect',
      fromTaskId: 'dev-1',
      modelCalls: 1,
    });
    // The member stops being answerable once its task is over.
    expect(getTeammateTeam('team-e2e').members.has('dev-1')).toBe(false);
  });
});
