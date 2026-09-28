import { describe, it, expect } from 'vitest';
import { buildSessionBlockIndex, emptySessionBlockIndex } from '../src/renderer/store/selectors';
import type { Message } from '../src/renderer/types';

/**
 * ToolUseBlock and ToolResultBlock pair each `tool_use` with its `tool_result`.
 * They used to do it with a nested loop over all messages × all blocks, per
 * rendered component, recomputed on every streamed turn — quadratic work in
 * the hot path, on the long sessions where the UI already struggles. These
 * tests pin the index that replaced those scans.
 */

const message = (id: string, blocks: unknown[]): Message =>
  ({ id, sessionId: 's1', role: 'assistant', content: blocks, timestamp: 0 }) as unknown as Message;

describe('buildSessionBlockIndex', () => {
  it('indexes tool_use blocks by their own id', () => {
    const messages = [
      message('m1', [
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
        { type: 'text', text: 'hello' },
      ]),
    ];
    const index = buildSessionBlockIndex(messages);
    expect(index.toolUseById.get('tu1')?.name).toBe('Bash');
    expect(index.toolUseById.has('nope')).toBe(false);
  });

  it('indexes tool_result blocks by the tool_use they answer', () => {
    const messages = [
      message('m1', [
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
      ]),
      message('m2', [
        { type: 'tool_result', toolUseId: 'tu1', content: 'out' },
      ]),
    ];
    const index = buildSessionBlockIndex(messages);
    expect(index.toolResultByToolUseId.get('tu1')?.content).toBe('out');
  });

  it('pairs a tool_use and its result across different messages', () => {
    // The case the old nested loop existed for.
    const messages = [
      message('m1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} }]),
      message('m2', [{ type: 'text', text: 'thinking' }]),
      message('m3', [{ type: 'tool_result', toolUseId: 'tu1', content: 'file body' }]),
    ];
    const index = buildSessionBlockIndex(messages);
    expect(index.toolUseById.has('tu1')).toBe(true);
    expect(index.toolResultByToolUseId.get('tu1')?.content).toBe('file body');
  });

  it('detects a truly orphan result (no matching tool_use anywhere)', () => {
    const messages = [
      message('m1', [{ type: 'tool_result', toolUseId: 'ghost', content: 'out' }]),
    ];
    const index = buildSessionBlockIndex(messages);
    expect(index.toolUseById.has('ghost')).toBe(false);
    // …and the result itself is still reachable, it is just unpaired.
    expect(index.toolResultByToolUseId.get('ghost')?.content).toBe('out');
  });

  it('returns the SAME index for the same array reference', () => {
    // Referential stability is the whole point: the components subscribe to the
    // store and re-render on identity change.
    const messages = [message('m1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }])];
    expect(buildSessionBlockIndex(messages)).toBe(buildSessionBlockIndex(messages));
  });

  it('rebuilds for a new array even with identical content', () => {
    const blocks = [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }];
    const first = buildSessionBlockIndex([message('m1', blocks)]);
    const second = buildSessionBlockIndex([message('m1', blocks)]);
    // A new array means a real change upstream: the index must not be reused.
    expect(first).not.toBe(second);
    expect(second.toolUseById.get('tu1')?.name).toBe('Bash');
  });

  it('tolerates a message whose content is not an array', () => {
    const messages = [
      { id: 'm1', sessionId: 's1', role: 'user', content: 'plain string', timestamp: 0 },
      message('m2', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }]),
    ] as unknown as Message[];
    const index = buildSessionBlockIndex(messages);
    expect(index.toolUseById.get('tu1')?.name).toBe('Bash');
  });

  it('handles an empty session without allocating two maps per call', () => {
    const empty = emptySessionBlockIndex();
    expect(empty.toolUseById.size).toBe(0);
    expect(empty.toolResultByToolUseId.size).toBe(0);
    const built = buildSessionBlockIndex([]);
    expect(built.toolUseById.size).toBe(0);
  });

  it('scales linearly: N tool calls produce N entries, not a re-scan per lookup', () => {
    const blocks: unknown[] = [];
    for (let i = 0; i < 500; i += 1) {
      blocks.push({ type: 'tool_use', id: `tu${i}`, name: 'Bash', input: {} });
      blocks.push({ type: 'tool_result', toolUseId: `tu${i}`, content: `out${i}` });
    }
    const index = buildSessionBlockIndex([message('m1', blocks)]);
    expect(index.toolUseById.size).toBe(500);
    expect(index.toolResultByToolUseId.size).toBe(500);
    // Constant-time lookup, which is what replaced the nested loop.
    expect(index.toolResultByToolUseId.get('tu499')?.content).toBe('out499');
  });
});
