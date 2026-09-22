/**
 * @module main/agent/stream-liveness
 *
 * Liveness and accounting for the agent stream.
 *
 * Extracted from CoworkAgentRunner.run(). While a prompt runs, the runner has
 * to:
 *  - warn the user when an Ollama model takes a long time to load,
 *  - cancel that warning as soon as the first stream event arrives,
 *  - abort a prompt that produced no activity for five minutes,
 *  - count the stream event types for diagnostics.
 *
 * This module owns the scheduling policy; every effect (trace update, abort,
 * logging) is injected, so the timing can be tested with fake timers.
 */

/** Only this provider gets the cold-start (model loading) warning. */
const COLD_START_PROVIDER = 'ollama';

/** Defaults mirrored from the historical inline implementation. */
const DEFAULT_COLD_START_DELAY_MS = 10_000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

export interface StreamLivenessOptions {
  /** Provider id; only Ollama gets the cold-start warning. */
  provider?: string;
  /** Wall-clock start of the prompt, used to report first-event latency. */
  promptStartedAt: number;
  /** Whether the run was already aborted. */
  isAborted: () => boolean;
  /** Show the « waiting for the model to load » hint. */
  onColdStartWaiting: () => void;
  /** Called once, with the first event type and its latency. */
  onFirstStreamEvent: (event: { eventType: string; latencyMs: number }) => void;
  /** Called when the inactivity timeout fires. */
  onActivityTimeout: () => void;
  /** Delay before the cold-start hint (default 10s). */
  coldStartDelayMs?: number;
  /** Inactivity timeout (default 5 min). */
  activityTimeoutMs?: number;
  /** Injectable clock, mostly for tests. */
  now?: () => number;
}

export interface StreamLivenessWatcher {
  /** Records the first stream event; later calls are ignored. */
  markFirstStreamEvent(eventType: string): void;
  /** Restarts the inactivity countdown; call on every meaningful event. */
  resetActivityTimeout(): void;
  /** Counts one stream event type. */
  recordStreamEvent(eventType: string): void;
  /** Event counts sorted by type, for diagnostics. */
  getStreamEventSummary(): Record<string, number>;
  hasReceivedFirstStreamEvent(): boolean;
  /** Milliseconds until the first stream event, or null when none arrived. */
  getFirstStreamLatencyMs(): number | null;
  /** Stops both timers. */
  dispose(): void;
}

/** Creates the per-prompt liveness watcher (timers start immediately). */
export function createStreamLivenessWatcher(
  options: StreamLivenessOptions
): StreamLivenessWatcher {
  const now = options.now ?? Date.now;
  const coldStartDelayMs = options.coldStartDelayMs ?? DEFAULT_COLD_START_DELAY_MS;
  const activityTimeoutMs = options.activityTimeoutMs ?? DEFAULT_ACTIVITY_TIMEOUT_MS;
  const eventCounts = new Map<string, number>();

  let receivedFirstStreamEvent = false;
  let firstStreamEventAt: number | undefined;
  let coldStartTimerId: ReturnType<typeof setTimeout> | undefined;
  let activityTimeoutId: ReturnType<typeof setTimeout> | undefined;

  if (options.provider === COLD_START_PROVIDER) {
    coldStartTimerId = setTimeout(() => {
      if (!receivedFirstStreamEvent && !options.isAborted()) {
        options.onColdStartWaiting();
      }
    }, coldStartDelayMs);
  }

  const clearColdStartTimer = (): void => {
    if (coldStartTimerId) {
      clearTimeout(coldStartTimerId);
      coldStartTimerId = undefined;
    }
  };

  return {
    markFirstStreamEvent(eventType: string): void {
      if (receivedFirstStreamEvent) return;
      receivedFirstStreamEvent = true;
      firstStreamEventAt = now();
      clearColdStartTimer();
      options.onFirstStreamEvent({
        eventType,
        latencyMs: firstStreamEventAt - options.promptStartedAt,
      });
    },

    resetActivityTimeout(): void {
      if (activityTimeoutId) clearTimeout(activityTimeoutId);
      activityTimeoutId = setTimeout(() => {
        options.onActivityTimeout();
      }, activityTimeoutMs);
    },

    recordStreamEvent(eventType: string): void {
      eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1);
    },

    getStreamEventSummary(): Record<string, number> {
      return Object.fromEntries(
        Array.from(eventCounts.entries()).sort(([left], [right]) => left.localeCompare(right))
      );
    },

    hasReceivedFirstStreamEvent(): boolean {
      return receivedFirstStreamEvent;
    },

    getFirstStreamLatencyMs(): number | null {
      return firstStreamEventAt === undefined
        ? null
        : firstStreamEventAt - options.promptStartedAt;
    },

    dispose(): void {
      clearColdStartTimer();
      if (activityTimeoutId) {
        clearTimeout(activityTimeoutId);
        activityTimeoutId = undefined;
      }
    },
  };
}
