/**
 * @module main/agent/activity-tracker
 *
 * Cowork 4.0 — Phase 6.3: the tool-activity feed of the control center. A
 * bounded, deterministic ring buffer so the renderer can show what the agent is
 * doing right now and how long each step took.
 */

import type {
  ActivityEvent,
  ActivityEventInput,
  ActivityStatus,
} from '../../shared/control-center-types';
import { ACTIVITY_STATUSES } from '../../shared/control-center-types';

export const DEFAULT_ACTIVITY_LIMIT = 500;

export interface ActivityTrackerOptions {
  now?: () => number;
  idFactory?: () => string;
  /** Maximum number of events kept in memory. */
  limit?: number;
}

export interface FinishActivityInput {
  status: ActivityStatus;
  error?: string;
  detail?: string;
}

function defaultId(): string {
  return 'act-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class ActivityTracker {
  private readonly events = new Map<string, ActivityEvent>();
  private order: string[] = [];
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly limit: number;

  constructor(options: ActivityTrackerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultId;
    this.limit = Math.max(1, options.limit ?? DEFAULT_ACTIVITY_LIMIT);
  }

  /** Record the start of a tool call and return the created event. */
  public begin(input: ActivityEventInput): ActivityEvent {
    const event: ActivityEvent = {
      id: this.idFactory(),
      sessionId: input.sessionId,
      tool: input.tool,
      label: input.label,
      status: 'running',
      startedAt: this.now(),
    };
    if (input.taskId) {
      event.taskId = input.taskId;
    }
    if (input.detail) {
      event.detail = input.detail;
    }
    this.events.set(event.id, event);
    this.order.push(event.id);
    this.evict();
    return { ...event };
  }

  /** Close a running event; unknown ids are ignored. */
  public finish(id: string, outcome: FinishActivityInput): ActivityEvent | null {
    const event = this.events.get(id);
    if (!event) {
      return null;
    }
    const finishedAt = this.now();
    const next: ActivityEvent = {
      ...event,
      status: outcome.status,
      finishedAt,
      durationMs: Math.max(0, finishedAt - event.startedAt),
    };
    if (outcome.error) {
      next.error = outcome.error;
    }
    if (outcome.detail) {
      next.detail = outcome.detail;
    }
    this.events.set(id, next);
    return { ...next };
  }

  public cancel(id: string, reason?: string): ActivityEvent | null {
    return this.finish(id, reason ? { status: 'cancelled', error: reason } : { status: 'cancelled' });
  }

  public get(id: string): ActivityEvent | null {
    const event = this.events.get(id);
    return event ? { ...event } : null;
  }

  /** Newest first. */
  public list(limit?: number): ActivityEvent[] {
    return this.collect(this.order, limit);
  }

  public forSession(sessionId: string, limit?: number): ActivityEvent[] {
    const ids = this.order.filter((id) => this.events.get(id)?.sessionId === sessionId);
    return this.collect(ids, limit);
  }

  public forTask(taskId: string): ActivityEvent[] {
    const ids = this.order.filter((id) => this.events.get(id)?.taskId === taskId);
    return this.collect(ids, limitOrDefault());
  }

  public running(): ActivityEvent[] {
    const ids = this.order.filter((id) => this.events.get(id)?.status === 'running');
    return this.collect(ids, limitOrDefault());
  }

  public summary(): Record<ActivityStatus, number> {
    const counts = ACTIVITY_STATUSES.reduce(
      (accumulator, status) => {
        accumulator[status] = 0;
        return accumulator;
      },
      {} as Record<ActivityStatus, number>
    );
    for (const event of this.events.values()) {
      counts[event.status] += 1;
    }
    return counts;
  }

  /** Remove every event, or only one session's events. Returns the count. */
  public clear(sessionId?: string): number {
    if (!sessionId) {
      const removed = this.events.size;
      this.events.clear();
      this.order = [];
      return removed;
    }
    const kept: string[] = [];
    let removed = 0;
    for (const id of this.order) {
      if (this.events.get(id)?.sessionId === sessionId) {
        this.events.delete(id);
        removed += 1;
      } else {
        kept.push(id);
      }
    }
    this.order = kept;
    return removed;
  }

  public size(): number {
    return this.events.size;
  }

  private collect(ids: string[], limit?: number): ActivityEvent[] {
    const resolved = limit === undefined ? ids.length : Math.max(0, limit);
    const result: ActivityEvent[] = [];
    for (let index = ids.length - 1; index >= 0 && result.length < resolved; index -= 1) {
      const event = this.events.get(ids[index]);
      if (event) {
        result.push({ ...event });
      }
    }
    return result;
  }

  private evict(): void {
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest) {
        this.events.delete(oldest);
      }
    }
  }
}

function limitOrDefault(): number {
  return Number.MAX_SAFE_INTEGER;
}
