/**
 * @module main/ipc/control-center-handlers
 *
 * Cowork 4.0 — Phase 6: the agent control center IPC surface. Every payload is
 * validated here so the renderer can only ask for whitelisted actions (no raw
 * shell command, no path outside the workspace).
 */

import { ipcMain } from 'electron';
import type {
  ActivityEventInput,
  ActivityStatus,
  DetachedTaskInput,
  DetachedTaskStatus,
  NotificationInput,
  NotificationKind,
  TestCommandId,
  WorkspaceTreeOptions,
} from '../../shared/control-center-types';
import {
  ACTIVITY_STATUSES,
  DETACHED_TASK_STATUSES,
  NOTIFICATION_KINDS,
} from '../../shared/control-center-types';
import type { ControlCenterService } from '../agent/control-center-service';
import { isTestCommandId } from '../workspace/test-runner';
import { logError } from '../utils/logger';

export interface ControlCenterIpcContext {
  service: ControlCenterService;
}

function requireSessionId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('A session id is required.');
  }
  return value;
}

function optionalSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(label + ' must be a non-empty string.');
  }
  return value;
}

function coerceActivityInput(value: unknown, sessionId: string): ActivityEventInput {
  const candidate = (value ?? {}) as Partial<ActivityEventInput>;
  const input: ActivityEventInput = {
    sessionId,
    tool: requireNonEmpty(candidate.tool, 'Activity tool'),
    label: requireNonEmpty(candidate.label, 'Activity label'),
  };
  if (typeof candidate.taskId === 'string' && candidate.taskId.length > 0) {
    input.taskId = candidate.taskId;
  }
  if (typeof candidate.detail === 'string') {
    input.detail = candidate.detail;
  }
  return input;
}

function coerceActivityOutcome(value: unknown): {
  status: ActivityStatus;
  error?: string;
  detail?: string;
} {
  const candidate = (value ?? {}) as { status?: unknown; error?: unknown; detail?: unknown };
  if (
    typeof candidate.status !== 'string' ||
    !(ACTIVITY_STATUSES as readonly string[]).includes(candidate.status)
  ) {
    throw new Error('Unknown activity status: ' + String(candidate.status));
  }
  const outcome: { status: ActivityStatus; error?: string; detail?: string } = {
    status: candidate.status as ActivityStatus,
  };
  if (typeof candidate.error === 'string') {
    outcome.error = candidate.error;
  }
  if (typeof candidate.detail === 'string') {
    outcome.detail = candidate.detail;
  }
  return outcome;
}

function coerceTaskInput(value: unknown, sessionId: string): DetachedTaskInput {
  const candidate = (value ?? {}) as Partial<DetachedTaskInput>;
  const input: DetachedTaskInput = {
    sessionId,
    kind: requireNonEmpty(candidate.kind, 'Task kind'),
    label: requireNonEmpty(candidate.label, 'Task label'),
  };
  if (typeof candidate.resumeToken === 'string' && candidate.resumeToken.length > 0) {
    input.resumeToken = candidate.resumeToken;
  }
  return input;
}

function coerceTaskStatus(value: unknown): DetachedTaskStatus {
  if (
    typeof value !== 'string' ||
    !(DETACHED_TASK_STATUSES as readonly string[]).includes(value)
  ) {
    throw new Error('Unknown task status: ' + String(value));
  }
  return value as DetachedTaskStatus;
}

function coerceNotificationInput(value: unknown, sessionId: string): NotificationInput {
  const candidate = (value ?? {}) as Partial<NotificationInput>;
  if (
    typeof candidate.kind !== 'string' ||
    !(NOTIFICATION_KINDS as readonly string[]).includes(candidate.kind)
  ) {
    throw new Error('Unknown notification kind: ' + String(candidate.kind));
  }
  const input: NotificationInput = {
    sessionId,
    kind: candidate.kind as NotificationKind,
    title: requireNonEmpty(candidate.title, 'Notification title'),
  };
  if (typeof candidate.detail === 'string') {
    input.detail = candidate.detail;
  }
  if (typeof candidate.taskId === 'string' && candidate.taskId.length > 0) {
    input.taskId = candidate.taskId;
  }
  return input;
}

function coerceTreeOptions(value: unknown): WorkspaceTreeOptions {
  const candidate = (value ?? {}) as { maxDepth?: unknown; maxEntries?: unknown };
  const options: WorkspaceTreeOptions = {};
  if (typeof candidate.maxDepth === 'number' && candidate.maxDepth > 0) {
    options.maxDepth = Math.floor(candidate.maxDepth);
  }
  if (typeof candidate.maxEntries === 'number' && candidate.maxEntries > 0) {
    options.maxEntries = Math.floor(candidate.maxEntries);
  }
  return options;
}

