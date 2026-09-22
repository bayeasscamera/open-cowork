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
export interface MemoryIpcContext {
  getMemoryService(): MemoryService | null;
  getMainWindow(): BrowserWindow | null;
  getSessionManager(): SessionManager | null;
}

export function registerMemoryIpcHandlers(context: MemoryIpcContext): void {
  const memory = context.getMemoryService();
  const mainWindow = context.getMainWindow();
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
      () => mainWindow,
      () => memory?.personalFiles.list() ?? { success: false, error: 'unavailable' }
    )
  );
  ipcMain.handle(
    'personalFiles.read',
    personalFilesHandler(
      () => mainWindow,
      (input) => memory?.personalFiles.read(input) ?? { success: false, error: 'unavailable' }
    )
  );
  ipcMain.handle(
    'personalFiles.history',
    personalFilesHandler(
      () => mainWindow,
      (input) => memory?.personalFiles.history(input) ?? { success: false, error: 'unavailable' }
    )
  );
  ipcMain.handle(
    'personalFiles.restore',
    personalFilesHandler(
      () => mainWindow,
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
}
