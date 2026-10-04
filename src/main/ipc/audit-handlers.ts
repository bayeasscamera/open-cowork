import { ipcMain } from 'electron';
import { getGlobalAuditLog } from '../agent/audit-log-registry';

export function registerAuditIpcHandlers(): void {
  ipcMain.handle('audit.list', (_e, _sessionId?: string) => {
    const log = getGlobalAuditLog();
    return log ? log.list() : [];
  });

  ipcMain.handle('audit.export', (_e, format: 'json' | 'ndjson' | 'csv') => {
    const log = getGlobalAuditLog();
    if (!log) return '';
    if (format === 'json') return log.exportJson();
    if (format === 'ndjson') return log.exportNdjson();
    if (format === 'csv') return log.exportCsv();
    return '';
  });

  ipcMain.handle('audit.tail', (_e, n: number) => {
    const log = getGlobalAuditLog();
    return log ? log.list().slice(-n) : [];
  });
}
