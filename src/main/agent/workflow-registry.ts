/**
 * @module main/agent/workflow-registry
 *
 * Cowork 4.0 — owns one `WorkflowOrchestrator` per session, with its own
 * checkpoint store and audit log rooted at the session workspace. The IPC layer
 * stays thin because all lifecycle state lives here.
 */

import { AuditLog } from './audit-log';
import { createFsSnapshotBackend, createGitRunner } from './checkpoint-backends';
import { CheckpointManager } from './checkpoint-manager';
import { createDefaultPermissionPolicy } from './permission-policy';
import { WorkflowOrchestrator, type WorkflowState } from './workflow-orchestrator';

export interface WorkflowEntry {
  sessionId: string;
  workspaceRoot: string;
  audit: AuditLog;
  checkpoints: CheckpointManager;
  orchestrator: WorkflowOrchestrator;
}

export interface WorkflowRegistryOptions {
  /** Resolve the workspace root for a session; null when unknown. */
  resolveWorkspaceRoot: (sessionId: string) => string | null;
  /** Last-resort workspace when the session has none. */
  fallbackWorkspaceRoot?: () => string | null;
  now?: () => number;
  onStateChange?: (sessionId: string, state: WorkflowState) => void;
}

export class WorkflowRegistry {
  private readonly entries = new Map<string, WorkflowEntry>();
  private readonly options: WorkflowRegistryOptions;

  constructor(options: WorkflowRegistryOptions) {
    this.options = options;
  }

  /** Existing entry, without creating one. */
  public get(sessionId: string): WorkflowEntry | null {
    return this.entries.get(sessionId) ?? null;
  }

  /** Existing entry, or a freshly built one when a workspace is resolvable. */
  public getOrCreate(sessionId: string): WorkflowEntry | null {
    const existing = this.entries.get(sessionId);
    if (existing) {
      return existing;
    }

    const workspaceRoot =
      this.options.resolveWorkspaceRoot(sessionId) ?? this.options.fallbackWorkspaceRoot?.() ?? null;
    if (!workspaceRoot) {
      return null;
    }

    const audit = new AuditLog(this.options.now);
    const checkpoints = new CheckpointManager({
      backend: createFsSnapshotBackend(workspaceRoot),
      git: createGitRunner(workspaceRoot),
      audit,
      now: this.options.now,
    });
    const orchestrator = new WorkflowOrchestrator({
      policy: createDefaultPermissionPolicy(workspaceRoot),
      checkpoints,
      audit,
      now: this.options.now,
      onStateChange: this.options.onStateChange
        ? (state) => this.options.onStateChange?.(sessionId, state)
        : undefined,
    });

    const entry: WorkflowEntry = { sessionId, workspaceRoot, audit, checkpoints, orchestrator };
    this.entries.set(sessionId, entry);
    return entry;
  }

  public remove(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  public clear(): void {
    this.entries.clear();
  }

  public sessionIds(): string[] {
    return Array.from(this.entries.keys());
  }
}
