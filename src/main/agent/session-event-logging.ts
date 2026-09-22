/**
 * @module main/agent/session-event-logging
 *
 * Classifies a pi session stream event for diagnostics and counts its assistant
 * update types, emitting the exact log lines the runner used to emit inline.
 *
 * Extracted from the piSession.subscribe() callback in CoworkAgentRunner.run().
 * The abort guard and the activity-timeout reset stay in the runner: they gate
 * the whole callback, not just logging. Telemetry and serializers are injected
 * so the module owns no runner state and stays Electron-free.
 */

import { log } from '../utils/logger';

/** Minimal event shape this module classifies; extra fields are ignored. */
export interface SessionStreamEventLike {
  type: string;
  assistantMessageEvent?: { type: string };
  message?: unknown;
}

export interface SessionEventTelemetry {
  /** Counts one streamed assistant event type. */
  recordStreamEvent(updateType: string): void;
  /** Event counts, for the message_end diagnostics. */
  getStreamEventSummary(): Record<string, number>;
}

export interface SessionEventLoggingDeps {
  telemetry: SessionEventTelemetry;
  /** Safe JSON serializer tolerant of circular / throwing payloads. */
  stringify(value: unknown, space?: number): string;
  /** Reduces a message to a loggable shape (drops heavy binary payloads). */
  summarizeMessage(message: unknown): unknown;
}

/** Assistant update types suppressed so deltas are never logged one by one. */
const QUIET_UPDATE_TYPES = new Set(['text_delta', 'thinking_delta']);

/**
 * Records the event's assistant update type and logs the same diagnostic lines
 * the runner used to emit: quiet for text/thinking deltas, payload summaries for
 * message_start / message_end, and the event type for everything else.
 */
export function logSessionStreamEvent(
  event: SessionStreamEventLike,
  deps: SessionEventLoggingDeps
): void {
  if (event.type === 'message_update') {
    // pi always provides assistantMessageEvent; default defensively instead of throwing.
    const updateType = event.assistantMessageEvent?.type ?? 'unknown';
    deps.telemetry.recordStreamEvent(updateType);
    if (!QUIET_UPDATE_TYPES.has(updateType)) {
      log(`[CoworkAgentRunner] Event: ${event.type} → ${updateType}`);
    }
    return;
  }

  if (event.type === 'message_start') {
    log(
      '[CoworkAgentRunner] Event: message_start',
      deps.stringify(deps.summarizeMessage(event.message), 2)
    );
    return;
  }

  if (event.type === 'message_end') {
    log(
      '[CoworkAgentRunner] Event: message_end',
      deps.stringify(
        {
          message: deps.summarizeMessage(event.message),
          messageUpdateCounts: deps.telemetry.getStreamEventSummary(),
        },
        2
      )
    );
    return;
  }

  log(`[CoworkAgentRunner] Event: ${event.type}`);
}
