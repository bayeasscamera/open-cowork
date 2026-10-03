/**
 * @module main/rooms/room-store-factory
 *
 * Wires a RoomStore over the application database, mirroring the artifact store
 * so both persistence layers read the same way.
 */

import type { DatabaseInstance } from '../db/database';
import { getDatabase, runWithWriteLockRetry } from '../db/database';
import { RoomStore } from './room-store';

interface RoomRowDb {
  id: string;
  session_id: string | null;
  project_id: string | null;
  name: string;
  goal: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface RoomMemberRowDb {
  room_id: string;
  role: string;
  task_id: string | null;
  joined_at: number;
}

interface RoomMessageRowDb {
  id: string;
  room_id: string;
  from_role: string;
  kind: string;
  body: string;
  model_calls: number;
  status: string | null;
  created_at: number;
}

export function createRoomStore(db: DatabaseInstance): RoomStore {
  const raw = db.raw;
  return new RoomStore({
    rooms: {
      create: (row) =>
        raw
          .prepare(
            `INSERT INTO rooms (id, session_id, project_id, name, goal, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.id,
            row.session_id,
            row.project_id,
            row.name,
            row.goal,
            row.status,
            row.created_at,
            row.updated_at
          ),
      update: (id, updates) => {
        const map: Record<string, unknown> = {
          name: updates.name,
          goal: updates.goal,
          status: updates.status,
          updated_at: updates.updated_at,
        };
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [column, value] of Object.entries(map)) {
          if (value === undefined) continue;
          sets.push(`${column} = ?`);
          params.push(value);
        }
        if (sets.length === 0) return;
        raw.prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      },
      get: (id) => raw.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRowDb | undefined,
      delete: (id) => {
        raw.prepare('DELETE FROM rooms WHERE id = ?').run(id);
      },
      listBySession: (sessionId) =>
        raw
          .prepare('SELECT * FROM rooms WHERE session_id = ? ORDER BY updated_at DESC')
          .all(sessionId) as RoomRowDb[],
      listByProject: (projectId) =>
        raw
          .prepare('SELECT * FROM rooms WHERE project_id = ? ORDER BY updated_at DESC')
          .all(projectId) as RoomRowDb[],
      listAll: () => raw.prepare('SELECT * FROM rooms ORDER BY updated_at DESC').all() as RoomRowDb[],
    },
    members: {
      upsert: (row) =>
        raw
          .prepare(
            `INSERT INTO room_members (room_id, role, task_id, joined_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(room_id, role) DO UPDATE SET task_id = excluded.task_id`
          )
          .run(row.room_id, row.role, row.task_id, row.joined_at),
      list: (roomId) =>
        raw
          .prepare('SELECT * FROM room_members WHERE room_id = ? ORDER BY joined_at')
          .all(roomId) as RoomMemberRowDb[],
      remove: (roomId, role) => {
        raw.prepare('DELETE FROM room_members WHERE room_id = ? AND role = ?').run(roomId, role);
      },
      removeByRoom: (roomId) => {
        raw.prepare('DELETE FROM room_members WHERE room_id = ?').run(roomId);
      },
    },
    messages: {
      insert: (row) =>
        raw
          .prepare(
            `INSERT INTO room_messages (id, room_id, from_role, kind, body, model_calls, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.id,
            row.room_id,
            row.from_role,
            row.kind,
            row.body,
            row.model_calls,
            row.status,
            row.created_at
          ),
      list: (roomId) =>
        raw.prepare('SELECT * FROM room_messages WHERE room_id = ?').all(roomId) as RoomMessageRowDb[],
      deleteByRoom: (roomId) => {
        raw.prepare('DELETE FROM room_messages WHERE room_id = ?').run(roomId);
      },
    },
    // Members and their messages must not land half-written: a room that
    // claims a member with no trace of what it did is worse than one that
    // never mentioned it.
    transaction: <T>(fn: () => T): T =>
      runWithWriteLockRetry('room write', () => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = fn();
          raw.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            // A rollback failure must not mask the original error.
          }
          throw error;
        }
      }),
  });
}

let sharedStore: RoomStore | null = null;

export function getSharedRoomStore(): RoomStore {
  if (!sharedStore) {
    sharedStore = createRoomStore(getDatabase());
  }
  return sharedStore;
}

/** Reset the shared instance. Test-only. */
export function resetSharedRoomStore(): void {
  sharedStore = null;
}