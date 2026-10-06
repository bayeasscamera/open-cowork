/**
 * Tests for the cold-start pi session factory extracted from run().
 *
 * The SDK, the model registry and the compaction extension are mocked, so the
 * compaction tuning, the cache eviction, the hook order and the exact session
 * options can be pinned without a live session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  createAgentSession: vi.fn(),
  inMemorySession: vi.fn(() => ({ kind: 'session-manager' })),
  inMemorySettings: vi.fn((options) => ({ kind: 'settings-manager', options })),
  reload: vi.fn(async () => undefined),
  resourceLoaderCtor: vi.fn(),
  createCompactionExtensionFactory: vi.fn((options) => ({ factory: options })),
  modelRegistryCtor: vi.fn(),
  getAgentDir: vi.fn(() => '/tmp/cowork-pi-agent'),
}));

vi.mock('../src/main/utils/logger', () => ({ log: mocks.log, logWarn: mocks.logWarn }));
vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mocks.createAgentSession,
  createCodingTools: vi.fn(),
  getAgentDir: mocks.getAgentDir,
  SessionManager: { inMemory: mocks.inMemorySession },
  SettingsManager: { inMemory: mocks.inMemorySettings },
  DefaultResourceLoader: class {
    constructor(options: unknown) {
      mocks.resourceLoaderCtor(options);
    }
    reload() {
      return mocks.reload();
    }
  },
}));
vi.mock('../src/main/agent/shared-auth', () => ({
  // pi-coding-agent 0.73 made the ModelRegistry constructor private; the app
  // goes through the `create` factory now.
  ModelRegistry: class {
    static create(authStorage: unknown) {
      mocks.modelRegistryCtor(authStorage);
      return {};
    }
  },
}));
vi.mock('../src/main/agent/compaction-extension', () => ({
  createCompactionExtensionFactory: mocks.createCompactionExtensionFactory,
}));

import { createPiSession, type CreatePiSessionDeps } from '../src/main/agent/create-pi-session';
import type { Session } from '../src/shared/types';

const piSession = { id: 'pi-session', dispose: vi.fn() };

function makeDeps(over: Partial<CreatePiSessionDeps> = {}): CreatePiSessionDeps {
  return {
    session: { id: 'sess-1' } as Session,
    piModel: {
      id: 'model-1',
      provider: 'anthropic',
      api: 'anthropic',
      contextWindow: 200000,
    } as unknown as CreatePiSessionDeps['piModel'],
    thinkingLevel: 'medium' as CreatePiSessionDeps['thinkingLevel'],
    authStorage: {} as CreatePiSessionDeps['authStorage'],
    cwd: '/work',
    skillPaths: ['/skills'],
    coworkAppendPrompt: 'APPEND',
    provider: 'anthropic',
    customProtocol: undefined,
    effectiveBaseUrl: 'https://api.example',
    tools: [] as CreatePiSessionDeps['tools'],
    customTools: [] as CreatePiSessionDeps['customTools'],
    runtimeSignature: 'runtime-sig',
    skillsSignature: 'skills-sig',
    sessionContextSignature: 'ctx-sig',
    sessions: new Map(),
    maxCachedSessions: 50,
    installPermissionHook: vi.fn(),
    installModsHooks: vi.fn(),
    installPayloadHook: vi.fn(),
    ...over,
  };
}

function compactionOf(callIndex = 0) {
  return mocks.inMemorySettings.mock.calls[callIndex][0].compaction;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAgentSession.mockResolvedValue({ session: piSession });
  mocks.inMemorySettings.mockImplementation((options) => ({ kind: 'settings-manager', options }));
  mocks.createCompactionExtensionFactory.mockImplementation((options) => ({ factory: options }));
});

describe('createPiSession', () => {
  it('returns the created session and stores it in the cache', async () => {
    const deps = makeDeps();

    const created = await createPiSession(deps);

    expect(created).toBe(piSession);
    expect(deps.sessions.get('sess-1')).toEqual({
      session: piSession,
      modelId: 'model-1',
      thinkingLevel: 'medium',
      runtimeSignature: 'runtime-sig',
      skillsSignature: 'skills-sig',
      sessionContextSignature: 'ctx-sig',
    });
  });

  it('installs permission, mods then payload hooks in order', async () => {
    const order: string[] = [];
    mocks.createAgentSession.mockImplementation(async () => {
      order.push('create');
      return { session: piSession };
    });
    const deps = makeDeps({
      installPermissionHook: vi.fn(() => order.push('permission')),
      installModsHooks: vi.fn(() => order.push('mods')),
      installPayloadHook: vi.fn(() => order.push('payload')),
    });

    await createPiSession(deps);

    expect(order).toEqual(['create', 'permission', 'mods', 'payload']);
  });

  it('evicts and disposes the oldest cached session when full', async () => {
    const oldest = { session: { dispose: vi.fn() } };
    const deps = makeDeps({
      maxCachedSessions: 1,
      sessions: new Map([['old', oldest as never]]),
    });

    await createPiSession(deps);

    expect(oldest.session.dispose).toHaveBeenCalledTimes(1);
    expect(deps.sessions.has('old')).toBe(false);
    expect(deps.sessions.has('sess-1')).toBe(true);
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Evicted oldest cached session:',
      'old'
    );
  });

  it('still evicts the oldest session when its dispose throws', async () => {
    const oldest = {
      session: {
        dispose: vi.fn(() => {
          throw new Error('boom');
        }),
      },
    };
    const deps = makeDeps({
      maxCachedSessions: 1,
      sessions: new Map([['old', oldest as never]]),
    });

    await createPiSession(deps);

    expect(deps.sessions.has('old')).toBe(false);
    expect(deps.sessions.has('sess-1')).toBe(true);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] dispose error on eviction:',
      expect.any(Error)
    );
  });

  it('keeps the cache untouched while under the limit', async () => {
    const deps = makeDeps({ maxCachedSessions: 5, sessions: new Map([['a', {} as never]]) });

    await createPiSession(deps);

    expect(deps.sessions.has('a')).toBe(true);
    expect(deps.sessions.size).toBe(2);
  });

  it('scales the compaction reserve with the window for non-Ollama providers', async () => {
    // Not the SDK's fixed 16 384 reserve: `shouldCompact` is
    // `tokens > window - reserveTokens`, so a fixed reserve only behaves like a
    // threshold on a 128k window and delays compaction to 98.4% of a 1M one —
    // late enough that the turn in flight has already overflowed. The reserve
    // is derived from the window so the trigger lands at ~80% on every model.
    await createPiSession(makeDeps());

    const compaction = compactionOf();
    // The fixture model advertises a 200 000-token window.
    const CONTEXT_WINDOW = 200_000;
    expect(compaction.enabled).toBe(true);
    expect(compaction.reserveTokens).toBe(CONTEXT_WINDOW * 0.2);
    expect(compaction.reserveTokens).toBeGreaterThan(16_384);
    // The reserve is 20% of the window, so compaction triggers at 80% of it
    // (200k - 40k = 160k) instead of the SDK's 91.8% (200k - 16 384).
    expect(compaction.reserveTokens / CONTEXT_WINDOW).toBeCloseTo(0.2, 2);
  });

  it('disables compaction for small Ollama contexts', async () => {
    await createPiSession(
      makeDeps({
        provider: 'ollama',
        piModel: { id: 'm', provider: 'ollama', api: 'openai', contextWindow: 8192 } as never,
      })
    );

    expect(compactionOf()).toEqual({ enabled: false });
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Ollama small context model, disabling auto-compaction (contextWindow:',
      8192,
      ')'
    );
  });

  it('scales compaction reserves for medium Ollama contexts', async () => {
    await createPiSession(
      makeDeps({
        provider: 'ollama',
        piModel: { id: 'm', provider: 'ollama', api: 'openai', contextWindow: 32768 } as never,
      })
    );

    expect(compactionOf()).toEqual({
      enabled: true,
      reserveTokens: Math.floor(32768 * 0.15),
      keepRecentTokens: Math.floor(32768 * 0.25),
    });
  });

  it('builds the resource loader with skills, system prompt and compaction extension', async () => {
    await createPiSession(makeDeps());

    expect(mocks.createCompactionExtensionFactory).toHaveBeenCalledWith({
      customInstructions: undefined,
      pruneToolOutputAbove: 500,
      keepRecentToolResults: 3,
    });
    expect(mocks.resourceLoaderCtor).toHaveBeenCalledWith({
      cwd: '/work',
      // Required since pi-coding-agent 0.73 — the loader no longer defaults it.
      agentDir: '/tmp/cowork-pi-agent',
      additionalSkillPaths: ['/skills'],
      appendSystemPrompt: ['APPEND'],
      extensionFactories: [
        {
          factory: {
            customInstructions: undefined,
            pruneToolOutputAbove: 500,
            keepRecentToolResults: 3,
          },
        },
      ],
    });
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });

  it('caps per-session compaction instructions at 2000 characters', async () => {
    await createPiSession(
      makeDeps({ session: { id: 'sess-1', compactInstructions: 'x'.repeat(2500) } as never })
    );

    expect(mocks.createCompactionExtensionFactory.mock.calls[0][0].customInstructions).toHaveLength(
      2000
    );
  });

  it('forwards the endpoint metadata to the payload hook', async () => {
    const installPayloadHook = vi.fn();
    await createPiSession(
      makeDeps({
        installPayloadHook,
        customProtocol: 'openai',
        provider: 'ollama',
        piModel: { id: 'm', provider: 'ollama', api: 'openai', contextWindow: 8192 } as never,
      })
    );

    expect(installPayloadHook).toHaveBeenCalledWith(piSession, {
      provider: 'ollama',
      customProtocol: 'openai',
      baseUrl: 'https://api.example',
      modelId: 'm',
      contextWindow: 8192,
    });
  });

  it('builds the model registry with the shared auth storage', async () => {
    const authStorage = { marker: 'auth' };
    await createPiSession(makeDeps({ authStorage: authStorage as never }));

    expect(mocks.modelRegistryCtor).toHaveBeenCalledWith(authStorage);
  });
});
