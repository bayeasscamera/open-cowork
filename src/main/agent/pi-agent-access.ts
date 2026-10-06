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
 *
 * pi-agent-core 0.73 turned the pre/post tool-call and payload hooks from
 * private fields (\`_beforeToolCall\`, \`_afterToolCall\`, \`_onPayload\`) written
 * by \`setBeforeToolCall\` / \`setAfterToolCall\` into public assignable properties
 * (\`beforeToolCall\`, \`afterToolCall\`, \`onPayload\`). All three are read when the
 * loop config is built — once per run — so assigning the property after
 * construction is exactly equivalent to the old setter.
 *
 * The SDK installs no hook of its own any more, so a first install has nothing
 * to chain. Extension \`tool_call\` events now fire from the tool wrappers
 * AgentSession builds, not from this slot.
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

type PiAfterToolCallHook = (ctx: PiToolCallContext) => Promise<unknown>;

type PiOnPayloadHook = (
  payload: Record<string, unknown>,
  modelArg: unknown
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** The subset of the private Agent object this app relies on. */
interface PiAgentInternals {
  beforeToolCall?: PiBeforeToolCallHook;
  afterToolCall?: PiAfterToolCallHook;
  onPayload?: PiOnPayloadHook;
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
interface PiSessionSteering {
  sendUserMessage?: (text: string, options: { deliverAs: 'steer' }) => Promise<unknown>;
}

/** Read the optional private \`sendUserMessage\` steering method off a session. */
export function getPiSessionSteering(session: unknown): PiSessionSteering {
  return session as PiSessionSteering;
}
