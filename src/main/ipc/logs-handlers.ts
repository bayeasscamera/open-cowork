/**
 * @module main/ipc/logs-handlers
 *
 * Renderer log IPC, including the diagnostic bundle export. Extracted from
 * main/index.ts so the channel contract can be behavior-tested without
 * booting the app; the app-wide runtime state it composes is injected.
 */

import * as fs from 'fs';
import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron';
import {
  log,
  logWarn,
  logError,
  getLogFilePath,
  getLogsDirectory,
  getAllLogFiles,
  closeLogFile,
  setDevLogsEnabled,
  isDevLogsEnabled,
} from '../utils/logger';
import { configStore } from '../config/config-store';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import { buildDiagnosticsSummary, sanitizeDiagnosticBaseUrl } from '../utils/diagnostics-summary';
import type { SessionManager } from '../session/session-manager';

/** Accessors for app-level state owned by main/index.ts. */
interface LogsIpcContext {
  getSessionManager(): SessionManager | null;
  getMainWindow(): BrowserWindow | null;
  getCurrentWorkingDir(): string | null;
}

const DEFAULT_LOGS_CONTEXT: LogsIpcContext = {
  getSessionManager: () => null,
  getMainWindow: () => null,
  getCurrentWorkingDir: () => null,
};

export function registerLogsIpcHandlers(context: LogsIpcContext = DEFAULT_LOGS_CONTEXT): void {
  // Deliberately no snapshot of `context` here. `mainWindow` is recreated
  // whenever macOS reopens the app after its window was closed
  // (`app.on('activate')` in main/index.ts), and `logs.export` parents the save
  // dialog to it: a handle captured at registration goes stale and the dialog is
  // handed a destroyed window. Same convention as git-handlers and
  // config-handlers — read the accessor inside the handler.
  ipcMain.handle('logs.getPath', () => {
    try {
      return getLogFilePath();
    } catch (error) {
      logError('[Logs] Error getting log path:', error);
      return null;
    }
  });

  ipcMain.handle('logs.getDirectory', () => {
    try {
      return getLogsDirectory();
    } catch (error) {
      logError('[Logs] Error getting logs directory:', error);
      return null;
    }
  });

  ipcMain.handle('logs.getAll', () => {
    try {
      return getAllLogFiles();
    } catch (error) {
      logError('[Logs] Error getting all log files:', error);
      return [];
    }
  });

  ipcMain.handle('logs.open', async () => {
    try {
      const logsDir = getLogsDirectory();
      await shell.openPath(logsDir);
      return { success: true };
    } catch (error) {
      logError('[Logs] Error opening logs directory:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.clear', async () => {
    try {
      const logFiles = getAllLogFiles();

      // Close current log file
      closeLogFile();

      // Delete all log files
      for (const logFile of logFiles) {
        try {
          fs.unlinkSync(logFile.path);
          log('[Logs] Deleted log file:', logFile.name);
        } catch (err) {
          logError('[Logs] Failed to delete log file:', logFile.name, err);
        }
      }

      // Log will automatically reinitialize on next log call
      log('[Logs] Log files cleared and reinitialized');

      return { success: true, deletedCount: logFiles.length };
    } catch (error) {
      logError('[Logs] Error clearing logs:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.setEnabled', async (_event, enabled: boolean) => {
    try {
      setDevLogsEnabled(enabled);
      configStore.set('enableDevLogs', enabled);
      log('[Logs] Developer logs', enabled ? 'enabled' : 'disabled');
      return { success: true, enabled };
    } catch (error) {
      logError('[Logs] Error setting dev logs enabled:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.isEnabled', () => {
    try {
      return { success: true, enabled: isDevLogsEnabled() };
    } catch (error) {
      logError('[Logs] Error getting dev logs enabled:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.write', (_event, level: unknown, ...rest: unknown[]) => {
    try {
      // Contract: preload sends (level, args[]). Legacy callers may still spread
      // the arguments, so accept both shapes instead of crashing on either.
      const entries = rest.length === 1 && Array.isArray(rest[0]) ? (rest[0] as unknown[]) : rest;
      if (level === 'warn') {
        logWarn(...entries);
      } else if (level === 'error') {
        logError(...entries);
      } else {
        log(...entries);
      }
      return { success: true };
    } catch (error) {
      console.error('[Logs] Error writing log:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('logs.export', async () => {
    try {
      const sessionManager = context.getSessionManager();
      const currentWorkingDir = context.getCurrentWorkingDir();
      const logFiles = getAllLogFiles();
      const diagnosticsSummary = buildDiagnosticsSummary({
        app: {
          version: app.getVersion(),
          isPackaged: app.isPackaged,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          chromeVersion: process.versions.chrome,
        },
        runtime: {
          currentWorkingDir,
          logsDirectory: getLogsDirectory(),
          logFileCount: logFiles.length,
          totalLogSizeBytes: logFiles.reduce((total, file) => total + file.size, 0),
          devLogsEnabled: isDevLogsEnabled(),
        },
        config: {
          provider: configStore.get('provider'),
          model: configStore.get('model'),
          baseUrl: sanitizeDiagnosticBaseUrl(configStore.get('baseUrl') || undefined),
          customProtocol: configStore.get('customProtocol') || null,
          sandboxEnabled: !!configStore.get('sandboxEnabled'),
          thinkingEnabled: !!configStore.get('enableThinking'),
          apiKeyConfigured: !!configStore.get('apiKey'),
          agentCliPathConfigured: !!configStore.get('agentCliPath'),
          defaultWorkdir: configStore.get('defaultWorkdir') || null,
          globalSkillsPathConfigured: !!configStore.get('globalSkillsPath'),
        },
        sandbox: {
          mode: getSandboxAdapter().mode,
          initialized: getSandboxAdapter().initialized,
        },
        sessions: sessionManager ? sessionManager.listSessions() : [],
        logFiles,
        deps: {
          getMessages: (sessionId: string) =>
            sessionManager ? sessionManager.getMessages(sessionId) : [],
          getTraceSteps: (sessionId: string) =>
            sessionManager ? sessionManager.getTraceSteps(sessionId) : [],
        },
      });

      // Show save dialog, parented to the window that is alive *now*. After the
      // window has been recreated the handle must be re-read, and a destroyed
      // window must never be passed as the parent (the previous `mainWindow!`
      // asserted a non-null window that the snapshot could not guarantee).
      const parentWindow = context.getMainWindow();
      const dialogOptions = {
        title: 'Export Logs',
        defaultPath: `opencowork-logs-${new Date().toISOString().split('T')[0]}.zip`,
        filters: [
          { name: 'ZIP Archive', extensions: ['zip'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      };
      const result = parentWindow
        ? await dialog.showSaveDialog(parentWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);

      if (result.canceled || !result.filePath) {
        return { success: false, error: 'User cancelled' };
      }

      // Dynamic import archiver
      const archiver = await import('archiver');
      const output = fs.createWriteStream(result.filePath);
      const archive = archiver.default('zip', { zlib: { level: 9 } });

      return new Promise((resolve) => {
        let settled = false;
        const settle = (value: {
          success: boolean;
          path?: string;
          size?: number;
          error?: string;
        }) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };

        output.on('close', () => {
          log('[Logs] Exported logs to:', result.filePath);
          settle({
            success: true,
            path: result.filePath,
            size: archive.pointer(),
          });
        });

        output.on('error', (err: Error) => {
          logError('[Logs] Error writing exported archive:', err);
          settle({ success: false, error: err.message });
        });

        archive.on('error', (err: Error) => {
          logError('[Logs] Error creating archive:', err);
          settle({ success: false, error: err.message });
        });

        archive.pipe(output);

        // Add all log files
        for (const logFile of logFiles) {
          archive.file(logFile.path, { name: logFile.name });
        }

        // Add system info
        const systemInfo = {
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
          appVersion: app.getVersion(),
          exportDate: new Date().toISOString(),
          logFiles: logFiles.map((f) => ({
            name: f.name,
            size: f.size,
            modified: f.mtime,
          })),
        };
        archive.append(JSON.stringify(systemInfo, null, 2), { name: 'system-info.json' });
        archive.append(JSON.stringify(diagnosticsSummary, null, 2), {
          name: 'diagnostics-summary.json',
        });
        archive.append(
          [
            'Open Cowork diagnostic bundle',
            `Exported at: ${diagnosticsSummary.exportedAt}`,
            '',
            'Included files:',
            '- Application log files (*.log)',
            '- system-info.json',
            '- diagnostics-summary.json',
            '',
            'diagnostics-summary.json contains a redacted runtime/config snapshot,',
            'plus metadata-only session summaries and recent error traces to speed up debugging.',
          ].join('\n'),
          { name: 'README.txt' }
        );

        archive.finalize();
      });
    } catch (error) {
      logError('[Logs] Error exporting logs:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
}
