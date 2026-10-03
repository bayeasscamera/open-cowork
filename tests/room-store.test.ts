import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { RoomStore, RoomValidationError, MAX_ROOM_MESSAGE_BYTES } from '../src/main/rooms/room-store';
import { createRoomStore } from '../src/main/rooms/room-store-factory';
import type { DatabaseInstance } from '../src/main/db/database';

/** Real SQLite: the schema and the transaction boundary are half the contract. */
function newStore(): { store: RoomStore; db: Database.Database } {
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
  return { store: createRoomStore({ raw: db } as unknown as DatabaseInstance), db };
}

describe('room store', () => {
  it('creates an open room scoped to its session and project', () => {
    const { store } = newStore();
    const room = store.create({ name: 'refactor', goal: 'split the module', sessionId: 's1', projectId: 'p1' });

    expect(room.status).toBe('open');
    expect(room.sessionId).toBe('s1');
    expect(room.projectId).toBe('p1');
    expect(store.get(room.id)?.name).toBe('refactor');
  });

  it('refuses an empty room name', () => {
    const { store } = newStore();
    expect(() => store.create({ name: '   ' })).toThrow(RoomValidationError);
  });

  it('keeps a member list and refreshes a re-joining role', () => {
    const { store } = newStore();
    const room = store.create({ name: 'r' });

    store.addMember(room.id, 'researcher', 'task-1');
    store.addMember(room.id, 'reviewer', 'task-2');
    // The same role may legitimately be filled again after its task finished.
    store.addMember(room.id, 'researcher', 'task-9');

    const members = store.getDetail(room.id)?.members ?? [];
    expect(members.map((m) => m.role).sort()).toEqual(['researcher', 'reviewer']);
    expect(members.find((m) => m.role === 'researcher')?.taskId).toBe('task-9');
  });

  it('lets a role leave without erasing what it said', () => {
    const { store } = newStore();
    const room = store.create({ name: 'r' });
    store.addMember(room.id, 'researcher', 'task-1');
    store.postMessage({ roomId: room.id, fromRole: 'researcher', kind: 'note', body: 'found it' });

    store.removeMember(room.id, 'researcher');

    expect(store.getDetail(room.id)?.members).toHaveLength(0);
    // The message keeps its author, so the record stays readable.
    expect(store.messages(room.id).map((m) => m.fromRole)).toEqual(['researcher']);
  });

  it('records a question and its answer as an ordered pair', () => {
    const { store } = newStore();
    const room = store.create({ name: 'r' });
    const at = Date.now() - 1000;

    store.recordExchange({
      roomId: room.id,
      fromRole: 'implementer',
      fromTaskId: 't1',
      targetRole: 'researcher',
      question: 'Where is the config read?',
      answer: 'config-store.ts',
      status: 'answered',
      modelCalls: 1,
      at,
      durationMs: 500,
    });

    const messages = store.messages(room.id);
    expect(messages.map((m) => m.kind)).toEqual(['question', 'answer']);
    // Chronological, which is how a conversation reads.
    expect(messages[0].createdAt).toBeLessThan(messages[1].createdAt);
    expect(messages[1].createdAt - messages[0].createdAt).toBe(500);
  });

  it('sums the model calls an exchange really spent', () => {
    const { store } = newStore();
    const room = store.create({ name: 'r' });

    store.recordExchange({
      roomId: room.id,
      fromRole: 'a', fromTaskId: 't', targetRole: 'b',
      question: 'q', answer: 'a', status: 'answered', modelCalls: 1,
      at: Date.now(), durationMs: 0,
    });
    // A timeout spent nothing, and the room should say so.
    store.recordExchange({
      roomId: room.id,
      fromRole: 'a', fromTaskId: 't', targetRole: 'c',
      question: 'q2', answer: '(no answer recorded)', status: 'timeout', modelCalls: 0,
      at: Date.now(), durationMs: 30000,
    });

    expect(store.totalModelCalls(room.id)).toBe(1);
  });

  it('refuses a negative model cost, so a caller cannot corrupt the record', () => {
    const { store } = newStore();
    const room = store.create({ name: 'r' });
    const message = store.postMessage({
      roomId: room.id, fromRole: 'a', kind: 'note', body: 'x', modelCalls: -50,
    });
    expect(message.modelCalls).toBe(0);
  });

  it('keeps a message for an unanswered question readable', () => {
    const { store } = newStore();
    const room = store.create({ name: 'r' });
    store.recordExchange({
      roomId: room.id,
      fromRole: 'a', fromTaskId: 't', targetRole: 'gone',
      question: 'are you there?', answer: '', status: 'unavailable', modelCalls: 0,
      at: Date.now(), durationMs: 0,
    });
    // The fallback is kept, because it explains why the agent continued.
    expect(store.messages(room.id).map((m) => m.body)).toEqual([
      'are you there?',
      '(no answer recorded)',
    ]);
  });

  it('closes and reopens a room', () => {
    const { store } = newStore();
    const room = store.create({ name: 'r' });
    expect(store.setStatus(room.id, 'closed').status).toBe('closed');
    expect(store.setStatus(room.id, 'open').status).toBe('open');
    expect(() => store.setStatus(room.id, 'archived' as never)).toThrow(RoomValidationError);
  });

  it('lists by session and by project', () => {
    const { store } = newStore();
    store.create({ name: 'a', sessionId: 's1' });
    store.create({ name: 'b', sessionId: 's2', projectId: 'p1' });
    store.create({ name: 'c', sessionId: 's1', projectId: 'p1' });

    expect(store.list({ sessionId: 's1' }).map((r) => r.name).sort()).toEqual(['a', 'c']);
    expect(store.list({ projectId: 'p1' }).map((r) => r.name).sort()).toEqual(['b', 'c']);
  });

  it('deletes the room with its members and messages', () => {
    const { store, db } = newStore();
    const room = store.create({ name: 'r' });
    store.addMember(room.id, 'researcher');
    store.postMessage({ roomId: room.id, fromRole: 'researcher', kind: 'note', body: 'x' });

    expect(store.delete(room.id)).toBe(true);
    expect(store.get(room.id)).toBeUndefined();
    for (const table of ['room_members', 'room_messages']) {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`).get(room.id) as {
        n: number;
      }).n;
      expect(n, `${table} left rows behind`).toBe(0);
    }
  });

  it('reports nothing to delete for an unknown room', () => {
    expect(newStore().store.delete('room-nope')).toBe(false);
  });

  it('refuses messages and members on an unknown room', () => {
    const { store } = newStore();
    expect(() => store.addMember('room-nope', 'a')).toThrow(RoomValidationError);
    expect(() =>
      store.postMessage({ roomId: 'room-nope', fromRole: 'a', kind: 'note', body: 'x' })
    ).toThrow(RoomValidationError);
  });

  it('refuses a message body beyond the storage cap', () => {
    const { store } = newStore();
    const room = store.create({ name: 'r' });
    expect(() =>
      store.postMessage({
        roomId: room.id,
        fromRole: 'a',
        kind: 'note',
        body: 'x'.repeat(MAX_ROOM_MESSAGE_BYTES + 1),
      })
    ).toThrow(RoomValidationError);
  });

  it('leaves no orphan message when a write fails midway', () => {
    const { store, db } = newStore();
    const room = store.create({ name: 'r' });

    // A DML trigger, not DDL: SQLite implicitly commits DDL, so failing via a
    // dropped table would pass without the transaction doing anything.
    db.exec(
      `CREATE TRIGGER fail_room_update BEFORE UPDATE ON rooms
       BEGIN SELECT RAISE(ABORT, 'forced failure'); END`
    );

    expect(() =>
      store.postMessage({ roomId: room.id, fromRole: 'a', kind: 'note', body: 'x' })
    ).toThrow();

    db.exec('DROP TRIGGER fail_room_update');
    const n = (db.prepare('SELECT COUNT(*) AS n FROM room_messages').get() as { n: number }).n;
    expect(n).toBe(0);
  });
});