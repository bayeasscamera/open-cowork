/**
 * Tests for the cached-session reuse path extracted from run().
 *
 * The logger is mocked so the exact hot-swap log strings are pinned, and the
 * session stub records setModel / setThinkingLevel calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  logCtx: vi.fn(),
  logTiming: vi.fn(),
}));

vi.mock('../src/main/utils/logger', () => ({
  log: mocks.log,
  logCtx: mocks.logCtx,
  logTiming: mocks.logTiming,
}));

import { reusePiSession, type ReusePiSessionDeps } from '../src/main/agent/reuse-pi-session';

function makeSession() {
  return {
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(),
  };
}

function makeDeps(over: Partial<ReusePiSessionDeps> = {}): ReusePiSessionDeps {
  const { cachedSession: cachedOver, ...rest } = over;
  return {
    cachedSession: {
      session: cachedOver?.session ?? (makeSession() as never),
      modelId: 'model-1',
      thinkingLevel: 'medium',
      runtimeSignature: 'runtime-sig',
      ...(cachedOver || {}),
    },
    sessionId: 'sess-1',
    piModel: { id: 'model-1', contextWindow: 8192 } as never,
    thinkingLevel: 'medium' as never,
    runStartTime: 1234,
    ...rest,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reusePiSession', () => {
  it('returns the cached session and logs the reuse without hot-swapping', async () => {
    const deps = makeDeps();

    const session = await reusePiSession(deps);

    expect(session).toBe(deps.cachedSession.session);
    expect(session.setModel).not.toHaveBeenCalled();
    expect(session.setThinkingLevel).not.toHaveBeenCalled();
    expect(mocks.logCtx).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Reusing cached pi session for:',
      'sess-1'
    );
    expect(mocks.logTiming).toHaveBeenCalledWith('agent session reused', 1234);
  });

  it('hot-swaps the model and updates the cached model id', async () => {
    const deps = makeDeps({ piModel: { id: 'model-2', contextWindow: 8192 } as never });

    await reusePiSession(deps);

    expect(deps.cachedSession.session.setModel).toHaveBeenCalledWith(deps.piModel);
    expect(deps.cachedSession.modelId).toBe('model-2');
    expect(mocks.logCtx).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Model changed, hot-swapping:',
      'model-1',
      '→',
      'model-2'
    );
  });

  it('refreshes the Ollama num_ctx reference on a model hot-swap', async () => {
    const deps = makeDeps({
      cachedSession: {
        ollamaNumCtx: { value: 4096 },
      } as never,
      piModel: { id: 'model-2', contextWindow: 32768 } as never,
    });

    await reusePiSession(deps);

    expect(deps.cachedSession.ollamaNumCtx?.value).toBe(32768);
    expect(mocks.log).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Updated Ollama num_ctx on hot-swap:',
      32768
    );
  });

  it('falls back to 128000 when the hot-swapped model has no context window', async () => {
    const deps = makeDeps({
      cachedSession: { ollamaNumCtx: { value: 4096 } } as never,
      piModel: { id: 'model-2', contextWindow: 0 } as never,
    });

    await reusePiSession(deps);

    expect(deps.cachedSession.ollamaNumCtx?.value).toBe(128000);
  });

  it('hot-swaps the thinking level independently of the model', async () => {
    const deps = makeDeps({ thinkingLevel: 'off' as never });

    await reusePiSession(deps);

    expect(deps.cachedSession.session.setModel).not.toHaveBeenCalled();
    expect(deps.cachedSession.session.setThinkingLevel).toHaveBeenCalledWith('off');
    expect(deps.cachedSession.thinkingLevel).toBe('off');
    expect(mocks.logCtx).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Thinking level changed, hot-swapping:',
      'medium',
      '→',
      'off'
    );
  });

  it('propagates a setModel rejection without mutating the cached model id', async () => {
    const deps = makeDeps({ piModel: { id: 'model-2', contextWindow: 8192 } as never });
    (deps.cachedSession.session.setModel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom')
    );

    await expect(reusePiSession(deps)).rejects.toThrow('boom');
    expect(deps.cachedSession.modelId).toBe('model-1');
  });
});
