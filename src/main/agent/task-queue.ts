/**
 * @module main/agent/task-queue
 *
 * Cowork 4.0 — Phase 6: detached tasks and their queue. Tasks survive a restart
 * because `serialize`/`restore` round-trips them and a task that was running
 * when the app died comes back as `queued`.
 */

import type {
  DetachedTask,
  DetachedTaskInput,
  DetachedTaskStatus,
} from '../../shared/control-center-types';

export const DEFAULT_QUEUE_LIMIT = 200;

export interface TaskQueueOptions {
  now?: () => number;
  idFactory?: () => string;
  limit?: number;
}

function defaultId(): string {
  return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class TaskQueue {
  private readonly tasks = new Map<string, DetachedTask>();
  private order: string[] = [];
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly limit: number;

  constructor(options: TaskQueueOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultId;
    this.limit = Math.max(1, options.limit ?? DEFAULT_QUEUE_LIMIT);
  }

  public enqueue(input: DetachedTaskInput): DetachedTask {
    const task: DetachedTask = {
      id: this.idFactory(),
      sessionId: input.sessionId,
      kind: input.kind,
      label: input.label,
      status: 'queued',
      createdAt: this.now(),
    };
    if (input.resumeToken) {
      task.resumeToken = input.resumeToken;
    }
    this.tasks.set(task.id, task);
    this.order.push(task.id);
    this.evict();
    return { ...task };
  }

  public start(id: string): DetachedTask | null {
    return this.transition(id, 'running', (task) => {
      task.startedAt = this.now();
    });
  }

  public complete(id: string): DetachedTask | null {
    return this.transition(id, 'completed', (task) => {
      task.progress = 1;
    });
  }

  public fail(id: string, error?: string): DetachedTask | null {
    return this.transition(id, 'failed', (task) => {
      if (error) {
        task.error = error;
      }
    });
  }

  public cancel(id: string, reason?: string): DetachedTask | null {
    return this.transition(id, 'cancelled', (task) => {
      if (reason) {
        task.error = reason;
      }
    });
  }

  /** Record completion ratio; values outside [0, 1] are clamped. */
  public setProgress(id: string, progress: number): DetachedTask | null {
    const task = this.tasks.get(id);
    if (!task) {
      return null;
    }
    const next: DetachedTask = {
      ...task,
      progress: Math.min(1, Math.max(0, progress)),
    };
    this.tasks.set(id, next);
    return { ...next };
  }

  public get(id: string): DetachedTask | null {
    const task = this.tasks.get(id);
    return task ? { ...task } : null;
  }

  /** Newest first, optionally restricted to a session. */
  public list(sessionId?: string): DetachedTask[] {
    const result: DetachedTask[] = [];
    for (let index = this.order.length - 1; index >= 0; index -= 1) {
      const task = this.tasks.get(this.order[index]);
      if (!task) {
        continue;
      }
      if (sessionId && task.sessionId !== sessionId) {
        continue;
      }
      result.push({ ...task });
    }
    return result;
  }

  /** Tasks that are queued or running. */
  public pending(sessionId?: string): DetachedTask[] {
    return this.list(sessionId).filter(
      (task) => task.status === 'queued' || task.status === 'running'
    );
  }

  public stats(): Record<DetachedTaskStatus, number> {
    const counts: Record<DetachedTaskStatus, number> = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of this.tasks.values()) {
      counts[task.status] += 1;
    }
    return counts;
  }

  /** Snapshot for persistence. */
  public serialize(): DetachedTask[] {
    return Array.from(this.tasks.values()).map((task) => ({ ...task }));
  }

  /**
   * Restore a previous snapshot. A task that was running when the process
   * stopped is demoted to queued so it can be resumed explicitly.
   */
  public restore(entries: DetachedTask[]): number {
    let restored = 0;
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.sessionId !== 'string') {
        continue;
      }
      const status: DetachedTaskStatus = entry.status === 'running' ? 'queued' : entry.status;
      const task: DetachedTask = { ...entry, status };
      if (status === 'queued') {
        delete task.startedAt;
        delete task.finishedAt;
      }
      this.tasks.set(task.id, task);
      this.order.push(task.id);
      restored += 1;
    }
    this.evict();
    return restored;
  }

  public clear(sessionId?: string): number {
    if (!sessionId) {
      const removed = this.tasks.size;
      this.tasks.clear();
      this.order = [];
      return removed;
    }
    const kept: string[] = [];
    let removed = 0;
    for (const id of this.order) {
      if (this.tasks.get(id)?.sessionId === sessionId) {
        this.tasks.delete(id);
        removed += 1;
      } else {
        kept.push(id);
      }
    }
    this.order = kept;
    return removed;
  }

  public size(): number {
    return this.tasks.size;
  }

  private transition(
    id: string,
    status: DetachedTaskStatus,
    mutate: (task: DetachedTask) => void
  ): DetachedTask | null {
    const task = this.tasks.get(id);
    if (!task) {
      return null;
    }
    const next: DetachedTask = { ...task, status };
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      next.finishedAt = this.now();
    }
    mutate(next);
    this.tasks.set(id, next);
    return { ...next };
  }

  private evict(): void {
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest) {
        this.tasks.delete(oldest);
      }
    }
  }
}
