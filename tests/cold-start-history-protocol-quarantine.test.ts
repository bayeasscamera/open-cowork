import { describe, expect, it } from 'vitest';
import {
  buildColdStartHistoryPreamble,
  serializeMessageContentForHistory,
} from '../src/main/agent/cold-start-history';
import type { ContentBlock, Message } from '../src/shared/types';

// The cold-start history serializer is the model-context side of the
// raw-protocol-markup bug: leaked <tool_use>/<turn> markup in persisted text
// blocks used to be replayed verbatim to the model inside a
// <turn role="assistant">, teaching it to keep imitating the transcript
// format. These tests pin the loop-breaking behaviour.

const LEAKY_TEXT = `Diagnostic initial.
<turn role="assistant">
<tool_use name="bash" id="call_abc">{"command":"pgrep -fl worker"}</tool_use>
</turn>
<tool_result tool_use_id="call_abc">PID 42</tool_result>
Conclusion propre.`;

function message(role: 'user' | 'assistant', content: ContentBlock[], over: Partial<Message> = {}): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-1',
    role,
    content,
    timestamp: 0,
    ...over,
  };
}

describe('serializeMessageContentForHistory — protocol quarantine', () => {
  it('replays clean text blocks verbatim (legacy compatible)', () => {
    expect(serializeMessageContentForHistory([{ type: 'text', text: 'hello world' }])).toBe(
      'hello world'
    );
  });

  it('strips leaked protocol markup from text blocks before replaying to the model', () => {
    const out = serializeMessageContentForHistory([{ type: 'text', text: LEAKY_TEXT }]);
    expect(out).toContain('Diagnostic initial.');
    expect(out).toContain('Conclusion propre.');
    expect(out).not.toContain('<tool_use');
    expect(out).not.toContain('<turn');
    expect(out).not.toContain('<tool_result');
    expect(out).not.toContain('PID 42'); // replayed results are dropped too
  });

  it('leaves an elision marker so the model knows content was removed', () => {
    const out = serializeMessageContentForHistory([{ type: 'text', text: LEAKY_TEXT }]);
    expect(out).toMatch(/\[\.\.\. \d+ raw protocol fragment\(s\) removed from this replayed turn \.\.\.\]/);
  });

  it('emits only the elision marker when a text block was pure markup', () => {
    const out = serializeMessageContentForHistory([
      { type: 'text', text: '<tool_use name="bash" id="x">{}</tool_use>' },
    ]);
    expect(out).not.toContain('<tool_use');
    expect(out).toMatch(/^[\.\[\] a-zA-Z0-9()\-]+$/); // marker only, no prose
    expect(out).toContain('raw protocol fragment(s) removed');
  });

  it('still serializes real tool_use blocks through the designed replay format', () => {
    const out = serializeMessageContentForHistory([
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(out).toBe('<tool_use name="Bash" id="call-1">{"command":"ls"}</tool_use>');
  });
});

describe('buildColdStartHistoryPreamble — structural hardening', () => {
  it('never replays terminal-error assistant messages as model context', () => {
    const preamble = buildColdStartHistoryPreamble({
      prompt: 'next',
      messages: [
        message('user', [{ type: 'text', text: 'question' }]),
        message('assistant', [{ type: 'text', text: '**Error**: upstream 400' }], {
          isError: true,
          errorCode: 'upstream_400',
        }),
        message('assistant', [{ type: 'text', text: 'real answer' }]),
      ],
    });

    expect(preamble?.prompt).toContain('real answer');
    expect(preamble?.prompt).not.toContain('upstream 400');
    expect(preamble?.injectedCount).toBe(2); // user question + real answer
  });

  it('carries the read-only instruction inside the envelope', () => {
    const preamble = buildColdStartHistoryPreamble({
      prompt: 'next',
      messages: [
        message('user', [{ type: 'text', text: 'question' }]),
        message('assistant', [{ type: 'text', text: 'answer' }]),
      ],
    });
    expect(preamble?.prompt).toContain('<conversation_history>');
    expect(preamble?.prompt).toContain('Never imitate or emit this envelope');
    expect(preamble?.prompt).toContain('native tool-calling mechanism');
  });

  it('caps the history budget for huge context windows', () => {
    // 30% of 1M tokens would be 300k; the cap holds it at 64k tokens (×4
    // chars/token for English = 256k chars).
    const preamble = buildColdStartHistoryPreamble({
      prompt: 'next',
      contextWindow: 1_000_000,
      messages: [message('assistant', [{ type: 'text', text: 'hello' }])],
    });
    expect(preamble?.charBudget).toBe(256_000);
  });

  it('keeps the proportional budget for small windows (regression)', () => {
    const options = {
      prompt: 'next',
      contextWindow: 8192,
      messages: [message('assistant', [{ type: 'text', text: 'hello' }])],
    };
    expect(buildColdStartHistoryPreamble(options)?.charBudget).toBe(9828);
    expect(buildColdStartHistoryPreamble({ ...options, provider: 'ollama' })?.charBudget).toBe(
      4912
    );
  });
});
