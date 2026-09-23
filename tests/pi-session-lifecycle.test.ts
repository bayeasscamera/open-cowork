/**
 * Tests for the cached-pi-session lifecycle policy extracted from run().
 *
 * The logger is mocked so the exact eviction wording is pinned, and the session
 * stub records dispose() calls so every branch proves whether the cached entry
 * was disposed and removed. This is where the runner's reuse/rebuild decision is
 * verified without booting the runner (or Electron).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  logCtx: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('../src/main/utils/logger', () => ({
  logCtx: mocks.logCtx,
  logWarn: mocks.logWarn,
}));

import {
  evictCachedPiSession,
  hasSessionContextChanged,
  resolvePiSessionRecreateReason,
} from '../src/main/agent/pi-session-lifecycle';
import type { CachedPiSession } from '../src/main/agent/create-pi-session';

function makeCached(over: Partial<CachedPiSession> = {}): CachedPiSession {
  return {
    session: { dispose: vi.fn() } as never,
    modelId: 'model-1',
    thinkingLevel: 'medium',
    runtimeSignature: 'runtime-sig',
    skillsSignature: 'skills-sig',
    sessionContextSignature: 'ctx-sig',
    ...over,
  };
}

function throwingSession(error = new Error('boom')) {
  return {
    session: {
      dispose: vi.fn(() => {
        throw error;
      }),
    } as never,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolvePiSessionRecreateReason', () => {
  it('keeps the session when both infrastructure signatures match', () => {
    expect(
      resolvePiSessionRecreateReason(makeCached(), {
        runtimeSignature: 'runtime-sig',
        skillsSignature: 'skills-sig',
      })
    ).toBeNull();
  });

  it('recreates on a runtime signature change', () => {
    expect(
      resolvePiSessionRecreateReason(makeCached(), {
        runtimeSignature: 'runtime-new',
        skillsSignature: 'skills-sig',
      })
    ).toBe('runtime');
  });

  it('recreates on a skill path change', () => {
    expect(
      resolvePiSessionRecreateReason(makeCached(), {
        runtimeSignature: 'runtime-sig',
        skillsSignature: 'skills-new',
      })
    ).toBe('skills');
  });

  it('reports the runtime change first when both differ', () => {
    expect(
      resolvePiSessionRecreateReason(makeCached(), {
        runtimeSignature: 'runtime-new',
        skillsSignature: 'skills-new',
      })
    ).toBe('runtime');
  });
});

describe('hasSessionContextChanged', () => {
  it('is false when the extension signature is unchanged', () => {
    expect(hasSessionContextChanged(makeCached(), { sessionContextSignature: 'ctx-sig' })).toBe(
      false
    );
  });

  it('is true when the extension signature changes', () => {
    expect(hasSessionContextChanged(makeCached(), { sessionContextSignature: 'ctx-new' })).toBe(
      true
    );
  });

  it('is true when the extension stops contributing a signature', () => {
    // The first disabled turn after an enabled run must rebuild.
    expect(hasSessionContextChanged(makeCached(), {})).toBe(true);
  });

  it('is false when neither side ever had a signature', () => {
    expect(
      hasSessionContextChanged(makeCached({ sessionContextSignature: undefined }), {})
    ).toBe(false);
  });

  it('honours the legacy forced-refresh flag over an unchanged signature', () => {
    expect(
      hasSessionContextChanged(makeCached(), {
        refreshSession: true,
        sessionContextSignature: 'ctx-sig',
      })
    ).toBe(true);
  });
});

describe('evictCachedPiSession', () => {
  it('is a no-op when nothing is cached', () => {
    const sessions = new Map<string, CachedPiSession>();

    expect(evictCachedPiSession(sessions, 'sess-1', 'runtime')).toBe(false);
    expect(mocks.logCtx).not.toHaveBeenCalled();
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it.each([
    ['runtime', '[CoworkAgentRunner] Runtime changed, recreating cached pi session:'],
    ['skills', '[CoworkAgentRunner] Skills changed, recreating cached pi session:'],
    ['context', '[CoworkAgentRunner] Session context changed, recreating cached pi session:'],
  ] as const)('logs the %s change, disposes and removes the entry', (reason, message) => {
    const cached = makeCached();
    const sessions = new Map([['sess-1', cached]]);

    expect(evictCachedPiSession(sessions, 'sess-1', reason)).toBe(true);

    expect(mocks.logCtx).toHaveBeenCalledWith(message, 'sess-1');
    expect(cached.session.dispose).toHaveBeenCalledTimes(1);
    expect(sessions.has('sess-1')).toBe(false);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('still removes the entry and warns with the error when runtime dispose throws', () => {
    const cached = makeCached(throwingSession());
    const sessions = new Map([['sess-1', cached]]);

    expect(evictCachedPiSession(sessions, 'sess-1', 'runtime')).toBe(true);

    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] dispose error while recreating pi session:',
      expect.any(Error)
    );
    expect(sessions.has('sess-1')).toBe(false);
  });

  it('uses the skills-specific dispose warning', () => {
    const cached = makeCached(throwingSession());

    evictCachedPiSession(new Map([['sess-1', cached]]), 'sess-1', 'skills');

    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] dispose error while recreating pi session for skills:',
      expect.any(Error)
    );
  });

  it('logs the context dispose warning without the error argument', () => {
    const cached = makeCached(throwingSession());

    evictCachedPiSession(new Map([['sess-1', cached]]), 'sess-1', 'context');

    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Could not dispose memory session cache'
    );
  });

  it('swallows the dispose error silently on a stream-error eviction', () => {
    const cached = makeCached(throwingSession());
    const sessions = new Map([['sess-1', cached]]);

    expect(evictCachedPiSession(sessions, 'sess-1', 'stream-error')).toBe(true);

    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(mocks.logCtx).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Evicted corrupted pi session after stream error:',
      'sess-1'
    );
    expect(sessions.has('sess-1')).toBe(false);
  });

  it('logs the terminal-error eviction after removing the entry', () => {
    const sessions = new Map([['sess-1', makeCached()]]);

    expect(evictCachedPiSession(sessions, 'sess-1', 'terminal-error')).toBe(true);

    expect(mocks.logCtx).toHaveBeenCalledWith(
      '[CoworkAgentRunner] Evicted pi session after terminal error (finally):',
      'sess-1'
    );
    expect(sessions.has('sess-1')).toBe(false);
  });
});
