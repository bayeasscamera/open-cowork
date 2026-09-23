/**
 * Session-level settings override (the top of the global -> project -> session
 * ladder): persistence, renderer notification and SDK cache invalidation.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DatabaseInstance } from '../src/main/db/database';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-session-config-override-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults || {}) };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = { ...this.store, ...key };
    }
  }
  return { default: MockStore };
});

vi.mock('../src/main/agent/agent-runner', () => ({
  CoworkAgentRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
    clearSdkSession(): void {
      /* replaced by a spy when asserted */
    }
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: { getEnabledServers: () => [] },
}));

import { SessionManager } from '../src/main/session/session-manager';
import { CoworkAgentRunner } from '../src/main/agent/agent-runner';

function makeDb(overrides: Partial<DatabaseInstance> = {}): DatabaseInstance {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(() => null),
      getAll: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    messages: {
      create: vi.fn(),
      getBySessionId: vi.fn(() => []),
      delete: vi.fn(),
      deleteBySessionId: vi.fn(),
    },
    traceSteps: {
      create: vi.fn(),
      update: vi.fn(),
      getBySessionId: vi.fn(() => []),
      deleteBySessionId: vi.fn(),
    },
    ...overrides,
  } as unknown as DatabaseInstance;
}

const EXISTING_ROW = {
  id: 's1',
  title: 'Session',
  claude_session_id: null,
  openai_thread_id: null,
  status: 'idle',
  cwd: '/tmp/workspace',
  mounted_paths: '[]',
  allowed_tools: '[]',
  memory_enabled: 0,
  model: null,
  created_at: 1,
  updated_at: 1,
};

describe('SessionManager — session-level config override', () => {
  it('maps the override columns back to the Session', () => {
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => null),
        getAll: vi.fn(() => [
          { ...EXISTING_ROW, config_set_id: 'set-2', config_model_id: 'claude-opus' },
        ]),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });
    const [session] = new SessionManager(db, vi.fn()).listSessions();
    expect(session.configSetId).toBe('set-2');
    expect(session.configModelId).toBe('claude-opus');
  });

  it('reports null (inherit) when no override is stored', () => {
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => null),
        getAll: vi.fn(() => [EXISTING_ROW]),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });
    const [session] = new SessionManager(db, vi.fn()).listSessions();
    expect(session.configSetId).toBeNull();
    expect(session.configModelId).toBeNull();
  });

  it('persists a trimmed override and notifies the renderer', () => {
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => EXISTING_ROW),
        getAll: vi.fn(() => [EXISTING_ROW]),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });
    const send = vi.fn();
    const ok = new SessionManager(db, send).setConfigOverride('s1', '  set-2  ', ' claude-opus ');

    expect(ok).toBe(true);
    expect(db.sessions.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ config_set_id: 'set-2', config_model_id: 'claude-opus' })
    );
    expect(send).toHaveBeenCalledWith({
      type: 'session.update',
      payload: {
        sessionId: 's1',
        updates: { configSetId: 'set-2', configModelId: 'claude-opus' },
      },
    });
  });

  it('stores null (inherit) for blank values', () => {
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => EXISTING_ROW),
        getAll: vi.fn(() => [EXISTING_ROW]),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });
    new SessionManager(db, vi.fn()).setConfigOverride('s1', '   ', '');
    expect(db.sessions.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ config_set_id: null, config_model_id: null })
    );
  });

  it('drops the cached SDK session so the new model actually applies', () => {
    const db = makeDb({
      sessions: {
        create: vi.fn(),
        get: vi.fn(() => EXISTING_ROW),
        getAll: vi.fn(() => [EXISTING_ROW]),
        update: vi.fn(),
        delete: vi.fn(),
      } as unknown,
    });
    const spy = vi.spyOn(CoworkAgentRunner.prototype, 'clearSdkSession');
    new SessionManager(db, vi.fn()).setConfigOverride('s1', 'set-2', null);
    expect(spy).toHaveBeenCalledWith('s1');
    spy.mockRestore();
  });

  it('refuses an unknown session without touching the database', () => {
    const db = makeDb();
    const send = vi.fn();
    const ok = new SessionManager(db, send).setConfigOverride('missing', 'set-2', null);
    expect(ok).toBe(false);
    expect(db.sessions.update).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
