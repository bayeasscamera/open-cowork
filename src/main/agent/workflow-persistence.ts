/**
 * @module main/agent/workflow-persistence
 *
 * Cowork 4.0 — Phase 1.6/2.5/4.4/6.3: durable state.
 *
 * Two kinds of file are written under the app data directory:
 *   - one JSON file per session with the workflow state machine, the
 *     checkpoints (including the file contents needed to roll back) and the
 *     project memory;
 *   - one global queue file with the detached tasks, so a task that was running
 *     when the app stopped comes back as queued.
 *
 * Every read is defensive: a corrupt or version-mismatched file is ignored and
 * the app starts clean rather than crashing.
 */

import { app } from 'electron';
import { promises as fsPromises, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { DetachedTask } from '../../shared/control-center-types';
import type { ProjectMemoryItem } from '../../shared/project-memory-types';
import { logWarn } from '../utils/logger';
import type { CheckpointManagerSnapshot } from './checkpoint-manager';
import type { WorkflowOrchestratorSnapshot } from './workflow-orchestrator';

export const WORKFLOW_SNAPSHOT_VERSION = 1;
export const QUEUE_SNAPSHOT_VERSION = 1;

export interface WorkflowSessionSnapshot {
  version: number;
  sessionId: string;
  workspaceRoot: string;
  savedAt: number;
  workflow: WorkflowOrchestratorSnapshot;
  checkpoints: CheckpointManagerSnapshot;
  memory: ProjectMemoryItem[];
}

export interface QueueSnapshot {
  version: number;
  savedAt: number;
  tasks: DetachedTask[];
}

export interface WorkflowPersistenceOptions {
  baseDir?: string;
  now?: () => number;
}

/** Turn an arbitrary session id into a safe, bounded file name. */
export function safeFileName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'session';
}

function defaultBaseDir(): string {
  try {
    const userData = app?.getPath?.('userData');
    if (userData) {
      return path.join(userData, 'workflow-state');
    }
  } catch {
    // Not running inside Electron (tests, headless): fall through.
  }
  return path.join(process.cwd(), '.cowork-workflow-state');
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class WorkflowPersistence {
  private readonly baseDir: string;
  private readonly now: () => number;
  /** Tail of the write chain per target, so writes land in initiation order. */
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options: WorkflowPersistenceOptions = {}) {
    this.baseDir = options.baseDir ?? defaultBaseDir();
    this.now = options.now ?? (() => Date.now());
  }

  public get directory(): string {
    return this.baseDir;
  }

  public sessionPath(sessionId: string): string {
    return path.join(this.baseDir, 'sessions', safeFileName(sessionId) + '.json');
  }

  public queuePath(): string {
    return path.join(this.baseDir, 'queue.json');
  }

  /**
   * Serialise writes per file and publish them with a rename, so a reader never
   * sees a truncated snapshot and a debounced save that started earlier can
   * never land after — and clobber — a newer explicit snapshot.
   */
  private writeJson(target: string, value: unknown): Promise<void> {
    let payload: string;
    try {
      payload = JSON.stringify(value);
    } catch (error: unknown) {
      logWarn('[workflow-persistence] failed to serialise ' + target, error);
      return Promise.resolve();
    }
    const previous = this.writes.get(target) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.renameIntoPlace(target, payload));
    this.writes.set(target, next);
    return next;
  }

  private async renameIntoPlace(target: string, payload: string): Promise<void> {
    const temp =
      target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
    try {
      await fsPromises.mkdir(path.dirname(target), { recursive: true });
      await fsPromises.writeFile(temp, payload, 'utf8');
      await fsPromises.rename(temp, target);
    } catch (error: unknown) {
      logWarn('[workflow-persistence] failed to write ' + target, error);
      await fsPromises.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private readJson(target: string): unknown {
    try {
      return parseJson(readFileSync(target, 'utf8'));
    } catch {
      return null;
    }
  }

  public saveSession(snapshot: WorkflowSessionSnapshot): Promise<void> {
    return this.writeJson(this.sessionPath(snapshot.sessionId), {
      ...snapshot,
      version: WORKFLOW_SNAPSHOT_VERSION,
      savedAt: this.now(),
    });
  }

  public loadSession(sessionId: string): WorkflowSessionSnapshot | null {
    const raw = this.readJson(this.sessionPath(sessionId)) as Partial<WorkflowSessionSnapshot> | null;
    if (!raw || raw.version !== WORKFLOW_SNAPSHOT_VERSION) {
      return null;
    }
    if (typeof raw.sessionId !== 'string' || typeof raw.workspaceRoot !== 'string') {
      return null;
    }
    if (!raw.workflow || !raw.checkpoints) {
      return null;
    }
    return {
      version: WORKFLOW_SNAPSHOT_VERSION,
      sessionId: raw.sessionId,
      workspaceRoot: raw.workspaceRoot,
      savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
      workflow: raw.workflow,
      checkpoints: raw.checkpoints,
      memory: Array.isArray(raw.memory) ? raw.memory : [],
    };
  }

  public removeSession(sessionId: string): Promise<void> {
    const target = this.sessionPath(sessionId);
    // Chain the removal after any write already queued for this file, so a
    // late-landing snapshot cannot resurrect a dropped session.
    const previous = this.writes.get(target) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => fsPromises.rm(target, { force: true }).catch(() => undefined));
    this.writes.set(target, next);
    return next;
  }

  public saveQueue(tasks: DetachedTask[]): Promise<void> {
    const snapshot: QueueSnapshot = {
      version: QUEUE_SNAPSHOT_VERSION,
      savedAt: this.now(),
      tasks,
    };
    return this.writeJson(this.queuePath(), snapshot);
  }

  public loadQueue(): DetachedTask[] {
    const raw = this.readJson(this.queuePath()) as Partial<QueueSnapshot> | null;
    if (!raw || raw.version !== QUEUE_SNAPSHOT_VERSION || !Array.isArray(raw.tasks)) {
      return [];
    }
    return raw.tasks;
  }

  public metricsPath(): string {
    return path.join(this.baseDir, 'metrics.json');
  }

  /** Persist the reference-scenario history so versions stay comparable. */
  public saveMetrics(entries: readonly unknown[]): Promise<void> {
    return this.writeJson(this.metricsPath(), {
      version: WORKFLOW_SNAPSHOT_VERSION,
      savedAt: this.now(),
      entries,
    });
  }

  public loadMetrics(): unknown[] {
    const raw = this.readJson(this.metricsPath()) as { entries?: unknown } | null;
    return raw && Array.isArray(raw.entries) ? raw.entries : [];
  }

  public routingPath(): string {
    return path.join(this.baseDir, 'routing.json');
  }

  /** Persist the routing snapshot (opt-in state + local benchmark evidence). */
  public saveRouting(snapshot: unknown): Promise<void> {
    return this.writeJson(this.routingPath(), {
      version: WORKFLOW_SNAPSHOT_VERSION,
      savedAt: this.now(),
      routing: snapshot,
    });
  }

  /** Read back the routing snapshot; null when absent. */
  public loadRouting(): unknown {
    const raw = this.readJson(this.routingPath()) as { routing?: unknown } | null;
    return raw ? (raw.routing ?? null) : null;
  }
}
