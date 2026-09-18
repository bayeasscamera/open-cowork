/**
 * @module main/ipc/artifacts-handlers
 *
 * Renderer artifact IPC: recent-file listing and workspace-contained file
 * reads. Extracted from main/index.ts so the workspace containment policy
 * can be behavior-tested without booting the app.
 */

import * as fs from 'fs';
import { isAbsolute } from 'path';
import { ipcMain } from 'electron';
import { isPathWithinRoot } from '../tools/path-containment';
import { listRecentWorkspaceFiles } from '../utils/recent-workspace-files';
import { logError } from '../utils/logger';

/** Accessor for the mutable app-level working dir owned by main/index.ts. */
export interface ArtifactsIpcContext {
  getWorkingDir(): string | null;
}

export function registerArtifactsIpcHandlers(context: ArtifactsIpcContext): void {
  ipcMain.handle(
    'artifacts.listRecentFiles',
    async (_event, cwd: string, sinceMs: number, limit: number = 50) => {
      if (!cwd || !isAbsolute(cwd)) {
        return [];
      }
      return listRecentWorkspaceFiles(cwd, sinceMs, limit);
    }
  );

  ipcMain.handle('artifacts.readFile', async (_event, filePath: string) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      // Security: the renderer may only read files inside the active workspace.
      // Resolve symlinks first so a link pointing outside the workspace is caught.
      const allowedRoot = context.getWorkingDir();
      if (allowedRoot) {
        const resolvedPath = fs.realpathSync(filePath);
        if (!isPathWithinRoot(resolvedPath, fs.realpathSync(allowedRoot))) {
          throw new Error(`Access denied: path is outside the workspace: ${filePath}`);
        }
      }
      // Limit to 5MB to avoid freezing UI
      const stat = fs.statSync(filePath);
      if (stat.size > 5 * 1024 * 1024) {
        return (
          fs.readFileSync(filePath, 'utf-8').slice(0, 100000) +
          '\n\n[Content truncated: file exceeds 5MB]'
        );
      }
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
      logError('[artifacts.readFile] failed:', err);
      throw err;
    }
  });
}