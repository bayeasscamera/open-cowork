/**
 * Tests for the cold-start `<conversation_history>` rebuild
 * (`src/main/agent/cold-start-history.ts`).
 *
 * The rebuild path is exercised when the cached pi-coding-agent SDK session is
 * disposed (cwd change, or runtime-signature change) and agent-runner has to
 * reconstruct conversation history from DB-persisted messages.
 *
 * Bug #162 (Bug B): the previous implementation filtered to `type === 'text'`
 * only, silently dropping `thinking`, `tool_use`, and `tool_result` blocks.
 * Providers that require previous reasoning/tool-call replay (DeepSeek V4
 * Flash, and any thinking-capable model after a cwd switch) then 400 on the
 * next turn. These tests pin the serializer behavior so the regression cannot
 * return, plus the token-budgeted preamble assembled from it.
 *
 * The module is dependency-free, so no Electron/SDK stubbing is needed here.
 */

import { describe, expect, it } from 'vitest';

import type { ContentBlock, Message } from '../src/shared/types';
import {
  buildColdStartHistoryPreamble,
  estimateCharsPerToken,
  serializeMessageContentForHistory,
} from '../src/main/agent/cold-start-history';

describe('serializeMessageContentForHistory', () => {
  it('serializes a single text block as raw text (legacy compatible)', () => {
    const blocks: ContentBlock[] = [{ type: 'text', text: 'hello world' }];
    expect(serializeMessageContentForHistory(blocks)).toBe('hello world');
  });

  it('omits empty text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '' },
      { type: 'text', text: 'kept' },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe('kept');
  });

  it('wraps thinking blocks in <thinking> tags', () => {
    const blocks: ContentBlock[] = [{ type: 'thinking', thinking: 'reasoning trace' }];
    expect(serializeMessageContentForHistory(blocks)).toBe('<thinking>reasoning trace</thinking>');
  });

  it('serializes tool_use blocks with name, id, and JSON input', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'Bash',
        input: { command: 'ls -la' },
      },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe(
      '<tool_use name="Bash" id="toolu_01">{"command":"ls -la"}</tool_use>'
    );
  });

  it('serializes tool_result blocks with toolUseId and content', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', toolUseId: 'toolu_01', content: 'file1\nfile2' },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe(
      '<tool_result tool_use_id="toolu_01">file1\nfile2</tool_result>'
    );
  });

  it('marks tool_result errors with is_error="true"', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', toolUseId: 'toolu_02', content: 'boom', isError: true },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe(
      '<tool_result tool_use_id="toolu_02" is_error="true">boom</tool_result>'
    );
  });

  it('skips image and file_attachment blocks (binary / oversized)', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'before' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
      },
      {
        type: 'file_attachment',
        filename: 'data.bin',
        relativePath: 'tmp/data.bin',
        size: 1024,
      },
      { type: 'text', text: 'after' },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe('before\nafter');
  });

  it('preserves block ordering for a typical assistant turn (thinking → text → tool_use)', () => {
    // This is the exact shape that fails on DeepSeek V4 Flash without the fix:
    // an assistant turn with reasoning, followed by a textual answer fragment,
    // followed by a tool call. The model's next turn must see all three to
    // pass schema validation on providers that replay reasoning.
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'need to inspect the dir first' },
      { type: 'text', text: 'Let me check the directory.' },
      {
        type: 'tool_use',
        id: 'toolu_99',
        name: 'Bash',
        input: { command: 'pwd' },
      },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe(
      [
        '<thinking>need to inspect the dir first</thinking>',
        'Let me check the directory.',
        '<tool_use name="Bash" id="toolu_99">{"command":"pwd"}</tool_use>',
      ].join('\n')
    );
  });

  it('preserves block ordering for a user turn carrying a tool_result + free text', () => {
    const blocks: ContentBlock[] = [
      { type: 'tool_result', toolUseId: 'toolu_99', content: '/home/user' },
      { type: 'text', text: 'thanks, now list it' },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe(
      ['<tool_result tool_use_id="toolu_99">/home/user</tool_result>', 'thanks, now list it'].join(
        '\n'
      )
    );
  });

  it('falls back to defaults when tool_use fields are missing or unserializable', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const blocks: ContentBlock[] = [
      // Force a JSON.stringify failure (circular ref) — should degrade to "{}"
      {
        type: 'tool_use',
        id: '',
        name: '',
        input: circular,
      } as ContentBlock,
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe('<tool_use name="" id="">{}</tool_use>');
  });

  it('applies the nullish defaults when optional block fields are absent', () => {
    const blocks = [
      { type: 'text' } as ContentBlock,
      { type: 'thinking' } as ContentBlock,
      { type: 'tool_use' } as ContentBlock,
      { type: 'tool_result' } as ContentBlock,
    ];

    expect(serializeMessageContentForHistory(blocks)).toBe(
      '<tool_use name="unknown" id="">{}</tool_use>\n<tool_result tool_use_id=""></tool_result>'
    );
  });

  it('skips array elements that carry no text when flattening tool_result content', () => {
    const blocks = [
      {
        type: 'tool_result',
        toolUseId: 'call-9',
        content: [{ text: 'kept' }, { other: true }],
      },
    ] as unknown as ContentBlock[];

    expect(serializeMessageContentForHistory(blocks)).toBe(
      '<tool_result tool_use_id="call-9">kept\n</tool_result>'
    );
  });

  it('returns an empty string for messages composed entirely of skipped blocks', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' },
      },
      {
        type: 'file_attachment',
        filename: 'a.bin',
        relativePath: 'a.bin',
        size: 1,
      },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe('');
  });

  it('XML-escapes thinking content so </thinking> or & literals cannot break the envelope', () => {
    const blocks: ContentBlock[] = [
      { type: 'thinking', thinking: 'I read </thinking> then ran A & B with <foo>' },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe(
      '<thinking>I read &lt;/thinking&gt; then ran A &amp; B with &lt;foo&gt;</thinking>'
    );
  });

  it('XML-escapes tool_use attributes and body', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool_use',
        id: 'id"with&quote',
        name: 'name<x>',
        input: { cmd: 'echo "hi" & echo <bar>' },
      },
    ];
    const out = serializeMessageContentForHistory(blocks);
    // Attribute values must escape `"` so they don't break the attribute
    expect(out).toContain('name="name&lt;x&gt;"');
    expect(out).toContain('id="id&quot;with&amp;quote"');
    // Body keeps `"` literal (so JSON stays legible) but escapes `<`, `>`, `&`
    expect(out).toMatch(/<\/tool_use>$/);
    expect(out).not.toContain('<bar>');
    expect(out).toContain('&lt;bar&gt;');
    expect(out).toContain('"cmd"'); // body `"` not escaped
  });

  it('XML-escapes tool_result content (including </tool_result> literals)', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'tool_result',
        toolUseId: 'call-1',
        content: 'output </tool_result> & more',
      },
    ];
    expect(serializeMessageContentForHistory(blocks)).toBe(
      '<tool_result tool_use_id="call-1">output &lt;/tool_result&gt; &amp; more</tool_result>'
    );
  });

  it('flattens tool_result.content when stored as a content-block array (defensive)', () => {
    // Older message rows or third-party providers may persist tool_result.content
    // as an Anthropic-style array of content blocks. The local TS type is `string`,
    // but the serializer must not produce "[object Object]" for legacy data.
    const blocks = [
      {
        type: 'tool_result',
        toolUseId: 'call-2',
        content: [
          { type: 'text', text: 'first line' },
          { type: 'text', text: 'second line' },
        ] as unknown as string,
      },
    ] as ContentBlock[];
    const out = serializeMessageContentForHistory(blocks);
    expect(out).toBe('<tool_result tool_use_id="call-2">first line\nsecond line</tool_result>');
    expect(out).not.toContain('[object Object]');
  });

  it('falls back to empty string when tool_result.content is neither string nor array', () => {
    const blocks = [
      {
        type: 'tool_result',
        toolUseId: 'call-3',
        content: 42 as unknown as string,
      },
    ] as ContentBlock[];
    expect(serializeMessageContentForHistory(blocks)).toBe(
      '<tool_result tool_use_id="call-3"></tool_result>'
    );
  });
});

