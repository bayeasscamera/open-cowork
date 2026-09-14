import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/main/session/session-manager';
import type { DatabaseInstance, SessionRow } from '../src/main/db/database';

describe('Session Rename & Pinning Persistence (In-memory mock)', () => {
  it('renames a session and persists new title to database', () => {
    const store = new Map<string, SessionRow>();
    store.set('sess-1', {
      id: 'sess-1',
      title: 'Old Title',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: null,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 0,
      model: null,
      is_pinned: 0,
      created_at: 1000,
      updated_at: 1000,
    });

    const mockDb: DatabaseInstance = {
      raw: {} as any,
      sessions: {
        create: (s: SessionRow) => store.set(s.id, { ...s }),
        update: (id: string, updates: Partial<SessionRow>) => {
          const prev = store.get(id);
          if (prev) {
            store.set(id, { ...prev, ...updates, updated_at: Date.now() });
          }
        },
        get: (id: string) => store.get(id),
        getAll: () =>
          Array.from(store.values()).sort(
            (a, b) => (b.is_pinned ?? 0) - (a.is_pinned ?? 0) || b.updated_at - a.updated_at
          ),
        delete: (id: string) => store.delete(id),
      },
      messages: {
        create: () => {},
        update: () => {},
        getBySessionId: () => [],
        delete: () => {},
        deleteBySessionId: () => {},
      },
      traceSteps: {
        create: () => {},
        update: () => {},
        getBySessionId: () => [],
        deleteBySessionId: () => {},
      },
      scheduledTasks: {
        create: () => {},
        update: () => {},
        get: () => undefined,
        getAll: () => [],
        delete: () => {},
      },
      prepare: () => ({} as any),
      exec: () => {},
      pragma: () => {},
      close: () => {},
    };

    const mgr = new SessionManager(mockDb, () => {});
    const ok = mgr.renameSession('sess-1', 'Super New Title');
    expect(ok).toBe(true);

    const updated = mockDb.sessions.get('sess-1');
    expect(updated?.title).toBe('Super New Title');
  });

  it('toggles pinned status and orders pinned sessions first', () => {
    const store = new Map<string, SessionRow>();
    store.set('sess-a', {
      id: 'sess-a',
      title: 'Session A',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: null,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 0,
      model: null,
      is_pinned: 0,
      created_at: 2000,
      updated_at: 2000,
    });
    store.set('sess-b', {
      id: 'sess-b',
      title: 'Session B',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: null,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 0,
      model: null,
      is_pinned: 0,
      created_at: 1000,
      updated_at: 1000,
    });

    const mockDb: DatabaseInstance = {
      raw: {} as any,
      sessions: {
        create: (s: SessionRow) => store.set(s.id, { ...s }),
        update: (id: string, updates: Partial<SessionRow>) => {
          const prev = store.get(id);
          if (prev) {
            store.set(id, { ...prev, ...updates, updated_at: Date.now() });
          }
        },
        get: (id: string) => store.get(id),
        getAll: () =>
          Array.from(store.values()).sort(
            (a, b) => (b.is_pinned ?? 0) - (a.is_pinned ?? 0) || b.updated_at - a.updated_at
          ),
        delete: (id: string) => store.delete(id),
      },
      messages: {
        create: () => {},
        update: () => {},
        getBySessionId: () => [],
        delete: () => {},
        deleteBySessionId: () => {},
      },
      traceSteps: {
        create: () => {},
        update: () => {},
        getBySessionId: () => [],
        deleteBySessionId: () => {},
      },
      scheduledTasks: {
        create: () => {},
        update: () => {},
        get: () => undefined,
        getAll: () => [],
        delete: () => {},
      },
      prepare: () => ({} as any),
      exec: () => {},
      pragma: () => {},
      close: () => {},
    };

    const mgr = new SessionManager(mockDb, () => {});
    // Pin session B (even though older)
    mgr.togglePinSession('sess-b', true);

    const all = mgr.listSessions();
    expect(all[0].id).toBe('sess-b');
    expect(all[0].isPinned).toBe(true);
    expect(all[1].id).toBe('sess-a');
    expect(all[1].isPinned).toBe(false);
  });
});
