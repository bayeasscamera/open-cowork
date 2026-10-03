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
interface ArtifactsIpcContext {
  getWorkingDir(): string | null;
}

/** Above this size the file is previewed from a bounded prefix instead. */
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

/** How much of an oversized file is ever returned. */
const MAX_PREVIEW_CHARS = 100000;

const TRUNCATION_NOTICE = '\n\n[Content truncated: file exceeds 5MB]';

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
      // Bound the read itself, not just what is returned. Reading the file whole
      // and slicing afterwards loads the entire payload into the main process
      // before discarding it, which is the freeze the cap exists to prevent.
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_PREVIEW_BYTES) {
        const handle = fs.openSync(filePath, 'r');
        try {
          const buffer = Buffer.alloc(MAX_PREVIEW_CHARS);
          const bytesRead = fs.readSync(handle, buffer, 0, MAX_PREVIEW_CHARS, 0);
          return (
            buffer.toString('utf-8', 0, bytesRead) + TRUNCATION_NOTICE
          );
        } finally {
          fs.closeSync(handle);
        }
      }
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
      logError('[artifacts.readFile] failed:', err);
      throw err;
    }
  });
}
