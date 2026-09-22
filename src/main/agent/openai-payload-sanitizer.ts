/**
 * @module main/agent/openai-payload-sanitizer
 *
 * Outgoing-payload policy for OpenAI-compatible endpoints (chat/completions).
 *
 * Root cause this module exists for (observed on a real session, 2026-09-22):
 * the pi-ai provider serializes a model's reasoning back into `content[]` parts
 * with `type: "thinking"` whenever `compat.requiresThinkingInContent` is set.
 * pi-model-resolution sets that flag for every DeepSeek V4 id, including the
 * ones served by third-party relays. Official DeepSeek accepts the variant;
 * relays that only implement the OpenAI Chat Completions schema answer
 *   422 ... unknown variant `thinking`, expected one of `text`, `image_url`, `file`
 * which killed the second turn of any tool-using exchange (the assistant's
 * previous turn carried a thinking block).
 *
 * The SDK exposes a private `agent._onPayload(params, model)` hook that runs
 * AFTER the request body is assembled and just BEFORE it is sent, so the
 * payload can be repaired without forking pi-ai. This module owns both the
 * decision (does this endpoint accept the variant?) and the transformation, so
 * the agent runner only wires a thin hook.
 */

/** Minimal structural view of the SDK agent's private payload hook. */
export interface PayloadHookHost {
  _onPayload?: (payload: Record<string, unknown>, modelArg: unknown) => unknown;
}

/** Endpoint facts needed to decide how the payload may be shaped. */
export interface OpenAIEndpointContext {
  provider?: string;
  customProtocol?: string;
  baseUrl?: string;
  modelId?: string;
}

/** Reasoning variants a reasoning model may replay through `content[]`. */
const NON_STANDARD_CONTENT_PART_TYPES = new Set(['thinking', 'reasoning']);

/** Hosts known to accept the non-standard `thinking` content variant. */
const THINKING_CONTENT_HOSTS = new Set(['api.deepseek.com']);

/** Safe extraction of a lower-case hostname from a base URL. */
export function baseUrlHostname(baseUrl?: string): string {
  const raw = baseUrl?.trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True when this endpoint is known to accept `content[].type === 'thinking'`.
 * Everything else is assumed to implement the OpenAI Chat Completions schema,
 * whose accepted variants are `text`, `image_url`, `input_audio` and `file`.
 */
export function allowsThinkingContentParts(endpoint: OpenAIEndpointContext): boolean {
  const host = baseUrlHostname(endpoint.baseUrl);
  if (THINKING_CONTENT_HOSTS.has(host) || host.endsWith('.deepseek.com')) return true;
  // OpenRouter documents provider reasoning fields and normalizes them itself.
  if (endpoint.provider === 'openrouter') return true;
  return false;
}

/** True for the routes this sanitizer is responsible for. */
export function isOpenAICompatibleRoute(endpoint: OpenAIEndpointContext): boolean {
  return (
    endpoint.customProtocol === 'openai' ||
    endpoint.provider === 'openai' ||
    endpoint.provider === 'custom' ||
    endpoint.provider === 'openrouter' ||
    endpoint.provider === 'ollama'
  );
}

export interface PayloadSanitizeResult {
  /** A new payload when something was removed, the input otherwise. */
  payload: Record<string, unknown>;
  /** Number of non-standard content parts dropped. */
  removedParts: number;
  /** Number of messages whose `content` changed. */
  touchedMessages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contentPartType(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  return typeof part.type === 'string' ? part.type : undefined;
}

/**
 * Drop `thinking`/`reasoning` parts from every message's `content[]`.
 * Text parts, `tool_calls` and untouched messages are preserved by reference,
 * so the transformation is cheap and side-effect free.
 */
export function stripUnsupportedContentParts(
  payload: Record<string, unknown>
): PayloadSanitizeResult {
  const messages = payload.messages;
  if (!Array.isArray(messages)) {
    return { payload, removedParts: 0, touchedMessages: 0 };
  }

  let removedParts = 0;
  let touchedMessages = 0;

  const nextMessages = messages.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    const kept = message.content.filter((part) => {
      const type = contentPartType(part);
      const drop = type !== undefined && NON_STANDARD_CONTENT_PART_TYPES.has(type);
      if (drop) removedParts += 1;
      return !drop;
    });
    if (kept.length === message.content.length) return message;
    touchedMessages += 1;
    // An assistant turn may legitimately carry `null` content when it only had
    // tool_calls; user/tool messages need a string instead.
    const content = kept.length > 0 ? kept : message.role === 'assistant' ? null : '';
    return { ...message, content };
  });

  if (touchedMessages === 0) return { payload, removedParts: 0, touchedMessages: 0 };
  return { payload: { ...payload, messages: nextMessages }, removedParts, touchedMessages };
}

/**
 * Repair an outgoing payload for an OpenAI-compatible relay. No-op (same
 * reference) when the endpoint accepts the reasoning variant or the route is
 * not OpenAI-compatible.
 */
export function sanitizeOpenAICompatiblePayload(
  payload: Record<string, unknown>,
  endpoint: OpenAIEndpointContext
): Record<string, unknown> {
  if (!isOpenAICompatibleRoute(endpoint)) return payload;
  if (allowsThinkingContentParts(endpoint)) return payload;
  return stripUnsupportedContentParts(payload).payload;
}

export interface PiPayloadHookOptions {
  endpoint?: OpenAIEndpointContext;
  /** When true, non-standard reasoning parts are stripped for relays. */
  sanitizeThinking?: boolean;
  /** Ollama only: value injected as `num_ctx` on every request. */
  ollamaNumCtx?: number;
}

export interface PiPayloadHookInstallation {
  installed: boolean;
  reason?: 'no-host' | 'no-hook' | 'nothing-to-do';
  /** True when this install strips reasoning content parts. */
  stripsThinking: boolean;
}

/**
 * Wrap `agent._onPayload` once, chaining any pre-existing hook. Mirrors the
 * shape the runner already used for Ollama's `num_ctx`, and adds the
 * thinking-part repair for relays. Returns what was installed for logging.
 */
export function installPiPayloadHook(
  host: PayloadHookHost | null | undefined,
  options: PiPayloadHookOptions = {}
): PiPayloadHookInstallation {
  const endpoint = options.endpoint ?? {};
  const stripsThinking =
    options.sanitizeThinking === true && !allowsThinkingContentParts(endpoint);
  const injectsNumCtx = typeof options.ollamaNumCtx === 'number';

  if (!host) return { installed: false, reason: 'no-host', stripsThinking };
  if (!('_onPayload' in host)) return { installed: false, reason: 'no-hook', stripsThinking };
  if (!stripsThinking && !injectsNumCtx) {
    return { installed: false, reason: 'nothing-to-do', stripsThinking };
  }

  const original = host._onPayload;
  host._onPayload = async (payload: Record<string, unknown>, modelArg: unknown) => {
    let result = original ? await original.call(host, payload, modelArg) : payload;
    if (result === undefined || result === null) result = payload;
    let next = isRecord(result) ? result : payload;
    if (stripsThinking) next = stripUnsupportedContentParts(next).payload;
    if (injectsNumCtx) next = { ...next, num_ctx: options.ollamaNumCtx };
    return next;
  };

  return { installed: true, stripsThinking };
}
