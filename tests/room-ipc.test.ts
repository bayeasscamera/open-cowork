import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createRoomStore } from '../src/main/rooms/room-store-factory';
import { registerRoomIpcHandlers } from '../src/main/ipc/room-handlers';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

function newStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, name TEXT NOT NULL,
      goal TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE room_members (
      room_id TEXT NOT NULL, role TEXT NOT NULL, task_id TEXT,
      joined_at INTEGER NOT NULL, PRIMARY KEY (room_id, role)
    )
  `);
  db.exec(`
    CREATE TABLE room_messages (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, from_role TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0,
      status TEXT, created_at INTEGER NOT NULL
    )
  `);
  return createRoomStore({ raw: db } as never);
}

const invoke = async (channel: string, ...args: unknown[]) => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler: ${channel}`);
  return fn({}, ...args);
};

describe('room IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers the room channels', () => {
    registerRoomIpcHandlers({ getStore: newStore });
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'rooms.delete',
      'rooms.detail',
      'rooms.list',
      'rooms.postMessage',
    ]);
  });

  it('lists rooms without their transcripts', async () => {
    const store = newStore();
    store.create({ name: 'r', sessionId: 's1' });
    store.postMessage({ roomId: store.list({ sessionId: 's1' })[0].id, fromRole: 'a', kind: 'note', body: 'x' });
    registerRoomIpcHandlers({ getStore: () => store });

    const listed = (await invoke('rooms.list', 's1')) as Array<Record<string, unknown>>;
    expect(listed).toHaveLength(1);
    // Opening the list must not pull every transcript into the renderer.
    expect(listed[0]).not.toHaveProperty('messages');
  });

  it('returns nothing without a session', async () => {
    const store = newStore();
    store.create({ name: 'r', sessionId: 's1' });
    registerRoomIpcHandlers({ getStore: () => store });
    expect(await invoke('rooms.list', null)).toEqual([]);
  });

  it('refuses a transcript from another session', async () => {
    const store = newStore();
    const room = store.create({ name: 'r', sessionId: 's1' });
    registerRoomIpcHandlers({ getStore: () => store });

    expect(await invoke('rooms.detail', 's2', room.id)).toBeNull();
    expect(await invoke('rooms.detail', 's1', room.id)).toMatchObject({ name: 'r' });
  });

  it('spans the project when the session is in one', async () => {
    const store = newStore();
    const room = store.create({ name: 'shared', sessionId: 's1', projectId: 'p1' });
    registerRoomIpcHandlers({
      getStore: () => store,
      getProjectId: () => 'p1',
    });
    // A sibling session in the same project may legitimately read it.
    expect(await invoke('rooms.detail', 's2', room.id)).toMatchObject({ name: 'shared' });
  });

  it('attributes a note from the UI to the user, not to an agent role', async () => {
    const store = newStore();
    const room = store.create({ name: 'r', sessionId: 's1' });
    registerRoomIpcHandlers({ getStore: () => store });

    const posted = (await invoke('rooms.postMessage', {
      sessionId: 's1',
      roomId: room.id,
      body: 'looks right',
    })) as { fromRole: string };
    // A room record that attributes a human note to an agent would be a lie.
    expect(posted.fromRole).toBe('user');
  });

  it('refuses to post into another session room', async () => {
    const store = newStore();
    const room = store.create({ name: 'r', sessionId: 's1' });
    registerRoomIpcHandlers({ getStore: () => store });

    expect(
      await invoke('rooms.postMessage', { sessionId: 's2', roomId: room.id, body: 'x' })
    ).toBeNull();
    expect(store.messages(room.id)).toHaveLength(0);
  });

  it('refuses to delete when no confirmation is available', async () => {
    const store = newStore();
    const room = store.create({ name: 'r', sessionId: 's1' });
    registerRoomIpcHandlers({ getStore: () => store });

    expect(await invoke('rooms.delete', 's1', room.id)).toEqual({
      success: false,
      error: 'confirmation_unavailable',
    });
    expect(store.get(room.id)).toBeDefined();
  });

  it('deletes once the human agrees', async () => {
    const store = newStore();
    const room = store.create({ name: 'r', sessionId: 's1' });
    const confirmDelete = vi.fn().mockResolvedValue(true);
    registerRoomIpcHandlers({ getStore: () => store, confirmDelete });

    expect(await invoke('rooms.delete', 's1', room.id)).toEqual({ success: true });
    expect(confirmDelete).toHaveBeenCalledWith(room.id, 'r');
    expect(store.get(room.id)).toBeUndefined();
  });

  it('keeps the room when the human declines', async () => {
    const store = newStore();
    const room = store.create({ name: 'r', sessionId: 's1' });
    registerRoomIpcHandlers({
      getStore: () => store,
      confirmDelete: vi.fn().mockResolvedValue(false),
    });
    expect(await invoke('rooms.delete', 's1', room.id)).toEqual({
      success: false,
      error: 'confirmation_denied',
    });
    expect(store.get(room.id)).toBeDefined();
  });

  it('refuses to delete across sessions, without even asking', async () => {
    const store = newStore();
    const room = store.create({ name: 'r', sessionId: 's1' });
    const confirmDelete = vi.fn();
    registerRoomIpcHandlers({ getStore: () => store, confirmDelete });

    expect(await invoke('rooms.delete', 's2', room.id)).toEqual({
      success: false,
      error: 'not_found',
    });
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(store.get(room.id)).toBeDefined();
  });
});

describe('room IPC registration in the app', () => {
  it('is registered with a confirmation dialog', () => {
    const index = require('node:fs').readFileSync(
      require('node:path').resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    );
    expect(index).toContain('registerRoomIpcHandlers({');
    expect(index).toContain('confirmDelete: async');
  });
});

describe('shared room contract', () => {
  it('mirrors the store unions instead of importing from main', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const contract = fs.readFileSync(
      path.resolve(process.cwd(), 'src/shared/room-contract.ts'),
      'utf8'
    );
    // The renderer must not reach into src/main, even for a type.
    expect(contract).not.toContain("from '../main/");

    // And the two must agree: a widened union here would type-check while
    // silently never matching anything at runtime.
    const store = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/rooms/room-store.ts'),
      'utf8'
    );
    for (const value of ["'open'", "'closed'"]) {
      expect(contract).toContain(value);
      expect(store).toContain(value);
    }
    for (const value of ["'question'", "'answer'", "'note'"]) {
      expect(contract).toContain(value);
      expect(store).toContain(value);
    }
  });
});