/**
 * Installing a mod: review → human approval → placed on disk → loaded.
 *
 * The order is the whole point and nothing may reorder it:
 *
 *   1. stage the source into a folder (copy, or bounded clone)
 *   2. build the review payload — manifest, declared capabilities, CODE, hash
 *   3. STOP. The caller must obtain an explicit human approval.
 *   4. record the approval against the fingerprint
 *   5. copy the staged folder into the mods directory
 *   6. load it through `ModLoader`, which re-checks the fingerprint
 *
 * Step 6 re-verifies rather than trusting step 4, because the gap between "the
 * user approved this hash" and "the loader reads the directory" is exactly where
 * a swap would go.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { log, logWarn } from '../../utils/logger';
import { ModApprovalStore } from './approval-store';
import { ModEventBus } from './event-bus';
import { ModLoader, type ModLoaderDeps } from './loader';
import { buildInstallReview, type InstallReview } from './install-plan';
import type { ModManifest } from '@cowork/mod-api';

export interface InstalledMod {
  readonly id: string;
  readonly version: string;
  readonly band: ModManifest['band'];
  /** Where it was installed from, shown in the settings page. */
  readonly source: string;
  readonly installedAt: number;
  /** Fingerprint at install time. A later mismatch is what triggers re-approval. */
  readonly fingerprint: string;
  readonly declaredCapabilities?: unknown;
}

export interface EnableState {
  /**
   * Per-mod toggle. Undefined means enabled. Mutated by replacing the whole
   * `enable` object on save rather than in place, so every field stays readonly
   * and a caller can never observe a half-applied change.
   */
  readonly byMod: Record<string, boolean>;
  /** Per-project overrides, keyed by project id. */
  readonly byProject: Record<string, Record<string, boolean>>;
}

export interface InstallStoreLike {
  load(): { installed: Record<string, InstalledMod>; enable: EnableState };
  save(data: { installed: Record<string, InstalledMod>; enable: EnableState }): void;
}

export function emptyInstallState(): { installed: Record<string, InstalledMod>; enable: EnableState } {
  return { installed: {}, enable: { byMod: {}, byProject: {} } };
}

export type InstallStage =
  /** Source staged; the review payload is ready for the user to read. */
  | { readonly stage: 'review'; readonly review: InstallReview; readonly stagingDir: string }
  | { readonly stage: 'error'; readonly error: string };

export interface CommitResult {
  readonly ok: boolean;
  readonly modId?: string;
  readonly error?: string;
  /** True when the plugin's bytes no longer match what was approved. */
  readonly reapprovalRequired?: boolean;
}

export class ModInstaller {
  constructor(
    private readonly store: InstallStoreLike,
    private readonly approvals: ModApprovalStore,
    private readonly loaderDeps: Omit<ModLoaderDeps, 'approvals' | 'importModule'>,
    private readonly importModule: ModLoaderDeps['importModule'],
    private readonly modsDir: string,
    private readonly stagingDir: string
  ) {}

  /**
   * Stage a plugin folder and produce the review payload.
   *
   * Nothing is copied into the mods directory and nothing is executed. The user
   * has not agreed to anything yet at this point.
   */
  async stageFromDirectory(sourceDir: string): Promise<InstallStage> {
    const review = await buildInstallReview(sourceDir);
    if (!review.ok) return { stage: 'error', error: review.error };
    return { stage: 'review', review: review.review, stagingDir: sourceDir };
  }

