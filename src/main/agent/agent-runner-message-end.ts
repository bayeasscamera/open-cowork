import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '@mariozechner/pi-ai';

type MessageEndContentBlock = TextContent | ThinkingContent | ToolCall;

type MessageEndMessage = Pick<AssistantMessage, 'role' | 'content' | 'stopReason' | 'errorMessage'>;

interface ResolveMessageEndPayloadOptions {
  message?: MessageEndMessage;
  streamedText: string;
}

interface ResolvedMessageEndPayload {
  effectiveContent: MessageEndContentBlock[];
  errorText?: string;
  nextStreamedText: string;
  shouldEmitMessage: boolean;
}

const FOUR_XX_ERROR_RE = /\b4\d{2}\b/;

interface TerminalErrorEmissionDetails {
  partialText: string;
  messageText: string;
}

interface AbortDispositionFlags {
  abortedByTimeout: boolean;
  abortedByLoopGuard: boolean;
  abortedByStreamError: boolean;
}

type AbortDisposition = 'timeout' | 'loop_guard' | 'stream_error' | 'user';

/**
 * Machine-readable terminal error kinds. The main process stores the kind on
 * the message (`errorCode`); the renderer maps it to a localized label
 * (chat.terminalError.kinds.*), so the main process never needs to know the
 * UI locale. Raw upstream details always travel as plain text alongside.
 */
export type TerminalErrorCode =
  | 'timeout'
  | 'empty_result'
  | 'upstream_400'
  | 'auth_failed'
  | 'rate_limited'
  | 'server_error'
  | 'network_error'
  | 'stream_error';

/** Classify a raw terminal error string into a stable machine kind. Pure. */
export function classifyTerminalError(errorText: string): TerminalErrorCode {
  const lower = errorText.toLowerCase();
  if (lower.includes('first_response_timeout')) return 'timeout';
  if (lower.includes('empty_success_result')) return 'empty_result';
  if (
    /\b400\b/.test(errorText) ||
    lower.includes('bad request') ||
    lower.includes('invalid request')
  ) {
    return 'upstream_400';
  }
  if (/\b(401|403)\b/.test(errorText) || lower.includes('unauthorized') || lower.includes('forbidden')) {
    return 'auth_failed';
  }
  if (/\b429\b/.test(errorText) || lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'rate_limited';
  }
  if (
    /\b(5\d{2})\b/.test(errorText) ||
    lower.includes('server error') ||
    lower.includes('internal error') ||
    lower.includes('service unavailable') ||
    lower.includes('overloaded')
  ) {
    return 'server_error';
  }
  if (
    lower.includes('terminated') ||
    lower.includes('connection reset') ||
    lower.includes('connection closed') ||
    lower.includes('connection refused') ||
    lower.includes('connection error') ||
    lower.includes('fetch failed') ||
    lower.includes('other side closed') ||
    lower.includes('reset before headers') ||
    lower.includes('upstream connect') ||
    lower.includes('retry delay')
  ) {
    return 'network_error';
  }
  return 'stream_error';
}

/**
 * Locale-neutral, user-readable rendering of a raw terminal error. The stable
 * kind is carried separately via classifyTerminalError(); this text is the
 * detailed layer (kept next to the raw upstream message) and is intentionally
 * English so no UI locale is hardwired into persisted messages.
 */
