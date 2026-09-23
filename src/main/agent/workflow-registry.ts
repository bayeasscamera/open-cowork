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
import { IsolationManager } from './isolation-manager';
import { createDefaultPermissionPolicy, type PermissionPolicy } from './permission-policy';
import {
  WorkflowExecutor,
  type WorkflowExecutorOptions,
  type WorkflowTaskRunner,
} from './workflow-executor';
import { ProjectMemoryStore, workspaceKeyFor } from '../memory/project-memory-store';
import type { TaskQueue } from './task-queue';
import { WorkflowOrchestrator, type WorkflowState } from './workflow-orchestrator';
import {
  WORKFLOW_SNAPSHOT_VERSION,
  WorkflowPersistence,
  type WorkflowSessionSnapshot,
} from './workflow-persistence';

export interface WorkflowEntry {
  sessionId: string;
  workspaceRoot: string;
  policy: PermissionPolicy;
  audit: AuditLog;
  checkpoints: CheckpointManager;
  isolation: IsolationManager;
  /** Rebuilt during restore so a snapshot is rehydrated, not merged. */
  memory: ProjectMemoryStore;
  orchestrator: WorkflowOrchestrator;
}

export interface WorkflowRegistryOptions {
  /** Resolve the workspace root for a session; null when unknown. */
  resolveWorkspaceRoot: (sessionId: string) => string | null;
  /** Last-resort workspace when the session has none. */
  fallbackWorkspaceRoot?: () => string | null;
  now?: () => number;
  onStateChange?: (sessionId: string, state: WorkflowState) => void;
  /** Durable state (Phase 1.6). Omitted in unit tests. */
  persistence?: WorkflowPersistence;
  /** The detached-task queue, persisted alongside the workflow. */
  queueProvider?: () => TaskQueue | null;
  /** Coalescing window for state-change writes. */
  persistDebounceMs?: number;
  /** Observability hook for tests and diagnostics. */
  onRestore?: (
    sessionId: string,
    detail: { restored: boolean; memories: number; tasks: number }
  ) => void;
}

export const DEFAULT_PERSIST_DEBOUNCE_MS = 250;

