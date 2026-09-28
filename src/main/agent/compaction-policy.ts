/**
 * @module main/agent/compaction-policy
 *
 * One policy for auto-compaction, shared by the main agent and every sub-agent
 * path (swarm, sub-agent extension, task runner).
 *
 * Why it is shared: the three sub-agent paths used to hard-code
 * `compaction: { enabled: false }`, which left them with NO context management
 * at all. A sub-agent that read a handful of files then overflowed its window,
 * the provider rejected the request, the task failed — and the failure mode was
 * made worse by the model fallback in createSwarmRunner, which retried the same
 * oversized conversation against another profile and billed it twice for a
 * failure that was certain.
 *
 * The rule is the one the main agent already used, expressed once: compaction
 * stays OFF for very small windows (a weak model produces a summary worse than
 * the overflow it replaces), is scaled proportionally for medium windows, and
 * uses the SDK defaults for anything larger.
 *
 * The decision is deliberately silent: callers own their log wording (the main
 * agent's log lines are pinned by tests).
 */

/** Mirrors the SDK's CompactionSettings; kept local to avoid a deep import. */
export interface SubAgentCompactionSettings {
  enabled: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
}

/** Below this window the summarisation itself is unreliable. */
const SMALL_CONTEXT_WINDOW = 16_384;
/** Below this window the SDK defaults are scaled to the available space. */
const MEDIUM_CONTEXT_WINDOW = 65_536;
/** Assumed window when a model does not advertise one. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/** How a session reports the model it is about to run on. */
export interface CompactionPolicyInput {
  /** Model context window, when the profile advertises one. */
  contextWindow?: number;
  /** Provider id — only Ollama is tuned, because its windows vary wildly. */
  provider?: string;
}

/** The window the policy reasons about, after the unknown-value fallback. */
export function effectiveContextWindow(input: CompactionPolicyInput): number {
  return input.contextWindow && input.contextWindow > 0
    ? input.contextWindow
    : FALLBACK_CONTEXT_WINDOW;
}

/**
 * Compaction settings for a session, or `undefined` when the SDK defaults are
 * already correct and nothing needs overriding.
 */
export function resolveCompactionSettings(
  input: CompactionPolicyInput
): SubAgentCompactionSettings | undefined {
  const contextWindow = effectiveContextWindow(input);

  if (input.provider === 'ollama' && contextWindow < SMALL_CONTEXT_WINDOW) {
    // Very small context: disable compaction (weak models produce unreliable summaries)
    return { enabled: false };
  }

  if (input.provider === 'ollama' && contextWindow < MEDIUM_CONTEXT_WINDOW) {
    // Medium context: scale reserves proportionally
    return {
      enabled: true,
      reserveTokens: Math.floor(contextWindow * 0.15),
      keepRecentTokens: Math.floor(contextWindow * 0.25),
    };
  }

  return undefined;
}

/**
 * Settings for a session that must not be left without context management.
 * Unlike the tunable path this never returns undefined: a sub-agent has a
 * bounded, non-interactive budget, so "no opinion" is not an option — it
 * overflows and fails instead.
 */
export function resolveSubAgentCompactionSettings(
  input: CompactionPolicyInput
): SubAgentCompactionSettings {
  return resolveCompactionSettings(input) ?? { enabled: true };
}
