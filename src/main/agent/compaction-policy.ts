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
 * The rule is expressed once and applied everywhere: compaction stays OFF for
 * very small windows (a weak model produces a summary worse than the overflow
 * it replaces), is scaled proportionally for medium local windows, and — for
 * every other provider — derives its reserve from the window so the trigger
 * fires at ~80% of the limit rather than at `window - 16_384`. That last part
 * matters most on large-context models: the SDK's fixed reserve delays
 * compaction to 98.4% of a 1M window, by which point the turn in flight has
 * already overflowed and the session has to be abandoned rather than resumed.
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

/**
 * The SDK's own trigger is `tokens > window - reserveTokens` with a FIXED
 * reserve of 16 384. A fixed reserve is only equivalent to a proportional
 * threshold on a 128k window — it fires at 87% there, but at 74% on a 64k
 * window and at **98.4% on a 1M window**. That last case is the bug this
 * module exists to prevent: compaction then starts so late that the in-flight
 * user message and the tool call being assembled have already overflowed the
 * window, and the turn fails before the summariser ever runs.
 *
 * So the reserve is derived from the window instead of hard-coded. 20% of the
 * window triggers compaction at 80% of the limit on every model, leaving room
 * for the summary, the system prompt and the next turn to be assembled.
 */
const RESERVE_RATIO = 0.2;

/**
 * Fraction of the window preserved verbatim by the summariser. Recent turns
 * are what the model is actively reasoning about; rewriting them into a
 * summary loses more than it saves. Bounded to 25% because on a 1M window a
 * literal 25% would be 250k tokens of unsummarised history — most of the
 * window, which would make each compaction re-trigger immediately.
 */
const KEEP_RECENT_RATIO = 0.15;
const KEEP_RECENT_MAX_TOKENS = 30_000;

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
 * Proportional settings: same ~80% trigger on every window, with the verbatim
 * tail clamped so it can never dominate a huge context.
 */
function proportionalSettings(contextWindow: number): SubAgentCompactionSettings {
  return {
    enabled: true,
    // `ceil`, not `floor`: truncating the reserve downward pushes the trigger
    // slightly *above* the intended ratio (on a 16 384 window, floor yields
    // 80.004%). Compacting a fraction too late is the failure this guards, so
    // the reserve is rounded up and the trigger lands at or under 80%.
    reserveTokens: Math.ceil(contextWindow * RESERVE_RATIO),
    keepRecentTokens: Math.min(
      Math.floor(contextWindow * KEEP_RECENT_RATIO),
      KEEP_RECENT_MAX_TOKENS
    ),
  };
}

/**
 * Compaction settings for a session.
 *
 * The previous contract returned `undefined` for "the SDK defaults are already
 * correct", but they are only correct on a 128k window: `shouldCompact` is
 * `tokens > window - reserveTokens` with a fixed 16 384 reserve, which fires
 * at 98.4% on a 1M-window model — after the in-flight turn has already
 * overflowed. Every provider now gets a proportional reserve, so the trigger
 * lands at ~80% regardless of how large the window is.
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

  return proportionalSettings(contextWindow);
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

/** The share of the context window that triggers compaction, exported for tests. */
export const COMPACTION_TRIGGER_RATIO = 1 - RESERVE_RATIO;
