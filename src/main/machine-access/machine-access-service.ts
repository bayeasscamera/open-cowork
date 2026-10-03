/**
 * @module main/machine-access/machine-access-service
 *
 * The single service entry point that assembles machine access for a session:
 * grants + autonomy + journal + fs tools + approval flow. Everything the UI
 * and the agent need goes through here, so there is exactly one place where a
 * grant is checked, a risk is assessed and an approval is demanded.
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import { shell } from 'electron';
import type { ToolRegistry } from '../tools/registry';
import { registerMachineAccessTools, type FsToolsDeps } from './fs-tools';
import { GrantStore, requestAccess, type AccessRequest, type GrantDb } from './grant-store';
import { FsJournal, purgeBackups, type FsOperation } from './fs-journal';
import { buildBatchPlan, executeBatchPlan, type BatchOpInput, type BatchPlan } from './batch-plan';
import { previewRename, executeRename, type RenamePreview } from './project-rename';
import { assessRisk, requiresApproval } from './risk-assessor';
import type { RiskAssessment } from './types';
import { createBinding, isBindingValid } from './approval-binding';
import {
  getEmergencyStop,
  AllowedApps,
  probePermissionStates,
  type PermissionState,
} from './machine-control';
import type { ApprovalBinding, AutonomyLevel, FolderGrant } from './types';

/** The OS probe is slow; never re-run it more often than this. */
export const PERMISSION_CACHE_MS = 60_000;

export interface MachineAccessDeps {
  workspaceRoot: string;
  projectId: string;
  /** Cowork data dir: backups, quota, purge. */
  appDataPath: string;
  registry: ToolRegistry;
  db?: GrantDb | null;
  trashItem?: (filePath: string) => Promise<void>;
  batchMaxOps?: number;
  backupQuotaBytes?: number;
}

export interface PendingApproval {
  id: string;
  binding: ApprovalBinding;
  risk: RiskAssessment;
  what: string;
  origin: string;
  sensitivity: boolean;
}

export class MachineAccessService {
  readonly grants: GrantStore;
  readonly journal: FsJournal;
  readonly apps = new AllowedApps();
  private pending = new Map<string, PendingApproval>();
  private cachedPermissions: { at: number; states: Array<PermissionState & { known: boolean }> } | null =
    null;
  private readonly deps: MachineAccessDeps;

  constructor(deps: MachineAccessDeps) {
    this.deps = deps;
    this.grants = new GrantStore(deps.db ?? null);
    this.journal = new FsJournal(deps.db ?? null);
  }

  /** Identity of this service, so the runtime never hands out a stale one. */
  get projectId(): string {
    return this.deps.projectId;
  }

  get workspaceRoot(): string {
    return this.deps.workspaceRoot;
  }

  get backupRoot(): string {
    return path.join(this.deps.appDataPath, 'cowork-trash');
  }

  get autonomy(): AutonomyLevel {
    return this.grants.getAutonomy(this.deps.projectId);
  }

  /** Register fs tools on the shared registry (idempotent). */
  registerTools(): string[] {
    const deps: FsToolsDeps = {
      workspaceRoot: this.deps.workspaceRoot,
      grants: this.grants,
      journal: this.journal,
      backupRoot: this.backupRoot,
      trashItem: this.deps.trashItem ?? defaultTrash,
    };
    return registerMachineAccessTools(this.deps.registry, deps);
  }

  // ---- Grants: user-only creation, agent can only request ----

  /** UI-only. `fromUser` is set by the native picker / confirm button. */
  addGrantFromUser(input: { path: string; access: 'read' | 'read-write'; scope: 'session' | 'project' | 'permanent'; expiresAt?: number }): FolderGrant {
    return this.grants.addGrant(input, 'user');
  }

  revokeGrant(id: string): boolean {
    return this.grants.revokeGrant(id);
  }

  listGrants(): FolderGrant[] {
    return this.grants.list();
  }

  /** The agent's only path: a request the UI shows. Never a grant. */
  requestFolderAccess(wantedPath: string, reason: string): AccessRequest {
    return requestAccess(wantedPath, reason);
  }

  setAutonomy(level: AutonomyLevel): void {
    this.grants.setAutonomy(this.deps.projectId, level);
  }

  // ---- Approval flow ----

  /**
   * Ask for approval. Returns a card id; the user answers from the renderer.
   * The agent cannot answer on the user's behalf — nothing here reads a
   * decision except `resolveApproval`, which requires the renderer callback.
   */
  requestApproval(input: {
    kind: Parameters<typeof assessRisk>[0]['kind'];
    what: string;
    origin: string;
    risk: RiskAssessment;
    sensitive?: boolean;
  }): PendingApproval {
    const id = randomUUID();
    const pending: PendingApproval = {
      id,
      binding: createBinding({ kind: input.kind, command: input.what }),
      risk: input.risk,
      what: input.what,
      origin: input.origin,
      sensitivity: input.sensitive ?? false,
    };
    this.pending.set(id, pending);
    return pending;
  }