  /** Copy a staged folder into a private staging area before approval. */
  async stageByCopy(sourceDir: string): Promise<InstallStage> {
    const target = path.join(this.stagingDir, `${path.basename(sourceDir)}-${Date.now()}`);
    try {
      await fs.mkdir(this.stagingDir, { recursive: true });
      await fs.cp(sourceDir, target, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git${path.sep}`) && !src.endsWith(`${path.sep}.git`) });
    } catch (error) {
      return { stage: 'error', error: `Could not stage the plugin: ${error instanceof Error ? error.message : String(error)}` };
    }
    return this.stageFromDirectory(target);
  }

  /**
   * Commit a staged plugin. The caller MUST already hold the user's approval for
   * this exact fingerprint — `approvedHash` is passed in so the check happens
   * here, at the moment of installation, and not only at load time.
   */
  async commit(input: {
    review: InstallReview;
    stagingDir: string;
    approvedHash: string;
    source: string;
    now?: number;
  }): Promise<CommitResult> {
    const { review } = input;
    if (review.fingerprint !== input.approvedHash) {
      return {
        ok: false,
        error: 'The plugin changed between review and approval. Nothing was installed; review it again.',
        reapprovalRequired: true,
      };
    }

    const destination = path.join(this.modsDir, review.manifest.id);
    try {
      await fs.mkdir(this.modsDir, { recursive: true });
      // Replace atomically-ish: move the old copy aside rather than deleting it,
      // so a failed copy leaves a recoverable plugin instead of none.
      const previous = `${destination}.previous`;
      await fs.rm(previous, { recursive: true, force: true });
      let existing = false;
      try {
        await fs.access(destination);
        existing = true;
      } catch {
        existing = false;
      }
      if (existing) await fs.rename(destination, previous);
      try {
        await fs.cp(input.stagingDir, destination, { recursive: true });
      } catch (error) {
        if (existing) await fs.rename(previous, destination);
        return { ok: false, error: `Copy failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      await fs.rm(previous, { recursive: true, force: true });
    } catch (error) {
      return { ok: false, error: `Install failed: ${error instanceof Error ? error.message : String(error)}` };
    }

    this.approvals.approve({
      modId: review.manifest.id,
      currentHash: review.fingerprint,
      version: review.manifest.version,
      sourcePath: destination,
      declaredCapabilities: review.manifest.capabilities,
      ...(input.now !== undefined ? { now: input.now } : {}),
    });

    const state = this.store.load();
    state.installed[review.manifest.id] = {
      id: review.manifest.id,
      version: review.manifest.version,
      band: review.manifest.band,
      source: input.source,
      installedAt: input.now ?? Date.now(),
      fingerprint: review.fingerprint,
      ...(review.manifest.capabilities !== undefined
        ? { declaredCapabilities: review.manifest.capabilities }
        : {}),
    };
    this.store.save(state);
    log(`[Mods] Installed "${review.manifest.id}" v${review.manifest.version} from ${input.source}`);
    return { ok: true, modId: review.manifest.id };
  }

  /** Load every installed and enabled mod. Returns the ids that refused to load. */
  async loadInstalled(bus: ModEventBus): Promise<{ loaded: string[]; refused: { id: string; reason: string }[] }> {
    const state = this.store.load();
    const loader = new ModLoader({ ...this.loaderDeps, approvals: this.approvals, importModule: this.importModule });
    const loaded: string[] = [];
    const refused: { id: string; reason: string }[] = [];

    for (const modId of Object.keys(state.installed).sort()) {
      if (!this.isEnabled(modId)) {
        continue;
      }
      const dir = path.join(this.modsDir, modId);
      const outcome = await loader.load(dir, bus);
      if (outcome.status === 'loaded') {
        loaded.push(modId);
        continue;
      }
      const reason =
        outcome.status === 'needs-approval'
          ? outcome.reason
          : outcome.status === 'invalid-manifest'
            ? outcome.errors.map((entry) => `${entry.path}: ${entry.message}`).join('; ')
            : outcome.message;
      refused.push({ id: modId, reason });
      logWarn(`[Mods] "${modId}" did not load — ${reason}`);
    }
    return { loaded, refused };
  }

  /**
   * Is this mod enabled HERE?
   *
   * A project override wins over the global toggle, and an absent setting means
   * enabled. Mods are opt-out because the user approved each install explicitly;
   * being installed IS the opt-in.
   */
  isEnabled(modId: string, projectId?: string): boolean {
    const state = this.store.load();
    if (projectId) {
      const override = state.enable.byProject[projectId]?.[modId];
      if (typeof override === 'boolean') return override;
    }
    return state.enable.byMod[modId] !== false;
  }

  setEnabled(modId: string, enabled: boolean, projectId?: string): void {
    const state = this.store.load();
    if (projectId) {
      // An explicit `true` is stored, not treated as "inherit": the common case is
      // a mod switched off globally and deliberately re-enabled for one project,
      // and silently inheriting `false` there would ignore the user's action.
      const forProject = { ...(state.enable.byProject[projectId] ?? {}) };
      forProject[modId] = enabled;
      state.enable = { ...state.enable, byProject: { ...state.enable.byProject, [projectId]: forProject } };
    } else {
      if (enabled) delete state.enable.byMod[modId];
      else state.enable.byMod[modId] = false;
    }
    this.store.save(state);
    log(`[Mods] "${modId}" ${enabled ? 'enabled' : 'disabled'}${projectId ? ` for project ${projectId}` : ' globally'}`);
  }

  /** Drop a project override so the mod follows the global setting again. */
  clearProjectOverride(modId: string, projectId: string): void {
    const state = this.store.load();
    const forProject = { ...(state.enable.byProject[projectId] ?? {}) };
    if (!(modId in forProject)) return;
    delete forProject[modId];
    state.enable = { ...state.enable, byProject: { ...state.enable.byProject, [projectId]: forProject } };
    this.store.save(state);
  }

  /** Remove the plugin and its approval. The code is deleted, not disabled. */
  async uninstall(modId: string): Promise<boolean> {
    const state = this.store.load();
    if (!state.installed[modId]) return false;
    const dir = path.join(this.modsDir, modId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      logWarn(`[Mods] Could not delete ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    delete state.installed[modId];
    const byMod = { ...state.enable.byMod };
    delete byMod[modId];
    state.enable = { ...state.enable, byMod };
    this.store.save(state);
    this.approvals.revoke(modId);
    log(`[Mods] Uninstalled "${modId}"`);
    return true;
  }

  list(): InstalledMod[] {
    const state = this.store.load();
    return Object.values(state.installed).sort((a, b) => a.id.localeCompare(b.id));
  }
}