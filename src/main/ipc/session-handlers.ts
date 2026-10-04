import { ipcMain } from 'electron';
import type { SessionManager } from '../session/session-manager';

export function registerSessionIpcHandlers(getSessionManager: () => SessionManager | null): void {
  ipcMain.handle('session.queue', (_, sessionId: string, text: string) => {
    const sm = getSessionManager();
    if (sm) sm.queueMessage(sessionId, text);
  });
  
  ipcMain.handle('session.steer', (_, sessionId: string, text: string) => {
    const sm = getSessionManager();
    if (sm) sm.steerAgent(sessionId, text);
  });
}
