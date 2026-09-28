/**
 * @module main/agent/run-abort-registry
 *
 * Publishes the AbortSignal of the agent turn currently running for a session.
 *
 * Why a registry instead of passing the signal down: the tool set handed to
 * the SDK is built once and cached across turns (see create-pi-session.ts and
 * the piSessions cache in CoworkAgentRunner), so a signal captured at build
 * time would be the previous turn's — already fired, or worse, never firing
 * again. Long-running tools (the swarm) therefore RESOLVE their signal at
 * execution time from this registry, which the runner refreshes on every turn.
 *
 * Deliberately dependency-free: the tool layer imports this without pulling in
 * the agent runner (which would create an import cycle).
 */

/** sessionId -> signal of the turn currently running. */
const runSignals = new Map<string, AbortSignal>();

/** Called by the runner when a turn starts. */
export function registerRunSignal(sessionId: string, signal: AbortSignal): void {
  runSignals.set(sessionId, signal);
}

/**
 * Called by the runner when a turn settles. Guarded so a late cleanup from a
 * previous turn can never delete the signal of the turn that replaced it.
 */
export function unregisterRunSignal(sessionId: string, signal?: AbortSignal): void {
  if (signal && runSignals.get(sessionId) !== signal) return;
  runSignals.delete(sessionId);
}

/**
 * Signal of the turn currently running for this session, or undefined when the
 * session is idle — in which case the caller runs without a cancel handle
 * rather than holding a dead one.
 */
export function getRunSignal(sessionId: string | undefined): AbortSignal | undefined {
  if (!sessionId) return undefined;
  const signal = runSignals.get(sessionId);
  return signal && !signal.aborted ? signal : undefined;
}

/** Test hook: drop every registered signal. */
export function resetRunSignals(): void {
  runSignals.clear();
}
