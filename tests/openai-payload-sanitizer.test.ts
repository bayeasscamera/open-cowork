import { describe, expect, it, vi } from 'vitest';
import {
  allowsThinkingContentParts,
  baseUrlHostname,
  installPiPayloadHook,
  isOpenAICompatibleRoute,
  sanitizeOpenAICompatiblePayload,
  stripUnsupportedContentParts,
} from '../src/main/agent/openai-payload-sanitizer';

/**
 * Minimal mirror of the OpenAI Chat Completions content-part schema, i.e. the
 * exact check a relay applied when it answered:
 *   messages[2]: unknown variant `thinking`, expected one of `text`, `image_url`, `file`
 * Kept as a test double so the regression is reproduced at the schema level,
 * not by asserting on our own output only.
 */
const ALLOWED_OPENAI_CONTENT_PART_TYPES = new Set(['text', 'image_url', 'input_audio', 'file']);

function assertOpenAIContentSchema(payload: Record<string, unknown>): void {
  const messages = payload.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages)) return;
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    (message.content as Array<Record<string, unknown>>).forEach((part) => {
      const type = part.type;
      if (typeof type === 'string' && !ALLOWED_OPENAI_CONTENT_PART_TYPES.has(type)) {
        throw new Error(
          'Failed to deserialize the JSON body into the target type: messages[' +
            index +
            ']: unknown variant `' +
            type +
            '`, expected one of `text`, `image_url`, `file`'
        );
      }
    });
  });
}

/**
 * The payload pi-ai assembles for a DeepSeek V4 turn on a relay when
 * `compat.requiresThinkingInContent` is set: the assistant's previous turn is
 * replayed with its reasoning inside `content[]` as a `thinking` part.
 */
function deepSeekV4RelayPayload(): Record<string, unknown> {
  return {
    model: 'opencode-go/deepseek-v4.1-flash',
    stream: true,
    messages: [
      { role: 'system', content: 'You are a helpful agent.' },
      { role: 'user', content: 'Structure the association budget.' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Je dois verifier le total du budget.' },
          { type: 'text', text: 'Voici la structure budgetaire.' },
        ],
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"budget.md"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '# Budget' },
    ],
  };
}

const OMNIROUTE = {
  provider: 'custom',
  customProtocol: 'openai',
  baseUrl: 'http://localhost:20128/v1',
};
const XKIRO = { provider: 'custom', customProtocol: 'openai', baseUrl: 'https://api.xkiro.com/v1' };
const DEEPSEEK = {
  provider: 'custom',
  customProtocol: 'openai',
  baseUrl: 'https://api.deepseek.com/v1',
};

describe('openai-payload-sanitizer — endpoint policy', () => {
  it('rejects the thinking variant for third-party relays', () => {
    expect(allowsThinkingContentParts(OMNIROUTE)).toBe(false);
    expect(allowsThinkingContentParts(XKIRO)).toBe(false);
    expect(
      allowsThinkingContentParts({ provider: 'custom', baseUrl: 'http://127.0.0.1:1337/v1' })
    ).toBe(false);
  });

  it('accepts the thinking variant for the official DeepSeek API and OpenRouter', () => {
    expect(allowsThinkingContentParts(DEEPSEEK)).toBe(true);
    expect(
      allowsThinkingContentParts({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      })
    ).toBe(true);
  });

  it('parses hostnames defensively', () => {
    expect(baseUrlHostname('https://api.xkiro.com/v1')).toBe('api.xkiro.com');
    expect(baseUrlHostname('not a url')).toBe('');
    expect(baseUrlHostname(undefined)).toBe('');
  });

  it('covers the OpenAI-compatible routes', () => {
    expect(isOpenAICompatibleRoute(OMNIROUTE)).toBe(true);
    expect(isOpenAICompatibleRoute({ provider: 'openai' })).toBe(true);
    expect(isOpenAICompatibleRoute({ provider: 'anthropic' })).toBe(false);
  });
});

