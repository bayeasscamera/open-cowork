/**
 * @module main/agent/notification-center
 *
 * Cowork 4.0 — Phase 6: approval, blocker and completion notifications. They are
 * what the control center surfaces when the agent needs a human, including after
 * a restart.
 */

import type {
  ApprovalNotification,
  NotificationInput,
  NotificationKind,
} from '../../shared/control-center-types';
import { NOTIFICATION_KINDS } from '../../shared/control-center-types';

export const DEFAULT_NOTIFICATION_LIMIT = 200;

export interface NotificationCenterOptions {
  now?: () => number;
  idFactory?: () => string;
  limit?: number;
}

function defaultId(): string {
  return 'notif-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export class NotificationCenter {
  private readonly items = new Map<string, ApprovalNotification>();
  private order: string[] = [];
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly limit: number;

  constructor(options: NotificationCenterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultId;
    this.limit = Math.max(1, options.limit ?? DEFAULT_NOTIFICATION_LIMIT);
  }

  public notify(input: NotificationInput): ApprovalNotification {
    const notification: ApprovalNotification = {
      id: this.idFactory(),
      sessionId: input.sessionId,
      kind: input.kind,
      title: input.title,
      createdAt: this.now(),
      acknowledged: false,
    };
    if (input.detail) {
      notification.detail = input.detail;
    }
    if (input.taskId) {
      notification.taskId = input.taskId;
    }
    this.items.set(notification.id, notification);
    this.order.push(notification.id);
    this.evict();
    return { ...notification };
  }

  /** Newest first. */
  public list(sessionId?: string, limit?: number): ApprovalNotification[] {
    const result: ApprovalNotification[] = [];
    const max = limit === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, limit);
    for (let index = this.order.length - 1; index >= 0 && result.length < max; index -= 1) {
      const item = this.items.get(this.order[index]);
      if (!item) {
        continue;
      }
      if (sessionId && item.sessionId !== sessionId) {
        continue;
      }
      result.push({ ...item });
    }
    return result;
  }

  public unread(sessionId?: string): ApprovalNotification[] {
    return this.list(sessionId).filter((item) => !item.acknowledged);
  }

  public unreadCount(sessionId?: string): number {
    return this.unread(sessionId).length;
  }

  public acknowledge(id: string): ApprovalNotification | null {
    const item = this.items.get(id);
    if (!item) {
      return null;
    }
    const next: ApprovalNotification = { ...item, acknowledged: true };
    this.items.set(id, next);
    return { ...next };
  }

  public acknowledgeAll(sessionId?: string): number {
    let acknowledged = 0;
    for (const [id, item] of this.items) {
      if (item.acknowledged) {
        continue;
      }
      if (sessionId && item.sessionId !== sessionId) {
        continue;
      }
      this.items.set(id, { ...item, acknowledged: true });
      acknowledged += 1;
    }
    return acknowledged;
  }

  public clear(sessionId?: string): number {
    if (!sessionId) {
      const removed = this.items.size;
      this.items.clear();
      this.order = [];
      return removed;
    }
    const kept: string[] = [];
    let removed = 0;
    for (const id of this.order) {
      if (this.items.get(id)?.sessionId === sessionId) {
        this.items.delete(id);
        removed += 1;
      } else {
        kept.push(id);
      }
    }
    this.order = kept;
    return removed;
  }

  public size(): number {
    return this.items.size;
  }

  public countsByKind(sessionId?: string): Record<NotificationKind, number> {
    const counts = NOTIFICATION_KINDS.reduce(
      (accumulator, kind) => {
        accumulator[kind] = 0;
        return accumulator;
      },
      {} as Record<NotificationKind, number>
    );
    for (const item of this.items.values()) {
      if (sessionId && item.sessionId !== sessionId) {
        continue;
      }
      counts[item.kind] += 1;
    }
    return counts;
  }

  private evict(): void {
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest) {
        this.items.delete(oldest);
      }
    }
  }
}
