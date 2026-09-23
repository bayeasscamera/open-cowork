/**
 * @module main/ipc/preview-handlers
 *
 * IPC surface of the local dev-server preview. The URL is validated inside the
 * preview module; the renderer can only ask to open, close or inspect it.
 */

import { ipcMain } from 'electron';
import {
  closePreviewWindow,
  openPreviewWindow,
  previewState,
  type PreviewOpenResult,
  type PreviewWindowState,
} from '../preview/preview-window';
import { logError } from '../utils/logger';

const CLOSED: PreviewWindowState = { open: false, url: null };

export function registerPreviewIpcHandlers(): void {
  ipcMain.handle('preview.open', (_event, url: unknown): PreviewOpenResult => {
    try {
      return openPreviewWindow(url);
    } catch (error) {
      logError('[IPC] Error opening the preview window:', error);
      return { success: false, error: 'failed', state: CLOSED };
    }
  });

  ipcMain.handle('preview.close', (): PreviewWindowState => {
    try {
      return closePreviewWindow();
    } catch (error) {
      logError('[IPC] Error closing the preview window:', error);
      return CLOSED;
    }
  });

  ipcMain.handle('preview.state', (): PreviewWindowState => {
    try {
      return previewState();
    } catch (error) {
      logError('[IPC] Error reading the preview state:', error);
      return CLOSED;
    }
  });
}
