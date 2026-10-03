/**
 * Renderer-facing contract for rooms.
 *
 * Mirrors the store's shape rather than re-exporting it, so the renderer surface
 * stays narrow: a room's transcript and members are what the UI renders, and
 * nothing about how they are stored.
 */

/**
 * Declared here rather than imported from the main-process store: the renderer
 * must not reach into `src/main`, and a type-only import would still draw the
 * dependency in the source. Mirrors the store's unions; the store tests are what
 * keep the two in step.
 */
export type RoomStatusUi = 'open' | 'closed';
export type RoomMessageKindUi = 'question' | 'answer' | 'note';
export type RoomMessageStatusUi = 'answered' | 'timeout' | 'unavailable' | 'limit';

export interface RoomUi {
  id: string;
  sessionId: string | null;
  projectId: string | null;
  name: string;
  goal: string | null;
  status: RoomStatusUi;
  createdAt: number;
  updatedAt: number;
}

export interface RoomMemberUi {
  role: string;
  taskId: string | null;
  joinedAt: number;
}

export interface RoomMessageUi {
  id: string;
  roomId: string;
  fromRole: string;
  kind: RoomMessageKindUi;
  body: string;
  modelCalls: number;
  status?: RoomMessageStatusUi;
  createdAt: number;
}

export interface RoomDetailUi extends RoomUi {
  members: RoomMemberUi[];
  messages: RoomMessageUi[];
}