export function toUserFacingErrorText(errorText: string): string {
  const lower = errorText.toLowerCase();
  if (lower.includes('first_response_timeout')) {
    return 'Model response timed out: no upstream output was received for an extended period. Retry later or check the current model/gateway load.';
  }
  if (lower.includes('empty_success_result')) {
    return 'The model returned an empty success result. The current model or gateway may have a compatibility problem. Retry or switch protocol.';
  }
  if (
    /\b400\b/.test(errorText) ||
    lower.includes('bad request') ||
    lower.includes('invalid request')
  ) {
    return `Upstream rejected the request (400). The model/protocol configuration may be incompatible. Check the model name, protocol settings and API endpoint.\nRaw error: ${errorText}`;
  }
  if (
    /\b(401|403)\b/.test(errorText) ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden')
  ) {
    return `Authentication failed. Check that the API key is correct, not expired, and allowed to access this model.\nRaw error: ${errorText}`;
  }
  if (
    /\b429\b/.test(errorText) ||
    lower.includes('rate limit') ||
    lower.includes('too many requests')
  ) {
    return `Rate limited (429). The call rate for this model or API endpoint has reached its limit. Retry later.\nRaw error: ${errorText}`;
  }
  if (
    /\b(5\d{2})\b/.test(errorText) ||
    lower.includes('server error') ||
    lower.includes('internal error') ||
    lower.includes('service unavailable') ||
    lower.includes('overloaded')
  ) {
    return `Upstream service error. The model service may be overloaded or temporarily down. The SDK will retry automatically.\nRaw error: ${errorText}`;
  }
  if (
    lower.includes('terminated') ||
    lower.includes('connection reset') ||
    lower.includes('connection closed') ||
    lower.includes('connection refused') ||
    lower.includes('connection error') ||
    lower.includes('fetch failed') ||
    lower.includes('other side closed') ||
    lower.includes('reset before headers') ||
    lower.includes('upstream connect') ||
    lower.includes('retry delay')
  ) {
    return `Network connection interrupted (${errorText}). The proxy/gateway may be unstable. The SDK will retry automatically.`;
  }
  return errorText;
}

export function resolveAssistantStreamErrorText(
  event: Extract<AssistantMessageEvent, { type: 'error' }>
): string {
  const rawError = event.error?.errorMessage?.trim() || event.reason || 'stream_error';
  return toUserFacingErrorText(rawError);
}

export function buildTerminalErrorMessage(errorText: string, partialText = ''): string {
  const normalizedPartial = partialText.trimEnd();
  const hint = FOUR_XX_ERROR_RE.test(errorText)
    ? '_Check the configuration and retry._'
    : '_The agent is retrying automatically, please wait..._';
  const errorBlock = `**Error**: ${errorText}\n\n${hint}`;
  return normalizedPartial ? `${normalizedPartial}\n\n${errorBlock}` : errorBlock;
}

export function buildTerminalErrorEmissionDetails(options: {
  errorText: string;
  streamedText: string;
}): TerminalErrorEmissionDetails {
  const partialText = options.streamedText;

  return {
    partialText,
    messageText: buildTerminalErrorMessage(options.errorText, partialText),
  };
}

export function resolveAbortDisposition(flags: AbortDispositionFlags): AbortDisposition {
  if (flags.abortedByTimeout) {
    return 'timeout';
  }
  if (flags.abortedByLoopGuard) {
    return 'loop_guard';
  }
  if (flags.abortedByStreamError) {
    return 'stream_error';
  }
  return 'user';
}

export function shouldPreserveExistingTrace(disposition: AbortDisposition): boolean {
  return disposition === 'loop_guard' || disposition === 'stream_error';
}

export function resolveMessageEndPayload(
  options: ResolveMessageEndPayloadOptions
): ResolvedMessageEndPayload {
  const { message, streamedText } = options;
  const nextStreamedText = '';

  if (message?.stopReason === 'error' && message.errorMessage) {
    return {
      effectiveContent: [],
      errorText: toUserFacingErrorText(message.errorMessage),
      nextStreamedText,
      shouldEmitMessage: false,
    };
  }

  const rawContent =
    Array.isArray(message?.content) && message.content.length > 0
      ? message.content
      : streamedText
        ? [{ type: 'text' as const, text: streamedText }]
        : [];

  if (rawContent.length === 0) {
    return {
      effectiveContent: [],
      errorText: toUserFacingErrorText('empty_success_result'),
      nextStreamedText,
      shouldEmitMessage: false,
    };
  }

  return {
    effectiveContent: rawContent,
    nextStreamedText,
    shouldEmitMessage: rawContent.length > 0 && (message?.role === 'assistant' || !message),
  };
}