export class WorkflowRegistry {
  private readonly entries = new Map<string, WorkflowEntry>();
  private readonly workspaceKeys = new Map<string, string>();
  private readonly options: WorkflowRegistryOptions;
  private readonly pendingSaves = new Map<string, NodeJS.Timeout>();

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
      // Sessions can change workspace (workdir.set); keep the key in sync.
      this.workspaceKeys.set(sessionId, workspaceKeyFor(existing.workspaceRoot));
      return existing;
    }

    const workspaceRoot =
      this.options.resolveWorkspaceRoot(sessionId) ?? this.options.fallbackWorkspaceRoot?.() ?? null;
    if (!workspaceRoot) {
      return null;
    }

    const audit = new AuditLog(this.options.now);
    const git = createGitRunner(workspaceRoot);
    const checkpoints = new CheckpointManager({
      backend: createFsSnapshotBackend(workspaceRoot),
      git,
      audit,
      now: this.options.now,
    });
    const isolation = new IsolationManager({
      git,
      gitFactory: (cwd: string) => createGitRunner(cwd),
      audit,
    });
    const policy = createDefaultPermissionPolicy(workspaceRoot);
    const orchestrator = new WorkflowOrchestrator({
      policy,
      checkpoints,
      audit,
      now: this.options.now,
      onStateChange: (state) => {
        this.persistSoon(sessionId);
        this.options.onStateChange?.(sessionId, state);
      },
    });

    const entry: WorkflowEntry = {
      sessionId,
      workspaceRoot,
      policy,
      audit,
      checkpoints,
      isolation,
      memory: new ProjectMemoryStore({ now: this.options.now }),
      orchestrator,
    };
    this.workspaceKeys.set(sessionId, workspaceKeyFor(workspaceRoot));
    this.entries.set(sessionId, entry);
    this.restoreSession(sessionId);
    return entry;
  }

  /**
   * Restore the persisted workflow state, checkpoints and project memory for a
   * session. Only applied when the workspace still matches, so a plan can never
   * be replayed against a different directory.
   */
  public restoreSession(sessionId: string): boolean {
    const persistence = this.options.persistence;
    const entry = this.entries.get(sessionId);
    if (!persistence || !entry) {
      return false;
    }
    const snapshot = persistence.loadSession(sessionId);
    if (!snapshot) {
      return false;
    }
    if (workspaceKeyFor(snapshot.workspaceRoot) !== workspaceKeyFor(entry.workspaceRoot)) {
      return false;
    }
    entry.checkpoints.restore(snapshot.checkpoints);
    // The store is rehydrated from the snapshot before anything else, because
    // the two live stores (checkpoints, memory) are only re-created when the
    // entry itself is rebuilt.
    entry.memory = new ProjectMemoryStore({ now: this.options.now });
    const memories = entry.memory.restore(snapshot.memory);
    const restored = entry.orchestrator.restore(snapshot.workflow);
    // Only clear the coalescing timer once the state it would have written is
    // actually on disk; otherwise a pending write is silently dropped.
    if (restored) {
      const pending = this.pendingSaves.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        this.pendingSaves.delete(sessionId);
      }
    }
    this.options.onRestore?.(sessionId, {
      restored,
      memories,
      tasks: entry.orchestrator.getTasks().length,
    });
    return restored;
  }

  /**
   * Build an executor for a session. The LLM runner is injected so this module
   * stays free of the agent session stack; tests inject a fake runner too.
   */
  public executorFor(
    sessionId: string,
    runTask: WorkflowTaskRunner,
    overrides: Partial<WorkflowExecutorOptions> = {}
  ): WorkflowExecutor | null {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return null;
    }
    return new WorkflowExecutor({
      ...overrides,
      orchestrator: entry.orchestrator,
      runTask,
      policy: entry.policy,
      workspaceRoot: entry.workspaceRoot,
      isolation: entry.isolation,
      audit: entry.audit,
      now: this.options.now,
    });
  }

  /** Build the persisted snapshot for one session. */
  public snapshotFor(sessionId: string): WorkflowSessionSnapshot | null {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return null;
    }
    return {
      version: WORKFLOW_SNAPSHOT_VERSION,
      sessionId,
      workspaceRoot: entry.workspaceRoot,
      savedAt: this.now(),
      workflow: entry.orchestrator.serialize(),
      checkpoints: entry.checkpoints.serialize(),
      memory: entry.memory.serialize(),
    };
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /** Write the session snapshot now. Never rejects. */
  public async persist(sessionId: string): Promise<boolean> {
    const persistence = this.options.persistence;
    const snapshot = this.snapshotFor(sessionId);
    if (!persistence || !snapshot) {
      return false;
    }
    await persistence.saveSession(snapshot);
    return true;
  }

  /** Coalesce state-change writes so a busy plan does not thrash the disk. */
  public persistSoon(sessionId: string): void {
    if (!this.options.persistence || this.pendingSaves.has(sessionId)) {
      return;
    }
    const delay = this.options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
    const timer = setTimeout(() => {
      this.pendingSaves.delete(sessionId);
      void this.persist(sessionId);
    }, delay);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pendingSaves.set(sessionId, timer);
  }

  /** Persist every session and the detached-task queue (shutdown path). */
  public async persistAll(): Promise<void> {
    const persistence = this.options.persistence;
    if (!persistence) {
      return;
    }
    for (const sessionId of Array.from(this.pendingSaves.keys())) {
      const timer = this.pendingSaves.get(sessionId);
      if (timer) {
        clearTimeout(timer);
      }
      this.pendingSaves.delete(sessionId);
    }
    for (const sessionId of this.entries.keys()) {
      await this.persist(sessionId);
    }
    const queue = this.options.queueProvider?.();
    if (queue) {
      await persistence.saveQueue(queue.serialize());
    }
  }

  /** Workspace key (normalized root) for a session that already has an entry. */
  public workspaceKey(sessionId: string): string | null {
    return this.workspaceKeys.get(sessionId) ?? null;
  }

  public remove(sessionId: string): void {
    const timer = this.pendingSaves.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingSaves.delete(sessionId);
    }
    this.entries.delete(sessionId);
    this.workspaceKeys.delete(sessionId);
    void this.options.persistence?.removeSession(sessionId);
  }

  public clear(): void {
    this.entries.clear();
    this.workspaceKeys.clear();
  }

  public sessionIds(): string[] {
    return Array.from(this.entries.keys());
  }
}
