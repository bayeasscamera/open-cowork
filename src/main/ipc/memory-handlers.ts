/**
 * @module main/ipc/memory-handlers
 *
 * Memory and personal-files IPC channels (memory.*, personalFiles.*). Extracted
 * from main/index.ts; the memory service, window and session handles are
 * injected so this module never reaches into the app entry point.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { configStore } from '../config/config-store';
import { personalFilesHandler } from '../memory/personal-files-manager';
import type { MemoryService } from '../memory/memory-service';
import type { SessionManager } from '../session/session-manager';
import { sendToRenderer } from '../events/renderer-sender';

/** Accessors for app-level state owned by main/index.ts. */
interface MemoryIpcContext {
  getMemoryService(): MemoryService | null;
  getMainWindow(): BrowserWindow | null;
  getSessionManager(): SessionManager | null;
}

export function registerMemoryIpcHandlers(context: MemoryIpcContext): void {
  // `memory` and `sessionManager` are each assigned once per run mode before this
  // registration runs, so capturing them here is safe. `mainWindow` is not: it is
  // reassigned whenever a window is created and nulled when it closes, and macOS
  // recreates it on `app.on('activate')`. It is therefore read at call time by
  // the personalFiles handlers below, matching git-handlers and config-handlers.
  const memory = context.getMemoryService();
  const sessionManager = context.getSessionManager();
  ipcMain.handle('memory.getOverview', (_event, cwd?: string) => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.getOverview(cwd);
  });

  ipcMain.handle(
    'memory.search',
    (
      _event,
      payload: {
        query: string;
        cwd?: string;
        sourceWorkspace?: string | null;
        scope?: 'workspace' | 'global' | 'all';
        limit?: number;
      }
    ) => {
      if (!memory) {
        throw new Error('Memory service not initialized');
      }
      return memory.search(payload);
    }
  );

  ipcMain.handle('memory.read', (_event, id: string) => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.read(id);
  });

  ipcMain.handle('memory.rebuildWorkspace', async (_event, cwd: string) => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.rebuildWorkspace(cwd);
  });

  ipcMain.handle('memory.clearWorkspace', (_event, cwd: string) => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.clearWorkspace(cwd);
  });

  ipcMain.handle('memory.clearCoreMemory', () => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.clearCoreMemory();
  });

  ipcMain.handle('memory.rebuildAll', async () => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.rebuildAll();
  });

  ipcMain.handle(
    'personalFiles.list',
    personalFilesHandler(
      () => context.getMainWindow(),
      () => memory?.personalFiles.list() ?? { success: false, error: 'unavailable' }
    )
  );
  ipcMain.handle(
    'personalFiles.read',
    personalFilesHandler(
      () => context.getMainWindow(),
      (input) => memory?.personalFiles.read(input) ?? { success: false, error: 'unavailable' }
    )
  );
  ipcMain.handle(
    'personalFiles.history',
    personalFilesHandler(
      () => context.getMainWindow(),
      (input) => memory?.personalFiles.history(input) ?? { success: false, error: 'unavailable' }
    )
  );
  ipcMain.handle(
    'personalFiles.restore',
    personalFilesHandler(
      () => context.getMainWindow(),
      (input) => memory?.personalFiles.restore(input) ?? { success: false, error: 'unavailable' }
    )
  );

  ipcMain.handle('memory.listFiles', () => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.listFiles();
  });

  ipcMain.handle('memory.readFile', (_event, filePath: string) => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.readFile(filePath);
  });

  ipcMain.handle('memory.inspectSession', (_event, sessionId: string, workspaceKey?: string) => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    return memory.inspectSession(sessionId, workspaceKey);
  });

  ipcMain.handle('memory.setEnabled', (_event, enabled: boolean) => {
    if (!memory) {
      throw new Error('Memory service not initialized');
    }
    const result = memory.setEnabled(enabled);
    sessionManager?.clearAllCachedAgentSessions();
    sendToRenderer({
      type: 'config.status',
      payload: {
        isConfigured: configStore.isConfigured(),
        config: configStore.getAll(),
      },
    });
    return result;
  });

  // -------------------------------------------------------------------------
  // Daily Companion Personal Notes IPC handlers
  // Wrapped in try/catch so a SQLite failure returns structured data instead
  // of crashing the IPC handler and leaving the renderer hanging.
  // -------------------------------------------------------------------------

  ipcMain.handle('memory.notes.list', () => {
    try {
      const sm = sessionManager;
      if (!sm) return [];
      return sm.getMemoryManager().getAllNotes();
    } catch {
      return [];
    }
  });

  ipcMain.handle(
    'memory.notes.add',
    (_event, payload: { title: string; content: string; tags?: string[] }) => {
      try {
        if (!payload || typeof payload.content !== 'string' || !payload.content.trim()) {
          throw new Error('note content is required');
        }
        const sm = sessionManager;
        if (!sm) throw new Error('SessionManager not initialized');
        const title = typeof payload.title === 'string' ? payload.title.trim() : '';
        const tags = Array.isArray(payload.tags)
          ? payload.tags.filter((t): t is string => typeof t === 'string')
          : [];
        return sm.getMemoryManager().addNote(title, payload.content.trim(), tags);
      } catch (err) {
        throw new Error(
          `memory.notes.add failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );

  ipcMain.handle(
    'memory.notes.update',
    (
      _event,
      payload: {
        id: string;
        updates: { title?: string; content?: string; tags?: string[]; pinned?: boolean };
      }
    ) => {
      try {
        if (!payload || typeof payload.id !== 'string' || !payload.id) return false;
        const sm = sessionManager;
        if (!sm) return false;
        return sm.getMemoryManager().updateNote(payload.id, payload.updates ?? {});
      } catch {
        return false;
      }
    }
  );

  ipcMain.handle('memory.notes.delete', (_event, id: string) => {
    try {
      if (typeof id !== 'string' || !id.trim()) return false;
      const sm = sessionManager;
      if (!sm) return false;
      return sm.getMemoryManager().deleteNote(id.trim());
    } catch {
      return false;
    }
  });

  ipcMain.handle('memory.notes.search', (_event, query: string) => {
    try {
      const sm = sessionManager;
      if (!sm) return [];
      const q = typeof query === 'string' ? query.trim() : '';
      return sm.getMemoryManager().searchNotes(q);
    } catch {
      return [];
    }
  });
}
