/**
 * @module main/agent/context-overflow
 *
 * Recognises a context-window overflow and decides whether a model fallback can
 * possibly fix it.
 *
 * Why this exists: createSwarmRunner retries a failed sub-agent exactly once
 * against the active profile. That is a good trade for an auth error, a 5xx, or
 * a rate limit — the retry is a genuinely different attempt. It is a bad trade
 * for a context overflow: the task is replayed from a fresh session, reads the
 * same files, and overflows again at the same point. The user pays twice for a
 * failure that was already certain, and the report blames the second model.
 */

/** Upstream phrasings seen across Anthropic, OpenAI, Gemini and Ollama. */
const OVERFLOW_PATTERNS: RegExp[] = [
  /context[_\s-]?length[_\s-]?exceeded/,
  /maximum context length/,
  /context window/i,
  /too many tokens/,
  /prompt is too long/,
  /input length and `max_tokens` exceed/,
  /reduce the length of the messages/,
  /exceeds the context/i,
  /context limit/,
];

/** True when the failure is the conversation not fitting the model's window. */
export function isContextOverflowError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${(error as { cause?: unknown }).cause instanceof Error
          ? String((error as { cause: Error }).cause.message)
          : ''}`
      : String(error ?? '');
  const lower = text.toLowerCase();
  return OVERFLOW_PATTERNS.some((pattern) => pattern.test(lower));
}

export interface FallbackDecision {
  /** Whether to spend the single fallback attempt. */
  retry: boolean;
  /** Why the fallback was skipped, for the log line. */
  reason?: 'context_overflow_not_recoverable';
}

/**
 * An overflow is only worth retrying when the fallback model has a LARGER
 * window than the one that just failed. An unknown window on either side is
 * treated as "do not retry": the safe default is not to double-bill.
 */
export function shouldRetryOnContextOverflow(args: {
  error: unknown;
  /** Context window of the model that failed. */
  sourceWindow?: number;
  /** Context window of the model we would fall back to. */
  fallbackWindow?: number;
}): FallbackDecision {
  if (!isContextOverflowError(args.error)) return { retry: true };
  const { sourceWindow, fallbackWindow } = args;
  if (typeof sourceWindow !== 'number' || typeof fallbackWindow !== 'number') {
    return { retry: false, reason: 'context_overflow_not_recoverable' };
  }
  return fallbackWindow > sourceWindow ? { retry: true } : { retry: false, reason: 'context_overflow_not_recoverable' };
}
