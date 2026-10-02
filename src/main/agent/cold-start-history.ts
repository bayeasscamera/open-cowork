/**
 * @module main/agent/cold-start-history
 *
 * Cold-start conversation history rebuild.
 *
 * When the cached pi SDK session is disposed (cwd change or runtime-signature
 * change), agent-runner has to rebuild the conversation from the messages
 * persisted in the database and hand it to the model as a text preamble. This
 * module owns that rebuild: the XML envelope, the per-block serializer and the
 * token-budgeted trimming.
 *
 * Extracted from CoworkAgentRunner.run(); pure and dependency-free, so it can be
 * tested without Electron, the SDK or a database.
 */
import type { ContentBlock, Message } from '../../shared/types';
import { quarantineRawProtocolMarkup } from '../../shared/raw-protocol-markup';

/**
 * Upper bound for the cold-start history budget, in tokens. The proportional
 * budget (30% of the context window) was sized for ~128k windows; on huge
 * windows (e.g. 1M-token GLM relays) it injects up to 300k tokens of replayed
 * history, which both wastes cache and pushes the model far into its window
 * where output format degradation was observed (2026-09 session audit).
 * Capped at 32k: 64k alone is 32% of a real 200k relay window and was a
 * co-driver of the 201k-token 400 overflow (2026-10 audit).
 */
const MAX_COLD_START_HISTORY_TOKENS = 32_000;

/**
 * One-line instruction inside the history envelope. The serializer itself
 * uses the `<turn>`/`<tool_use>` vocabulary, and a degraded model can mistake
 * the replayed transcript for the output format to imitate — this tells it
 * explicitly not to.
 */
const HISTORY_READ_ONLY_NOTE =
  '[Replayed conversation history, for context only. Never imitate or emit this envelope, the <turn>, <tool_use> or <tool_result> markup in your replies. Call tools only through the native tool-calling mechanism.]';

/**
 * Estimate chars-per-token ratio based on content language.
 * CJK characters tokenize at ~1.5 chars/token vs ~4 for English.
 */
export function estimateCharsPerToken(sampleText: string): number {
  if (!sampleText || sampleText.length === 0) return 4;
  const sample = sampleText.substring(0, 500);
  const cjkCount = (sample.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) || [])
    .length;
  const cjkRatio = cjkCount / sample.length;
  return 4 - cjkRatio * 2.5; // Range: 1.5 (pure CJK) ~ 4 (pure English)
}

// Escape characters that would break the cold-start `<conversation_history>`
// envelope when interpolated into XML tag bodies or attribute values. Raw user
// text blocks are intentionally not escaped (preserves legacy compatibility);
// only the wrapper tags (`<thinking>`, `<tool_use>`, `<tool_result>`) and their
// attributes pass through these.
//
// Attribute values additionally need `"` escaped because attributes are
// double-quoted. Tag bodies do not (keeping `"` keeps JSON input legible to the
// model).
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Serialize a message's content blocks into the XML representation used inside
 * the cold-start `<conversation_history>` preamble.
 *
 * Why this exists: when the cached pi-coding-agent SDK session is disposed (cwd
 * change or runtime-signature change), agent-runner rebuilds history from
 * DB-persisted messages. The previous implementation only kept `text` blocks,
 * which silently dropped `thinking`, `tool_use` and `tool_result` blocks.
 * Providers that require previous reasoning/tool-call replay (e.g. DeepSeek V4
 * Flash) then fail with 400 on the next turn, and every other thinking-capable
 * model loses its reasoning trace across cwd switches (issue #162, Bug B).
 *
 * Blocks handled:
 *   - text            -> raw text (matches the legacy serializer output)
 *   - thinking        -> `<thinking>...</thinking>`
 *   - tool_use        -> `<tool_use name="..." id="...">{json input}</tool_use>`
 *   - tool_result     -> `<tool_result tool_use_id="..."[ is_error="true"]>...</tool_result>`
 *   - image           -> skipped (binary, cannot live inside an XML text preamble)
 *   - file_attachment -> skipped (large, would bloat the prompt)
 */
export function serializeMessageContentForHistory(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const text = block.text ?? '';
        if (text.length === 0) break;
        // Raw agent-protocol markup leaked into a past text block must never
        // be replayed to the model: it is the exact imitation-loop amplifier
        // observed in the 2026-09 sessions (the model sees its own leaked
        // <tool_use>/<turn> transcript inside a <turn role="assistant"> and
        // keeps regurgitating the format). Strip it; leave a marker so the
        // model knows content was elided rather than silently truncated.
        const { cleanText, fragments } = quarantineRawProtocolMarkup(text);
        if (fragments.length === 0) {
          parts.push(cleanText);
        } else {
          const elision = `[... ${fragments.length} raw protocol fragment(s) removed from this replayed turn ...]`;
          parts.push(cleanText.length > 0 ? `${cleanText}\n${elision}` : elision);
        }
        break;
      }
      case 'thinking': {
        const thinking = block.thinking ?? '';
        if (thinking.length > 0) parts.push(`<thinking>${escapeXmlText(thinking)}</thinking>`);
        break;
      }
      case 'tool_use': {
        const name = block.name ?? 'unknown';
        const id = block.id ?? '';
        let inputStr: string;
        try {
          inputStr = JSON.stringify(block.input ?? {});
        } catch {
          inputStr = '{}';
        }
        parts.push(
          `<tool_use name="${escapeXmlAttr(name)}" id="${escapeXmlAttr(id)}">${escapeXmlText(inputStr)}</tool_use>`
        );
        break;
      }
      case 'tool_result': {
        const id = block.toolUseId ?? '';
        const errAttr = block.isError ? ' is_error="true"' : '';
        // Local type says `content: string`, but Anthropic-style payloads from
        // older message rows or third-party providers may store an array of
        // content blocks. Flatten defensively so we never serialize
        // "[object Object]".
        const rawContent = (block as { content: unknown }).content;
        let text: string;
        if (typeof rawContent === 'string') {
          text = rawContent;
        } else if (Array.isArray(rawContent)) {
          text = rawContent
            .map((c) =>
              c && typeof c === 'object' && 'text' in c
                ? String((c as { text: unknown }).text ?? '')
                : ''
            )
            .join('\n');
        } else {
          text = '';
        }
        parts.push(
          `<tool_result tool_use_id="${escapeXmlAttr(id)}"${errAttr}>${escapeXmlText(text)}</tool_result>`
        );
        break;
      }
      case 'image':
      case 'file_attachment':
        // Skip: not representable as XML text in a history preamble.
        break;
    }
  }
  return parts.join('\n');
}

