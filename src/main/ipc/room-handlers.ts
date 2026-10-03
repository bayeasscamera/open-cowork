/**
 * @module main/ipc/room-handlers
 *
 * Renderer access to persistent rooms (rooms.*).
 *
 * Ownership is *verified*, not trusted: the renderer names the session it is
 * looking at and the handler checks the room actually belongs to it, matching how
 * session ids already flow through the artifacts surface. A stale or wrong id
 * returns nothing rather than another conversation's transcript.
 *
 * Room deletion discards a whole multi-agent record, so it requires human
 * confirmation and fails closed when no dialog is available.
 */

import { ipcMain } from 'electron';
import type { RoomStore } from '../rooms/room-store';

export interface RoomIpcContext {
  getStore(): RoomStore;
  getProjectId?(sessionId: string): string | null;
  confirmDelete?(roomId: string, name: string): Promise<boolean>;
}

/** Whether this room may be shown to the renderer looking at `sessionId`. */
function belongsToSession(
  room: { sessionId: string | null; projectId: string | null },
  sessionId: string,
  projectId: string | null
): boolean {
  if (room.sessionId === sessionId) return true;
  return projectId !== null && room.projectId === projectId;
}

export function registerRoomIpcHandlers(context: RoomIpcContext): void {
  ipcMain.handle('rooms.list', (_event, sessionId: string | null, scope?: 'session' | 'project') => {
    if (!sessionId) return [];
    const store = context.getStore();
    const projectId = context.getProjectId?.(sessionId) ?? null;
    if (scope === 'project') {
      if (!projectId) return [];
      return store.list({ projectId });
    }
    return store.list({ sessionId });
  });

  ipcMain.handle('rooms.detail', (_event, sessionId: string | null, roomId: string) => {
    if (!sessionId) return null;
    const store = context.getStore();
    const detail = store.getDetail(roomId);
    if (!detail) return null;
    const projectId = context.getProjectId?.(sessionId) ?? null;
    if (!belongsToSession(detail, sessionId, projectId)) return null;
    return detail;
  });

  ipcMain.handle(
    'rooms.postMessage',
    (
      _event,
      payload: {
        sessionId: string | null;
        roomId: string;
        body: string;
      }
    ) => {
      if (!payload?.sessionId) return null;
      const store = context.getStore();
      const room = store.get(payload.roomId);
      if (!room) return null;
      const projectId = context.getProjectId?.(payload.sessionId) ?? null;
      if (!belongsToSession(room, payload.sessionId, projectId)) return null;

      // Posted as the user, not as a role: a room note from the UI must not be
      // attributed to an agent.
      return store.postMessage({
        roomId: payload.roomId,
        fromRole: 'user',
        kind: 'note',
        body: payload.body,
      });
    }
  );

  ipcMain.handle(
    'rooms.delete',
    async (_event, sessionId: string | null, roomId: string) => {
      const store = context.getStore();
      const room = store.get(roomId);
      if (!room) return { success: false as const, error: 'not_found' };
      const projectId = sessionId ? (context.getProjectId?.(sessionId) ?? null) : null;
      // Same ownership rule as the reads: a caller cannot delete — nor prompt for
      // — a room it is not allowed to see.
      if (!sessionId || !belongsToSession(room, sessionId, projectId)) {
        return { success: false as const, error: 'not_found' };
      }
      if (!context.confirmDelete) {
        return { success: false as const, error: 'confirmation_unavailable' };
      }
      const approved = await context.confirmDelete(room.id, room.name);
      if (approved !== true) {
        return { success: false as const, error: 'confirmation_denied' };
      }
      store.delete(room.id);
      return { success: true as const };
    }
  );
}