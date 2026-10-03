/**
 * IPC surface for mods v2.
 *
 * Kept separate from the legacy `mods.*` channels: the v1 registry is still
 * serving the old settings UI, and folding both into one namespace would make a
 * partial migration indistinguishable from a complete one.
 *
 * Two rules hold for every handler here:
 *  - nothing loads without an approval whose pinned hash matches;
 *  - the renderer is never trusted to have computed that hash. It echoes back
 *    what main displayed, and main recomputes before committing.
 */

import { ipcMain } from 'electron';
import { logError, logWarn } from '../utils/logger';
import { buildInstallReview } from '../mods/v2/install-plan';
import { getModsRuntime } from '../mods/v2/runtime';
import {
  isInstallRequest,
  type InstalledModDto,
  type ModReviewDto,
  type SafeModeDto,
} from '../../shared/mods-v2-contract';
import { promises as fs } from 'fs';
import path from 'path';

export interface ModsV2Deps {
  /** Staged folder the installer copies into the mods directory. */
  stagingDir: string;
  modsDir: string;
  /** Installed record + enable-state store. */
  listInstalled: () => InstalledModDto[];
  setEnabled: (id: string, enabled: boolean, projectId?: string) => void;
  uninstall: (modId: string) => Promise<boolean>;
  /** Commit an approved, staged plugin. */
  commit: (input: { review: ModReviewDto; stagingDir: string; approvedHash: string; source: string }) => Promise<{ ok: boolean; error?: string }>;
  safeMode: () => SafeModeDto;
}

export function registerModsV2IpcHandlers(deps: ModsV2Deps): void {
  /**
   * Build the review payload for a folder WITHOUT installing anything.
   *
   * The renderer uses this to show the manifest, the code and the hash. No
   * approval exists yet at this point, and nothing on disk changes.
   */
  ipcMain.handle('modsV2.inspect', async (_event, rootDir: unknown) => {
    try {
      if (typeof rootDir !== 'string' || !rootDir) {
        return { success: false as const, error: 'invalid_input' };
      }
      const result = await buildInstallReview(rootDir);
      if (!result.ok) return { success: false as const, error: result.error };
      return { success: true as const, data: result.review as ModReviewDto };
    } catch (error) {
      logError('[IPC] modsV2.inspect failed:', error);
      return { success: false as const, error: 'inspect_failed' };
    }
  });

  ipcMain.handle('modsV2.install', async (_event, request: unknown) => {
    try {
      if (!isInstallRequest(request)) {
        return { success: false as const, error: 'invalid_input' };
      }
      // Recompute the review at commit time. The payload the renderer echoed was
      // built earlier; if the bytes moved since, the fingerprint differs and the
      // install is refused rather than proceeding on a stale consent.
      const review = await buildInstallReview(request.rootDir);
      if (!review.ok) return { success: false as const, error: review.error };

      const outcome = await deps.commit({
        review: review.review as ModReviewDto,
        stagingDir: request.rootDir,
        approvedHash: request.approvedHash,
        source: 'local folder',
      });
      if (!outcome.ok) return { success: false as const, error: outcome.error ?? 'install_failed' };
      return { success: true as const, data: { id: review.review.manifest.id } };
    } catch (error) {
      logError('[IPC] modsV2.install failed:', error);
      return { success: false as const, error: 'install_failed' };
    }
  });

  ipcMain.handle('modsV2.list', async () => {
    try {
      const health = getModsRuntime()?.health() ?? {};
      const mods = deps.listInstalled().map((mod) => {
        const state = health[mod.id];
        return {
          ...mod,
          ...(state ? { health: { disabled: state.disabled, failures: state.failures, ...(state.lastError ? { lastError: state.lastError } : {}) } } : {}),
        };
      });
      return { success: true as const, data: { mods } };
    } catch (error) {
      logError('[IPC] modsV2.list failed:', error);
      return { success: false as const, error: 'list_failed' };
    }
  });

  ipcMain.handle('modsV2.setEnabled', (_event, id: unknown, enabled: unknown, projectId: unknown) => {
    try {
      if (typeof id !== 'string' || typeof enabled !== 'boolean') {
        return { success: false as const, error: 'invalid_input' };
      }
      deps.setEnabled(id, enabled, typeof projectId === 'string' ? projectId : undefined);
      return { success: true as const, data: null };
    } catch (error) {
      logError('[IPC] modsV2.setEnabled failed:', error);
      return { success: false as const, error: 'set_enabled_failed' };
    }
  });

  ipcMain.handle('modsV2.uninstall', async (_event, id: unknown) => {
    try {
      if (typeof id !== 'string' || !id) return { success: false as const, error: 'invalid_input' };
      const removed = await deps.uninstall(id);
      return { success: true as const, data: { removed } };
    } catch (error) {
      logError('[IPC] modsV2.uninstall failed:', error);
      return { success: false as const, error: 'uninstall_failed' };
    }
  });

  ipcMain.handle('modsV2.safeMode', async () => {
    try {
      return { success: true as const, data: deps.safeMode() };
    } catch (error) {
      logWarn('[IPC] modsV2.safeMode failed:', error);
      return { success: false as const, error: 'safe_mode_failed' };
    }
  });

  /**
   * Reveal the directory staged plugins live in, for the "browse" affordance.
   * A path is returned rather than a directory handle: the user picks in the OS
   * dialog, and main never accepts an arbitrary path from the renderer without
   * re-validating it through `buildInstallReview`.
   */
  ipcMain.handle('modsV2.paths', async () => {
    try {
      await fs.mkdir(deps.stagingDir, { recursive: true });
      await fs.mkdir(deps.modsDir, { recursive: true });
      return { success: true as const, data: { stagingDir: deps.stagingDir, modsDir: path.resolve(deps.modsDir) } };
    } catch (error) {
      logError('[IPC] modsV2.paths failed:', error);
      return { success: false as const, error: 'paths_failed' };
    }
  });
}