  /** True when this action needs a card, in any autonomy level. */
  needsApproval(risk: RiskAssessment, sensitive: boolean): boolean {
    return requiresApproval(risk, this.autonomy, sensitive);
  }

  /**
   * Apply a user decision. The decision arrives from the renderer with the
   * card id and the action fingerprint; a mismatch re-asks.
   */
  resolveApproval(
    cardId: string,
    approved: boolean,
    action: Parameters<typeof createBinding>[0],
    now = Date.now()
  ): { allowed: boolean; reason?: string } {
    const pending = this.pending.get(cardId);
    if (!pending) return { allowed: false, reason: 'Unknown or already-resolved approval card.' };
    this.pending.delete(cardId);
    if (!approved) return { allowed: false, reason: 'Refused by the user.' };
    if (!isBindingValid(pending.binding, action, now)) {
      return { allowed: false, reason: 'The action changed since the card was shown; ask again.' };
    }
    return { allowed: true };
  }

  // ---- Batches ----

  planBatch(ops: BatchOpInput[], allowGitRoots = false): BatchPlan {
    return buildBatchPlan(ops, {
      workspaceRoot: this.deps.workspaceRoot,
      grants: this.grants.list(),
      ...(this.deps.batchMaxOps !== undefined ? { maxOps: this.deps.batchMaxOps } : {}),
      allowGitRoots,
    });
  }

  async runBatch(plan: BatchPlan, allowGitRoots = true): ReturnType<typeof executeBatchPlan> {
    const result = await executeBatchPlan(
      plan,
      {
        workspaceRoot: this.deps.workspaceRoot,
        grants: this.grants.list(),
        ...(this.deps.batchMaxOps !== undefined ? { maxOps: this.deps.batchMaxOps } : {}),
        allowGitRoots,
      },
      { journal: this.journal, backupRoot: this.backupRoot, trashItem: this.deps.trashItem ?? defaultTrash }
    );
    this.purge();
    return result;
  }

  // ---- Journal / trash ----

  history(batchId?: string): FsOperation[] {
    return this.journal.history(batchId);
  }

  undoBatch(batchId: string): ReturnType<FsJournal['undoBatch']> {
    return this.journal.undoBatch(batchId);
  }

  /** Enforce the backup quota. Returns the purged refs. */
  purge(): string[] {
    return purgeBackups(this.backupRoot, this.deps.backupQuotaBytes ?? 512 * 1024 * 1024);
  }

  // ---- Project rename ----

  previewProjectRename(
    projectId: string,
    newName: string,
    renameDir: boolean,
    newDirName?: string
  ): RenamePreview {
    if (!this.renamePreview) throw new Error('Project rename is not wired in this process.');
    return this.renamePreview(projectId, newName, renameDir, newDirName);
  }

  /** Set by the app so the service does not depend on the project store. */
  renamePreview?: (
    projectId: string,
    newName: string,
    renameDir: boolean,
    newDirName?: string
  ) => RenamePreview;

  renameExecutor?: Parameters<typeof executeRename>[0];
  runProjectRename(preview: RenamePreview): { workdir?: string } {
    if (!this.renameExecutor) throw new Error('Project rename is not wired in this process.');
    return executeRename(this.renameExecutor, preview);
  }

  // ---- Machine control ----

  /**
   * Real permission state. `granted` is only ever true when the OS probe says
   * so; an unprobeable permission (Automation) comes back `known: false` rather
   * than being optimistically reported as granted.
   *
   * The probe shells out to system_profiler / screencapture, which can take
   * seconds, so the result is cached: the settings page must never block on it.
   */
  async permissions(): Promise<Array<PermissionState & { known: boolean }>> {
    const now = Date.now();
    if (this.cachedPermissions && now - this.cachedPermissions.at < PERMISSION_CACHE_MS) {
      return this.cachedPermissions.states;
    }
    const states = await probePermissionStates();
    this.cachedPermissions = { at: now, states };
    return states;
  }

  /** Drop the cached probe (e.g. after the user changed System Settings). */
  invalidatePermissionCache(): void {
    this.cachedPermissions = null;
  }

  emergencyStop(): { controllers: number; processes: number } {
    return getEmergencyStop().stop();
  }
}

/** Electron system trash; falls back to a Cowork-side move when unavailable. */
async function defaultTrash(filePath: string): Promise<void> {
  try {
    await shell.trashItem(filePath);
  } catch {
    throw new Error('System trash is unavailable; use fs_organize with an explicit backup instead.');
  }
}

export { previewRename };