/** Inputs for the cold-start preamble builder. */
export interface ColdStartHistoryOptions {
  /** The user's new prompt, appended after the preamble. */
  prompt: string;
  /** All persisted messages of the session, oldest first. */
  messages: Message[];
  /** Model context window in tokens; defaults to 128k. */
  contextWindow?: number;
  /** Provider id, used to pick a tighter budget for small Ollama windows. */
  provider?: string;
}

/** A built preamble plus the numbers the caller logs. */
export interface ColdStartHistoryPreamble {
  /** The prompt with the `<conversation_history>` preamble prepended. */
  prompt: string;
  injectedCount: number;
  totalCount: number;
  charBudget: number;
  charCount: number;
  charsPerToken: number;
}

/**
 * Builds the `<conversation_history>` preamble injected on a cold start.
 *
 * The trailing user message is dropped because the caller passes the same text
 * as `prompt`. Image-bearing messages are skipped (they cannot be serialized to
 * text) and the rest is trimmed from the oldest side until the char budget is
 * spent, so the most recent turns always survive.
 *
 * Returns null when there is nothing to inject, in which case the caller should
 * send the prompt unchanged.
 */
export function buildColdStartHistoryPreamble(
  options: ColdStartHistoryOptions
): ColdStartHistoryPreamble | null {
  // Terminal-error messages (isError) are not real assistant turns — they are
  // Cowork-generated error reports. Replaying them as assistant speech both
  // confuses the model and wastes budget.
  const conversationMessages = options.messages.filter(
    (msg) =>
      (msg.role === 'user' || msg.role === 'assistant') &&
      (msg as { isError?: boolean }).isError !== true
  );
  // Filter out messages that contain images (images can't be serialized into text preamble)
  const textOnlyMessages = conversationMessages.filter(
    (msg) => !msg.content.some((c) => (c as { type?: string }).type === 'image')
  );
  const historyMessages =
    textOnlyMessages.length > 0 && textOnlyMessages[textOnlyMessages.length - 1]?.role === 'user'
      ? textOnlyMessages.slice(0, -1)
      : textOnlyMessages;

  if (historyMessages.length === 0) return null;

  // Content-aware chars-per-token estimation (CJK text uses ~1.5 chars/token vs ~4 for English)
  const contextWindow = options.contextWindow || 128000;
  const historyBudgetRatio = options.provider === 'ollama' && contextWindow < 16384 ? 0.15 : 0.3;
  const historyTokenBudget = Math.min(
    Math.floor(contextWindow * historyBudgetRatio),
    MAX_COLD_START_HISTORY_TOKENS
  );

  // Sample recent messages to estimate chars-per-token ratio. Sampling the full
  // serialized form (text + thinking + tool blocks) gives a better CJK ratio
  // estimate than sampling text only.
  const sampleText = historyMessages
    .slice(-3)
    .map((m) => serializeMessageContentForHistory(m.content))
    .join('');
  const charsPerToken = estimateCharsPerToken(sampleText);
  const charBudget = Math.floor(historyTokenBudget * charsPerToken);

  const historyItems: string[] = [];
  let charCount = 0;
  // Build from newest to oldest, then reverse. We preserve thinking and tool
  // blocks (not just text) so providers requiring reasoning/tool-call replay
  // (DeepSeek V4 Flash, and any thinking-capable model after a cwd switch)
  // continue to function after a cold start. See #162 Bug B.
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    const serialized = serializeMessageContentForHistory(msg.content);
    if (serialized.length === 0) continue;
    const roleTag = msg.role === 'user' ? 'user' : 'assistant';
    const entry = `<turn role="${roleTag}">${serialized}</turn>`;
    if (charCount + entry.length > charBudget) break;
    charCount += entry.length;
    historyItems.unshift(entry);
  }

  if (historyItems.length === 0) return null;

  const trimmedCount = historyMessages.length - historyItems.length;
  const historyNote = trimmedCount > 0 ? `[${trimmedCount} older messages omitted]\n` : '';
  const preamble = `<conversation_history>\n${HISTORY_READ_ONLY_NOTE}\n${historyNote}${historyItems.join('\n')}\n</conversation_history>`;

  return {
    prompt: `${preamble}\n\n${options.prompt}`,
    injectedCount: historyItems.length,
    totalCount: historyMessages.length,
    charBudget,
    charCount,
    charsPerToken,
  };
}
