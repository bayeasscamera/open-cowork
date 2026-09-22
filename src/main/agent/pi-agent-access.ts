/**
 * @module main/agent/pi-agent-access
 *
 * Single, documented point of access to the *private* internals of the
 * pi-coding-agent SDK session/agent objects.
 *
 * The SDK does not declare these members in its public typings, so the unsafe
 * cast has to live somewhere. Keeping it here (instead of scattered across
 * agent-runner.ts) means:
 *  - a single place to update when the SDK shape changes, and
 *  - no \`any\` leaking into the rest of the runtime.
 */

/** Loose tool-call context the SDK passes to before/after tool-call hooks. */
export interface PiToolCallContext {
  toolCall?: { id?: string; name?: string };
  args?: Record<string, unknown>;
  result?: { content?: Array<{ type?: string; text?: string }> };
}

export type PiBeforeToolCallHook = (
  ctx: PiToolCallContext,
  signal?: AbortSignal
) => Promise<unknown>;

export type PiAfterToolCallHook = (ctx: PiToolCallContext) => Promise<unknown>;

export type PiOnPayloadHook = (
  payload: Record<string, unknown>,
  modelArg: unknown
) => Promise<Record<string, unknown>>;

/** The subset of the private Agent object this app relies on. */
export interface PiAgentInternals {
  setBeforeToolCall?: (hook: PiBeforeToolCallHook) => void;
  setAfterToolCall?: (hook: PiAfterToolCallHook) => void;
  _beforeToolCall?: PiBeforeToolCallHook;
  _onPayload?: PiOnPayloadHook;
}

/**
 * Read the private \`agent\` property off a session.
 * Returns null when the SDK does not expose it (older/newer shapes).
 */
export function getPiAgentInternals(session: unknown): PiAgentInternals | null {
  const agent = (session as { agent?: unknown } | null | undefined)?.agent;
  if (!agent || typeof agent !== 'object') return null;
  return agent as PiAgentInternals;
}

/** Optional private steering method used by the loop guard. */
export interface PiSessionSteering {
  sendUserMessage?: (text: string, options: { deliverAs: 'steer' }) => Promise<unknown>;
}

/** Read the optional private \`sendUserMessage\` steering method off a session. */
export function getPiSessionSteering(session: unknown): PiSessionSteering {
  return session as PiSessionSteering;
}
