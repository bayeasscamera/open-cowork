/**
 * @module main/agent/tool-activity-recorder
 *
 * Cowork 4.0 — Phase 6: bridges the pi session tool lifecycle to the control
 * center ActivityTracker. It owns the toolCallId → activity-id mapping so that a
 * tool_execution_end closes exactly the event opened by tool_execution_start,
 * even when several tools run concurrently inside one turn.
 */

import type { ActivityEvent } from '../../shared/control-center-types';
import type { ActivityTracker } from './activity-tracker';

/** Upper bound for the one-line detail shown in the activity feed. */
export const MAX_ACTIVITY_DETAIL_CHARS = 160;

/** Upper bound for the error excerpt stored on a failed activity. */
export const MAX_ACTIVITY_ERROR_CHARS = 240;

/** Argument keys worth surfacing, most specific first. */
const DETAIL_KEYS: readonly string[] = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'path',
  'paths',
  'pattern',
  'query',
  'url',
  'prompt',
];

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Build a short, single-line summary of a tool call from its arguments.
 * Never throws: unknown shapes simply produce no detail.
 */
export function summarizeToolActivityDetail(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return truncate(value.trim().replace(/\s+/g, ' '), MAX_ACTIVITY_DETAIL_CHARS);
    }
    if (Array.isArray(value)) {
      const first = value.find((item) => typeof item === 'string' && item.trim().length > 0);
      if (typeof first === 'string') {
        return truncate(first.trim().replace(/\s+/g, ' '), MAX_ACTIVITY_DETAIL_CHARS);
      }
    }
  }
  return undefined;
}

/**
 * Extract the most useful line of a tool output for the error field: the first
 * non-empty line, so the feed does not show a wall of stack trace.
 */
export function summarizeToolActivityError(output: string | undefined): string | undefined {
  if (typeof output !== 'string') {
    return undefined;
  }
  const line = output.split('\n').find((candidate) => candidate.trim().length > 0);
  if (!line) {
    return undefined;
  }
  return truncate(line.trim(), MAX_ACTIVITY_ERROR_CHARS);
}

export interface ToolActivityStartInput {
  toolCallId: string;
  toolName: string;
  /** Human-readable label; falls back to the raw tool name. */
  label?: string;
  args?: unknown;
}

export interface ToolActivityEndInput {
  toolCallId: string;
  isError: boolean;
  output?: string;
}

/**
 * Records tool executions in an ActivityTracker. One instance per agent run so
 * the toolCallId mapping cannot leak across sessions.
 */
export class ToolActivityRecorder {
  private readonly tracker: ActivityTracker;
  private readonly sessionId: string;
  private readonly ids = new Map<string, string>();

  constructor(tracker: ActivityTracker, sessionId: string) {
    this.tracker = tracker;
    this.sessionId = sessionId;
  }

  public start(input: ToolActivityStartInput): ActivityEvent {
    const label = input.label?.trim() || input.toolName;
    const detail = summarizeToolActivityDetail(input.args);
    const event = this.tracker.begin({
      sessionId: this.sessionId,
      tool: input.toolName,
      label,
      ...(detail ? { detail } : {}),
    });
    this.ids.set(input.toolCallId, event.id);
    return event;
  }

  public end(input: ToolActivityEndInput): ActivityEvent | null {
    const activityId = this.ids.get(input.toolCallId);
    if (!activityId) {
      return null;
    }
    this.ids.delete(input.toolCallId);
    if (input.isError) {
      const error = summarizeToolActivityError(input.output);
      return this.tracker.finish(activityId, {
        status: 'error',
        ...(error ? { error } : {}),
      });
    }
    return this.tracker.finish(activityId, { status: 'ok' });
  }

  /**
   * Close every still-running activity, e.g. when a run is aborted or the
   * provider fails mid-turn. Returns the number of events closed.
   */
  public cancelRunning(reason?: string): number {
    let cancelled = 0;
    for (const activityId of this.ids.values()) {
      this.tracker.finish(activityId, reason ? { status: 'cancelled', error: reason } : { status: 'cancelled' });
      cancelled += 1;
    }
    this.ids.clear();
    return cancelled;
  }

  /** Number of tool calls currently tracked as running. */
  public runningCount(): number {
    return this.ids.size;
  }
}
