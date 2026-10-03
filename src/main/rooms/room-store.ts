/**
 * @module main/rooms/room-store
 *
 * Rooms: a shared working space several agents contribute to, which outlives the
 * swarm that created it.
 *
 * The existing teammate bus is plan-scoped scratch state — it is dropped as soon
 * as a plan settles, because a swarm that keeps state would leak across runs. A
 * room is the deliberate opposite: it is what the user wanted to keep. So this
 * stores the members that joined, the messages they exchanged, and points at
 * the artifacts produced, without touching how a swarm executes.
 *
 * Messages record `model_calls` because a room can be read as a cost record as
 * well as a narrative — an exchange that was never answered cost nothing, and
 * that difference is only visible if it is kept.
 */

import { randomUUID } from 'crypto';

export type RoomStatus = 'open' | 'closed';

export interface RoomMember {
  role: string;
  taskId: string | null;
  joinedAt: number;
}

export type RoomMessageKind = 'question' | 'answer' | 'note';

/** Mirrors TeammateExchangeStatus values that carry a question/answer pair. */
export type RoomMessageStatus = 'answered' | 'timeout' | 'unavailable' | 'limit';

export interface RoomMessage {
  id: string;
  roomId: string;
  fromRole: string;
  kind: RoomMessageKind;
  body: string;
  modelCalls: number;
  status?: RoomMessageStatus;
  createdAt: number;
}

export interface Room {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  name: string;
  goal: string | null;
  status: RoomStatus;
  createdAt: number;
  updatedAt: number;
}

export interface RoomDetail extends Room {
  members: RoomMember[];
  messages: RoomMessage[];
}

export class RoomValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomValidationError';
  }
}

export interface CreateRoomInput {
  name: string;
  goal?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
}

export interface PostMessageInput {
  roomId: string;
  fromRole: string;
  kind: RoomMessageKind;
  body: string;
  modelCalls?: number;
  status?: RoomMessageStatus;
}

export interface RecordExchangeInput {
  roomId: string;
  fromRole: string;
  fromTaskId: string;
  targetRole: string;
  question: string;
  answer: string;
  status: RoomMessageStatus;
  modelCalls: number;
  at: number;
  durationMs: number;
}

const KINDS: readonly RoomMessageKind[] = ['question', 'answer', 'note'];
const STATUSES: readonly RoomStatus[] = ['open', 'closed'];
const MESSAGE_STATUSES: readonly RoomMessageStatus[] = [
  'answered',
  'timeout',
  'unavailable',
  'limit',
];

interface RoomRow {
  id: string;
  session_id: string | null;
  project_id: string | null;
  name: string;
  goal: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

interface RoomMemberRow {
  room_id: string;
  role: string;
  task_id: string | null;
  joined_at: number;
}

interface RoomMessageRow {
  id: string;
  room_id: string;
  from_role: string;
  kind: string;
  body: string;
  model_calls: number;
  status: string | null;
  created_at: number;
}

function rowToRoom(row: RoomRow): Room {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    name: row.name,
    goal: row.goal,
    status: (STATUSES as readonly string[]).includes(row.status)
      ? (row.status as RoomStatus)
      : 'open',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMessage(row: RoomMessageRow): RoomMessage {
  return {
    id: row.id,
    roomId: row.room_id,
    fromRole: row.from_role,
    kind: (KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as RoomMessageKind)
      : 'note',
    body: row.body,
    modelCalls: row.model_calls,
    status:
      row.status && (MESSAGE_STATUSES as readonly string[]).includes(row.status)
        ? (row.status as RoomMessageStatus)
        : undefined,
    createdAt: row.created_at,
  };
}

/** Bound on a stored message body. */
export const MAX_ROOM_MESSAGE_BYTES = 64 * 1024;

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new RoomValidationError('Room name is required');
  if (trimmed.length > 200) {
    throw new RoomValidationError('Room name must be 200 characters or fewer');
  }
  return trimmed;
}

function validateBody(body: string): string {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new RoomValidationError('Message body is required');
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_ROOM_MESSAGE_BYTES) {
    throw new RoomValidationError(
      `Message body must be ${MAX_ROOM_MESSAGE_BYTES} bytes or fewer (received ${bytes})`
    );
  }
  return body;
}

function validateRole(role: string): string {
  const trimmed = role.trim();
  if (!trimmed) throw new RoomValidationError('Role is required');
  if (trimmed.length > 100) {
    throw new RoomValidationError('Role must be 100 characters or fewer');
  }
  return trimmed;
}

export class RoomStore {
  constructor(
    private readonly deps: {
      rooms: {
        create: (row: RoomRow) => void;
        update: (id: string, updates: Partial<RoomRow>) => void;
        get: (id: string) => RoomRow | undefined;
        delete: (id: string) => void;
        listBySession: (sessionId: string) => RoomRow[];
        listByProject: (projectId: string) => RoomRow[];
        listAll: () => RoomRow[];
      };
      members: {
        upsert: (row: RoomMemberRow) => void;
        list: (roomId: string) => RoomMemberRow[];
        remove: (roomId: string, role: string) => void;
        removeByRoom: (roomId: string) => void;
      };
      messages: {
        insert: (row: RoomMessageRow) => void;
        list: (roomId: string) => RoomMessageRow[];
        deleteByRoom: (roomId: string) => void;
      };
      transaction: <T>(fn: () => T) => T;
    }
  ) {}