let messageCounter = 0;

const message = (role: 'user' | 'assistant', content: ContentBlock[]): Message => ({
  id: `message-${++messageCounter}`,
  sessionId: 'session-1',
  role,
  content,
  timestamp: messageCounter,
});

const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }];

describe('estimateCharsPerToken', () => {
  it('defaults to 4 chars per token for empty or English text', () => {
    expect(estimateCharsPerToken('')).toBe(4);
    expect(estimateCharsPerToken('hello world')).toBe(4);
  });

  it('drops towards 1.5 for pure CJK text', () => {
    expect(estimateCharsPerToken('你好世界你好世界')).toBeCloseTo(1.5, 5);
  });

  it('only samples the first 500 characters', () => {
    expect(estimateCharsPerToken('a'.repeat(600) + '你好')).toBe(4);
  });
});

describe('buildColdStartHistoryPreamble', () => {
  it('returns null without any conversation history', () => {
    expect(buildColdStartHistoryPreamble({ prompt: 'hello', messages: [] })).toBeNull();
  });

  it('returns null when the history is a single trailing user message', () => {
    expect(
      buildColdStartHistoryPreamble({ prompt: 'next', messages: [message('user', text('first'))] })
    ).toBeNull();
  });

  it('returns null when every message carries an image', () => {
    const imageMessage = message('assistant', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);

    expect(buildColdStartHistoryPreamble({ prompt: 'next', messages: [imageMessage] })).toBeNull();
  });

  it('wraps past turns in the conversation_history envelope and keeps the prompt last', () => {
    const preamble = buildColdStartHistoryPreamble({
      prompt: 'current question',
      messages: [
        message('user', text('earlier question')),
        message('assistant', text('earlier answer')),
        message('user', text('current question')),
      ],
    });

    expect(preamble?.injectedCount).toBe(2);
    expect(preamble?.totalCount).toBe(2);
    expect(preamble?.prompt).toContain('<conversation_history>');
    expect(preamble?.prompt).toContain('<turn role="user">earlier question</turn>');
    expect(preamble?.prompt).toContain('<turn role="assistant">earlier answer</turn>');
    expect(preamble?.prompt).toContain('</conversation_history>');
    expect(preamble?.prompt.endsWith('\n\ncurrent question')).toBe(true);
  });

  it('skips image-bearing messages but keeps the surrounding text', () => {
    const withImage = message('assistant', [
      { type: 'text', text: 'before' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);

    const preamble = buildColdStartHistoryPreamble({
      prompt: 'next',
      messages: [message('user', text('old question')), withImage, message('assistant', text('kept turn'))],
    });

    expect(preamble?.injectedCount).toBe(2);
    expect(preamble?.prompt).toContain('old question');
    expect(preamble?.prompt).toContain('kept turn');
    expect(preamble?.prompt).not.toContain('before');
  });

  it('returns null when dropping image messages leaves only the trailing user turn', () => {
    const withImage = message('assistant', [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);

    expect(
      buildColdStartHistoryPreamble({
        prompt: 'next',
        messages: [message('user', text('kept turn')), withImage],
      })
    ).toBeNull();
  });

  it('preserves thinking and tool blocks so reasoning replay keeps working', () => {
    const preamble = buildColdStartHistoryPreamble({
      prompt: 'next',
      messages: [
        message('assistant', [
          { type: 'thinking', thinking: 'need the dir first' },
          { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
        ]),
      ],
    });

    expect(preamble?.prompt).toContain('<thinking>need the dir first</thinking>');
    expect(preamble?.prompt).toContain('<tool_use name="Bash" id="call-1">');
  });

  it('trims the oldest turns first and says how many were dropped', () => {
    const longText = (index: number) => text(`msg-${index}`.padEnd(300, 'x'));
    const preamble = buildColdStartHistoryPreamble({
      prompt: 'current question',
      contextWindow: 1000,
      messages: [1, 2, 3, 4, 5].map((index) => message('assistant', longText(index))),
    });

    expect(preamble?.injectedCount).toBe(3);
    expect(preamble?.totalCount).toBe(5);
    expect(preamble?.prompt).toContain('[2 older messages omitted]');
    expect(preamble?.prompt).toContain('msg-5');
    expect(preamble?.prompt).not.toContain('msg-2');
    expect(preamble?.prompt).not.toContain('msg-1');
  });

  it('returns null when even the newest turn does not fit the budget', () => {
    expect(
      buildColdStartHistoryPreamble({
        prompt: 'next',
        contextWindow: 100,
        messages: [message('assistant', text('y'.repeat(2000)))],
      })
    ).toBeNull();
  });

  it('uses the tighter budget for a small Ollama context window', () => {
    const options = {
      prompt: 'next',
      contextWindow: 8192,
      messages: [message('assistant', text('hello'))],
    };

    expect(buildColdStartHistoryPreamble(options)?.charBudget).toBe(9828);
    expect(buildColdStartHistoryPreamble({ ...options, provider: 'ollama' })?.charBudget).toBe(
      4912
    );
  });

  it('falls back to a 128k context window when none is given', () => {
    const preamble = buildColdStartHistoryPreamble({
      prompt: 'next',
      messages: [message('assistant', text('hello'))],
    });

    // 30% of 128k = 38.4k tokens, capped at 32k tokens (×4 chars = 128k).
    expect(preamble?.charBudget).toBe(128000);
  });

  it('skips turns whose blocks serialize to nothing when building the preamble', () => {
    const attachmentOnly = message('assistant', [
      { type: 'file_attachment', filename: 'a.bin', relativePath: 'a.bin', size: 1 },
    ]);

    const preamble = buildColdStartHistoryPreamble({
      prompt: 'next',
      messages: [attachmentOnly, message('assistant', text('kept turn'))],
    });

    expect(preamble?.injectedCount).toBe(1);
    expect(preamble?.totalCount).toBe(2);
    expect(preamble?.prompt).toContain('kept turn');
    expect(preamble?.prompt).toContain('[1 older messages omitted]');
  });
});