describe('openai-payload-sanitizer — regression for the 422 thinking error', () => {
  it('reproduces the original failure on the raw payload', () => {
    const payload = deepSeekV4RelayPayload();
    expect(() => assertOpenAIContentSchema(payload)).toThrow(/unknown variant `thinking`/);
  });

  it('no longer fails once the payload is sanitized for a relay', () => {
    const payload = deepSeekV4RelayPayload();
    const repaired = sanitizeOpenAICompatiblePayload(payload, OMNIROUTE);
    expect(() => assertOpenAIContentSchema(repaired)).not.toThrow();
  });

  it('keeps text, tool_calls and every other message intact', () => {
    const repaired = stripUnsupportedContentParts(deepSeekV4RelayPayload());
    const messages = repaired.payload.messages as Array<Record<string, unknown>>;
    const assistant = messages[2];
    expect(repaired.removedParts).toBe(1);
    expect(repaired.touchedMessages).toBe(1);
    expect(assistant.content).toEqual([{ type: 'text', text: 'Voici la structure budgetaire.' }]);
    expect(assistant.tool_calls).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful agent.' });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '# Budget' });
  });

  it('drops an assistant content array that only held thinking (tool-call-only turn)', () => {
    const payload = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'raisonnement' }],
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
      ],
    };
    const repaired = stripUnsupportedContentParts(payload);
    expect((repaired.payload.messages as Array<Record<string, unknown>>)[0].content).toBeNull();
  });

  it('is a no-op (same reference) for endpoints that accept the variant', () => {
    const payload = deepSeekV4RelayPayload();
    expect(sanitizeOpenAICompatiblePayload(payload, DEEPSEEK)).toBe(payload);
  });

  it('is a no-op for payloads without a messages array', () => {
    const payload = { model: 'x' };
    expect(stripUnsupportedContentParts(payload).payload).toBe(payload);
  });
});

describe('installPiPayloadHook', () => {
  it('strips thinking parts through the SDK payload hook', async () => {
    const host: { onPayload?: (p: Record<string, unknown>) => unknown } = {
      onPayload: (p) => p,
    };
    const installation = installPiPayloadHook(host, {
      endpoint: OMNIROUTE,
      sanitizeThinking: true,
    });
    expect(installation.installed).toBe(true);
    expect(installation.stripsThinking).toBe(true);
    const repaired = (await host.onPayload!(deepSeekV4RelayPayload())) as Record<string, unknown>;
    expect(() => assertOpenAIContentSchema(repaired)).not.toThrow();
  });

  it('chains a pre-existing hook and injects Ollama num_ctx', async () => {
    const existing = vi.fn(async (p: Record<string, unknown>) => ({ ...p, temperature: 0.2 }));
    const host: { onPayload?: (p: Record<string, unknown>) => unknown } = { onPayload: existing };
    const installation = installPiPayloadHook(host, {
      endpoint: { provider: 'ollama' },
      ollamaNumCtx: 32768,
    });
    expect(installation.installed).toBe(true);
    const out = (await host.onPayload!({ messages: [] })) as Record<string, unknown>;
    expect(existing).toHaveBeenCalledTimes(1);
    expect(out.num_ctx).toBe(32768);
    expect(out.temperature).toBe(0.2);
  });

  it('does nothing for endpoints that accept thinking parts', () => {
    const host: { onPayload?: (p: Record<string, unknown>) => unknown } = { onPayload: (p) => p };
    const installation = installPiPayloadHook(host, {
      endpoint: DEEPSEEK,
      sanitizeThinking: true,
    });
    expect(installation.installed).toBe(false);
    expect(installation.reason).toBe('nothing-to-do');
    expect(installation.stripsThinking).toBe(false);
  });

  it('reports when the SDK does not expose the hook', () => {
    const installation = installPiPayloadHook({}, { endpoint: OMNIROUTE, sanitizeThinking: true });
    expect(installation.installed).toBe(false);
    expect(installation.reason).toBe('no-hook');
  });

  it('reports when there is no agent at all', () => {
    const installation = installPiPayloadHook(null, {
      endpoint: OMNIROUTE,
      sanitizeThinking: true,
    });
    expect(installation.reason).toBe('no-host');
  });
});