  list(options: { sessionId?: string; projectId?: string } = {}): Room[] {
    let rows: RoomRow[];
    if (options.sessionId) {
      rows = this.deps.rooms.listBySession(options.sessionId);
    } else if (options.projectId) {
      rows = this.deps.rooms.listByProject(options.projectId);
    } else {
      rows = this.deps.rooms.listAll();
    }
    return rows.map(rowToRoom).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(roomId: string): Room | undefined {
    const row = this.deps.rooms.get(roomId);
    return row ? rowToRoom(row) : undefined;
  }

  getDetail(roomId: string): RoomDetail | undefined {
    const room = this.get(roomId);
    if (!room) return undefined;
    return {
      ...room,
      members: this.deps.members.list(roomId).map((m) => ({
        role: m.role,
        taskId: m.task_id,
        joinedAt: m.joined_at,
      })),
      messages: this.messages(roomId),
    };
  }

  create(input: CreateRoomInput): Room {
    const name = validateName(input.name);
    const now = Date.now();
    const row: RoomRow = {
      id: `room-${randomUUID()}`,
      session_id: input.sessionId?.trim() || null,
      project_id: input.projectId?.trim() || null,
      name,
      goal: input.goal?.trim() || null,
      status: 'open',
      created_at: now,
      updated_at: now,
    };
    this.deps.rooms.create(row);
    return rowToRoom(row);
  }

  /**
   * Add or refresh a member. Re-joining the same role updates the task rather
   * than erroring, because a role may legitimately be filled again after its
   * previous task finished.
   */
  addMember(roomId: string, role: string, taskId?: string | null): void {
    if (!this.deps.rooms.get(roomId)) {
      throw new RoomValidationError(`Unknown room: ${roomId}`);
    }
    const cleanRole = validateRole(role);
    this.deps.transaction(() => {
      this.deps.members.upsert({
        room_id: roomId,
        role: cleanRole,
        task_id: taskId?.trim() || null,
        joined_at: Date.now(),
      });
      this.deps.rooms.update(roomId, { updated_at: Date.now() });
    });
  }

  /** A role leaving does not remove its messages; they keep their author. */
  removeMember(roomId: string, role: string): void {
    this.deps.members.remove(roomId, role.trim());
    this.deps.rooms.update(roomId, { updated_at: Date.now() });
  }

  postMessage(input: PostMessageInput): RoomMessage {
    if (!this.deps.rooms.get(input.roomId)) {
      throw new RoomValidationError(`Unknown room: ${input.roomId}`);
    }
    const body = validateBody(input.body);
    const role = validateRole(input.fromRole);
    if (!(KINDS as readonly string[]).includes(input.kind)) {
      throw new RoomValidationError(`Unknown message kind: ${input.kind}`);
    }
    const now = Date.now();
    const row: RoomMessageRow = {
      id: `room-msg-${randomUUID()}`,
      room_id: input.roomId,
      from_role: role,
      kind: input.kind,
      body,
      // Never negative: a stored cost that reads as a credit is nonsense, and
      // an untrusted caller must not be able to corrupt the room's cost record.
      model_calls: Math.max(0, Math.floor(input.modelCalls ?? 0)),
      status: input.status ?? null,
      created_at: now,
    };
    this.deps.transaction(() => {
      this.deps.messages.insert(row);
      this.deps.rooms.update(input.roomId, { updated_at: now });
    });
    return rowToMessage(row);
  }

  /**
   * Persist a question and its outcome as the pair it was, so a room reads as a
   * conversation rather than two unrelated lines.
   */
  recordExchange(input: RecordExchangeInput): { question: RoomMessage; answer: RoomMessage } {
    if (!this.deps.rooms.get(input.roomId)) {
      throw new RoomValidationError(`Unknown room: ${input.roomId}`);
    }
    const questionBody = validateBody(input.question);
    // An unanswered question has no answer text to store; the fallback is what
    // the bus handed the blocked agent, and keeping it explains why.
    const answerBody = validateBody(input.answer || '(no answer recorded)');
    const now = Date.now();
    const question: RoomMessageRow = {
      id: `room-msg-${randomUUID()}`,
      room_id: input.roomId,
      from_role: validateRole(input.fromRole),
      kind: 'question',
      body: questionBody,
      model_calls: 0,
      status: input.status,
      created_at: input.at || now,
    };
    const answer: RoomMessageRow = {
      id: `room-msg-${randomUUID()}`,
      room_id: input.roomId,
      from_role: validateRole(input.targetRole),
      kind: 'answer',
      body: answerBody,
      model_calls: Math.max(0, Math.floor(input.modelCalls)),
      status: input.status,
      created_at: (input.at || now) + Math.max(0, Math.floor(input.durationMs)),
    };

    this.deps.transaction(() => {
      this.deps.messages.insert(question);
      this.deps.messages.insert(answer);
      this.deps.rooms.update(input.roomId, { updated_at: answer.created_at });
    });

    return { question: rowToMessage(question), answer: rowToMessage(answer) };
  }

  /** Messages in chronological order, which is how a conversation reads. */
  messages(roomId: string): RoomMessage[] {
    return this.deps.messages
      .list(roomId)
      .map(rowToMessage)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  setStatus(roomId: string, status: RoomStatus): Room {
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new RoomValidationError(`Unknown room status: ${status}`);
    }
    if (!this.deps.rooms.get(roomId)) {
      throw new RoomValidationError(`Unknown room: ${roomId}`);
    }
    const now = Date.now();
    this.deps.rooms.update(roomId, { status, updated_at: now });
    return this.get(roomId) as Room;
  }

  /** Total model calls the room's exchanges actually spent. */
  totalModelCalls(roomId: string): number {
    return this.messages(roomId).reduce((sum, m) => sum + m.modelCalls, 0);
  }

  delete(roomId: string): boolean {
    if (!this.deps.rooms.get(roomId)) return false;
    this.deps.transaction(() => {
      this.deps.messages.deleteByRoom(roomId);
      this.deps.members.removeByRoom(roomId);
      this.deps.rooms.delete(roomId);
    });
    return true;
  }
}