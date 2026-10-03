import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const testRoot = mkdtempSync(join(tmpdir(), 'cowork-room-schema-'));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(testRoot, name),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import { closeDatabase, getDatabase, initDatabase } from '../src/main/db/database';
import { createRoomStore } from '../src/main/rooms/room-store-factory';

/**
 * Proves the migration creates the room tables the store needs. The store tests
 * build their schema by hand, so nothing would fail if the two disagreed — the
 * feature would only be found broken in the app, on a fresh install.
 */
describe('room schema in the real migration', () => {
  beforeAll(() => {
    initDatabase();
  });

  afterAll(async () => {
    closeDatabase();
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('creates the room tables', () => {
    const tables = getDatabase().raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('rooms');
    expect(names).toContain('room_members');
    expect(names).toContain('room_messages');
  });

  it('indexes rooms and their messages', () => {
    const indexes = getDatabase().raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%room%'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_rooms_session_id');
    expect(names).toContain('idx_rooms_project_id');
    expect(names).toContain('idx_room_messages_room_id');
  });

  it('keeps one membership per role in a room', () => {
    const db = getDatabase().raw;
    const store = createRoomStore(getDatabase());
    const room = store.create({ name: 'unique-role' });
    store.addMember(room.id, 'researcher', 'task-1');

    // Re-joining refreshes rather than duplicating, which the schema enforces.
    expect(() => {
      db.prepare(
        `INSERT INTO room_members (room_id, role, task_id, joined_at) VALUES (?, ?, ?, ?)`
      ).run(room.id, 'researcher', 'task-2', Date.now());
    }).toThrow();
  });

  it('round-trips a room and its exchange through the migrated schema', () => {
    const store = createRoomStore(getDatabase());
    const room = store.create({ name: 'roundtrip', goal: 'ship it', sessionId: 's1' });
    store.addMember(room.id, 'implementer', 't1');
    store.recordExchange({
      roomId: room.id,
      fromRole: 'implementer',
      fromTaskId: 't1',
      targetRole: 'reviewer',
      question: 'is this safe?',
      answer: 'yes',
      status: 'answered',
      modelCalls: 1,
      at: Date.now(),
      durationMs: 10,
    });

    const detail = store.getDetail(room.id);
    expect(detail?.goal).toBe('ship it');
    expect(detail?.members.map((m) => m.role)).toEqual(['implementer']);
    expect(detail?.messages.map((m) => m.kind)).toEqual(['question', 'answer']);
    expect(store.totalModelCalls(room.id)).toBe(1);
  });
});