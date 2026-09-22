/**
 * @module main/ipc/mods-handlers
 *
 * Local mod and session-diff IPC channels (mods.*, diff.*). Extracted from
 * main/index.ts; both registries are process singletons, so no context is
 * required.
 */

import { ipcMain } from 'electron';
import { getModsRegistry } from '../mods/mods-runtime';
import { getDiffCollector } from '../mods/builtin-mods';
import { logError } from '../utils/logger';

export function registerModsIpcHandlers(): void {
  ipcMain.handle('mods.list', () => {
    try {
      return { success: true, mods: getModsRegistry().list() };
    } catch (error) {
      logError('[IPC] Error listing mods:', error);
      return { success: false, mods: [] };
    }
  });

  ipcMain.handle('mods.setEnabled', (_event, id: unknown, enabled: unknown) => {
    try {
      if (typeof id !== 'string' || typeof enabled !== 'boolean') {
        return { success: false, error: 'invalid_input' };
      }
      getModsRegistry().setEnabled(id, enabled);
      return { success: true };
    } catch (error) {
      logError('[IPC] Error setting mod state:', error);
      return { success: false, error: 'failed' };
    }
  });

  ipcMain.handle('diff.getSessionFiles', (_event, sessionId: unknown) => {
    try {
      if (typeof sessionId !== 'string' || !sessionId.trim()) {
        return { success: false, files: [] };
      }
      return { success: true, files: getDiffCollector().summary(sessionId) };
    } catch (error) {
      logError('[IPC] Error getting diff summary:', error);
      return { success: false, files: [] };
    }
  });
}