function coerceTestCommandId(value: unknown): TestCommandId {
  if (!isTestCommandId(value)) {
    throw new Error('Unknown test command: ' + String(value));
  }
  return value;
}

export function registerControlCenterIpcHandlers(context: ControlCenterIpcContext): void {
  const { service } = context;

  ipcMain.handle('controlCenter.snapshot', (_event, sessionId: unknown) =>
    service.snapshot(requireSessionId(sessionId))
  );

  ipcMain.handle('controlCenter.activity', (_event, sessionId: unknown, limit?: unknown) =>
    service.activity.forSession(
      requireSessionId(sessionId),
      typeof limit === 'number' && limit > 0 ? Math.floor(limit) : undefined
    )
  );

  ipcMain.handle('controlCenter.recordActivity', (_event, sessionId: unknown, input: unknown) =>
    service.activity.begin(coerceActivityInput(input, requireSessionId(sessionId)))
  );

  ipcMain.handle(
    'controlCenter.finishActivity',
    (_event, sessionId: unknown, id: unknown, outcome: unknown) => {
      requireSessionId(sessionId);
      return service.activity.finish(requireNonEmpty(id, 'Activity id'), coerceActivityOutcome(outcome));
    }
  );

  ipcMain.handle('controlCenter.clearActivity', (_event, sessionId?: unknown) => ({
    removed: service.activity.clear(optionalSessionId(sessionId)),
  }));

  ipcMain.handle('controlCenter.workspaceTree', (_event, sessionId: unknown, options: unknown) =>
    service.workspaceTree(requireSessionId(sessionId), coerceTreeOptions(options))
  );

  ipcMain.handle(
    'controlCenter.readFile',
    (_event, sessionId: unknown, relativePath: unknown, maxBytes?: unknown) =>
      service.readFile(
        requireSessionId(sessionId),
        requireNonEmpty(relativePath, 'File path'),
        typeof maxBytes === 'number' && maxBytes > 0 ? Math.floor(maxBytes) : undefined
      )
  );

  ipcMain.handle('controlCenter.gitStatus', (_event, sessionId: unknown) =>
    service.gitStatus(requireSessionId(sessionId))
  );

  ipcMain.handle('controlCenter.runTests', (_event, sessionId: unknown, commandId: unknown) =>
    service.runTests(requireSessionId(sessionId), coerceTestCommandId(commandId))
  );

  ipcMain.handle('controlCenter.queue', (_event, sessionId?: unknown) =>
    service.queue.list(optionalSessionId(sessionId))
  );

  ipcMain.handle('controlCenter.enqueueTask', (_event, sessionId: unknown, input: unknown) =>
    service.queue.enqueue(coerceTaskInput(input, requireSessionId(sessionId)))
  );

  ipcMain.handle(
    'controlCenter.updateTask',
    (_event, sessionId: unknown, id: unknown, status: unknown, error?: unknown) => {
      requireSessionId(sessionId);
      const taskId = requireNonEmpty(id, 'Task id');
      const reason = typeof error === 'string' ? error : undefined;
      switch (coerceTaskStatus(status)) {
        case 'running':
          return service.queue.start(taskId);
        case 'completed':
          return service.queue.complete(taskId);
        case 'failed':
          return service.queue.fail(taskId, reason);
        case 'cancelled':
          return service.queue.cancel(taskId, reason);
        case 'queued':
        default:
          return service.queue.get(taskId);
      }
    }
  );

  ipcMain.handle('controlCenter.cancelTask', (_event, sessionId: unknown, id: unknown) => {
    requireSessionId(sessionId);
    return service.queue.cancel(requireNonEmpty(id, 'Task id'));
  });

  ipcMain.handle('controlCenter.notifications', (_event, sessionId?: unknown) =>
    service.notifications.list(optionalSessionId(sessionId))
  );

  ipcMain.handle('controlCenter.notify', (_event, sessionId: unknown, input: unknown) =>
    service.notifications.notify(coerceNotificationInput(input, requireSessionId(sessionId)))
  );

  ipcMain.handle(
    'controlCenter.acknowledgeNotification',
    (_event, sessionId: unknown, id: unknown) => {
      requireSessionId(sessionId);
      return service.notifications.acknowledge(requireNonEmpty(id, 'Notification id'));
    }
  );

  ipcMain.handle('controlCenter.acknowledgeAll', (_event, sessionId?: unknown) => {
    try {
      return { acknowledged: service.notifications.acknowledgeAll(optionalSessionId(sessionId)) };
    } catch (error: unknown) {
      logError('[controlCenter] acknowledgeAll failed', error);
      throw error;
    }
  });
}
