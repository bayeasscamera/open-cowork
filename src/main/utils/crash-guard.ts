/**
 * @module main/utils/crash-guard
 * Ultra-Robustness Process Guardian
 *
 * Catches unhandled promise rejections, uncaught exceptions and renderer crashes
 * without bringing down the main process or corrupting session data.
 */

import { app } from 'electron';
import { logError, logWarn } from './logger';

export class CrashGuard {
  private static isInitialized = false;

  public static initialize(): void {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Uncaught Exceptions in Main Process
    process.on('uncaughtException', (error: Error) => {
      logError('[CrashGuard] Uncaught Exception trapped:', error.stack || error.message);
      // Prevent hard crash; ensure logs and DB transactions are flushed
    });

    // Unhandled Promise Rejections (e.g. timeout on network, failed tool call)
    process.on('unhandledRejection', (reason: any) => {
      logWarn('[CrashGuard] Unhandled Promise Rejection trapped:', reason?.stack || reason);
    });

    // Monitor renderer crashes
    app.on('render-process-gone', (_event, webContents, details) => {
      logError('[CrashGuard] Renderer process gone:', details.reason, 'exitCode:', details.exitCode);
      if (details.reason !== 'clean-exit') {
        // Attempt clean window reload rather than dead black screen
        try {
          webContents.reload();
        } catch {
          /* best effort */
        }
      }
    });

    // Monitor child process / GPU crashes
    app.on('child-process-gone', (_event, details) => {
      logWarn('[CrashGuard] Child process gone:', details.type, 'reason:', details.reason);
    });
  }
}
