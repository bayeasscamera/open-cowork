/**
 * @module renderer/utils/raw-protocol-markup
 *
 * Quarantine for raw agent-protocol markup leaked into message text.
 *
 * Root cause this module exists for (observed on a real session, 2026-09-25/26):
 * under degraded upstream conditions (a 400 from the relay on a ~550k-token
 * context), the model started emitting its own function-calling protocol as
 * plain text — `<turn role="assistant">`, `<tool_use name="bash" id="…">`,
 * `<tool_result tool_use_id="…">` with replayed past outputs — instead of
 * structured `delta.tool_calls`. The OpenAI-compatible stream parser can only
 * surface text, so the protocol tags reached the renderer as literal prose and
 * react-markdown displayed them (and the embedded commands) verbatim.
 *
 * Detection is gated on tags that legitimate assistant prose never contains
 * (`tool_use` / `tool_result` / role-bearing or closing `turn` tags). Once a
 * leak is detected, the whole protocol-shaped segments — including replayed
 * results and the `<system_warning>` / `<output>` blocks that accompany them —
 * are extracted in document order into `fragments` so the UI can show them in
 * a collapsed, contained notice instead of the message body. Nothing is lost:
 * the raw payload stays one click away.
 */

export interface RawProtocolQuarantineResult {
  /** Text with every protocol segment removed. Identical reference when clean. */
  cleanText: string;
  /** Extracted raw protocol segments, in document order. */
  fragments: string[];
}

/**
 * Gate: does this text carry function-calling protocol markup? Matches the
 * tags that only ever appear when a model leaks its agent protocol as text.
 * `<output>` / `<system_warning>` are intentionally NOT signals (they are
 * ordinary HTML tag names); they are only ever extracted as part of a leak
 * that already tripped this gate.
 */
const RAW_PROTOCOL_SIGNAL = /<\/?tool_(?:use|result)\b|<turn\b[^>]*\brole\s*=|<\/turn\s*>/i;

/**
 * One combined alternation so extraction runs in a single left-to-right pass
 * and fragments come out in document order:
 *  1-4  paired segments (open tag … matching close, non-greedy);
 *  5-6  bare `turn` wrappers (opening with any attributes, closing);
 *  7    dangling opener of a truncated stream — an opening tag with no close
 *       ahead — consumed up to the next protocol tag or end of string.
 * Paired alternatives are tried first, so a stray unpaired opener only
 * matches when its closing tag is missing everywhere ahead.
 */
const PROTOCOL_SEGMENT_PATTERN = new RegExp(
  [
    /<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/.source,
    /<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/.source,
    /<system_warning\b[^>]*>[\s\S]*?<\/system_warning>/.source,
    /<output\b[^>]*>[\s\S]*?<\/output>/.source,
    /<turn\b[^>]*>/.source,
    /<\/turn\s*>/.source,
    /<(?:tool_use|tool_result|system_warning|output)\b[^>]*>[\s\S]*?(?=<turn\b|<\/?tool_(?:use|result)\b|<system_warning\b|<output\b|$)/
      .source,
  ].join('|'),
  'g'
);

/** True when the text carries raw function-calling protocol markup. */
export function hasRawProtocolMarkup(text: string): boolean {
  if (!text) return false;
  return RAW_PROTOCOL_SIGNAL.test(text);
}

/**
 * Extract raw agent-protocol markup from message text.
 *
 * Clean text is returned unchanged (same string) when nothing is detected, so
 * callers pay nothing on the normal path. When a leak is detected, removed
 * segments are collected in `fragments` and consecutive blank lines left
 * behind by the removals are collapsed.
 *
 * Note: assistant prose that *quotes* the protocol (e.g. a fenced example of
 * `<tool_use …>`) is also quarantined — the content is preserved in the
 * collapsed notice, and the cost of a false positive (content moved into the
 * disclosure) is far below the cost of the raw leak it guards against.
 */
export function quarantineRawProtocolMarkup(text: string): RawProtocolQuarantineResult {
  if (!hasRawProtocolMarkup(text)) {
    return { cleanText: text, fragments: [] };
  }

  const fragments: string[] = [];
  // Fresh regex instance: the pattern is global/stateful and shared.
  const pattern = new RegExp(PROTOCOL_SEGMENT_PATTERN.source, 'g');
  const cleanText = text.replace(pattern, (match) => {
    fragments.push(match);
    return '';
  });

  if (fragments.length === 0) {
    return { cleanText: text, fragments: [] };
  }

  return { cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim(), fragments };
}
