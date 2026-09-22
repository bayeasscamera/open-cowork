/**
 * @module main/ipc/window-handlers
 *
 * App window and shell IPC channels: version/theme queries, external link
 * opening, file reveal, file picking and window controls. Extracted from
 * main/index.ts; only the window handle is injected.
 */

import { app, dialog, ipcMain, nativeTheme, type BrowserWindow } from 'electron';
import { safeOpenExternal } from '../utils/safe-open-external';
import { revealFileInFolder } from '../utils/reveal-in-folder';
import { logError } from '../utils/logger';

/** Accessor for the app window owned by main/index.ts. */
interface WindowIpcContext {
  getMainWindow(): BrowserWindow | null;
}

export function registerWindowIpcHandlers(context: WindowIpcContext): void {
  const mainWindow = context.getMainWindow();
  ipcMain.handle('get-version', () => {
    try {
      return app.getVersion();
    } catch (error) {
      logError('[IPC] Error getting version:', error);
      return 'unknown';
    }
  });

  ipcMain.handle('system.getTheme', () => {
    try {
      return { shouldUseDarkColors: nativeTheme.shouldUseDarkColors };
    } catch (error) {
      logError('[IPC] Error getting theme:', error);
      return { shouldUseDarkColors: true };
    }
  });

  ipcMain.handle('shell.openExternal', (_event, url: unknown) => safeOpenExternal(url));

  ipcMain.handle('shell.showItemInFolder', async (_event, filePath: string, cwd?: string) => {
    return revealFileInFolder(filePath, cwd);
  });

  ipcMain.handle('dialog.selectFiles', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Select Files',
    });

    if (result.canceled) {
      return [];
    }

    return result.filePaths;
  });

  ipcMain.on('window.minimize', () => {
    try {
      mainWindow?.minimize();
    } catch (error) {
      logError('[Window] Error minimizing:', error);
    }
  });

  ipcMain.on('window.maximize', () => {
    try {
      if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow?.maximize();
      }
    } catch (error) {
      logError('[Window] Error maximizing:', error);
    }
  });

  ipcMain.on('window.close', () => {
    try {
      mainWindow?.close();
    } catch (error) {
      logError('[Window] Error closing:', error);
    }
  });
}
