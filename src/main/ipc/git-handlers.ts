/**
 * @module main/ipc/git-handlers
 *
 * Git IPC for the branch selector. Git runs in the main process (see
 * `git-operations`); the renderer only sends a workspace path and a branch
 * name, never a command.
 *
 * The workspace is resolved by the caller-supplied accessor rather than taken
 * from the event payload: the renderer must not be able to point the app at an
 * arbitrary directory on disk.
 */

import { ipcMain } from 'electron';
import { logError, log } from '../utils/logger';
import {
  checkoutBranch,
  createAndCheckoutBranch,
  isGitRepository,
  listBranches,
  type GitBranchesResult,
} from '../git/git-operations';

export interface GitIpcContext {
  /** Workspace the app is currently working in. */
  getCurrentWorkingDir(): string | null;
}

const DEFAULT_GIT_CONTEXT: GitIpcContext = {
  getCurrentWorkingDir: () => null,
};

/** Shown when there is no workspace yet — the panel stays disabled in that case. */
const NO_WORKSPACE: GitBranchesResult = {
  isRepo: false,
  branches: [],
  currentBranch: null,
  dirtyCount: 0,
  repoRoot: null,
};

export function registerGitIpcHandlers(context: GitIpcContext = DEFAULT_GIT_CONTEXT): void {
  ipcMain.handle('git.listBranches', async (): Promise<GitBranchesResult> => {
    try {
      const cwd = context.getCurrentWorkingDir();
      if (!cwd) return NO_WORKSPACE;
      // Re-read on every call: the panel must never show a stale branch list
      // or a stale uncommitted-file count.
      return await listBranches(cwd);
    } catch (error) {
      logError('[Git] listBranches failed:', error);
      return { ...NO_WORKSPACE, error: 'Unable to read the Git repository' };
    }
  });

  ipcMain.handle(
    'git.isRepository',
    async (): Promise<boolean> => {
      try {
        const cwd = context.getCurrentWorkingDir();
        if (!cwd) return false;
        return await isGitRepository(cwd);
      } catch (error) {
        logError('[Git] isRepository failed:', error);
        return false;
      }
    }
  );

  ipcMain.handle(
    'git.checkoutBranch',
    async (
      _event: unknown,
      payload: { name?: unknown; stash?: unknown }
    ): Promise<{ ok: boolean; stashed: boolean; error?: string }> => {
      try {
        const cwd = context.getCurrentWorkingDir();
        const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
        if (!cwd || !name) {
          return { ok: false, stashed: false, error: 'No branch selected' };
        }
        log('[Git] Switching to branch:', name);
        return await checkoutBranch(cwd, name, { stash: payload?.stash === true });
      } catch (error) {
        logError('[Git] checkoutBranch failed:', error);
        return { ok: false, stashed: false, error: 'Unable to switch branch' };
      }
    }
  );

  ipcMain.handle(
    'git.createBranch',
    async (
      _event: unknown,
      payload: { name?: unknown }
    ): Promise<{ ok: boolean; stashed: boolean; error?: string }> => {
      try {
        const cwd = context.getCurrentWorkingDir();
        const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
        if (!cwd || !name) {
          return { ok: false, stashed: false, error: 'No branch name given' };
        }
        log('[Git] Creating branch:', name);
        return await createAndCheckoutBranch(cwd, name);
      } catch (error) {
        logError('[Git] createBranch failed:', error);
        return { ok: false, stashed: false, error: 'Unable to create the branch' };
      }
    }
  );
}
