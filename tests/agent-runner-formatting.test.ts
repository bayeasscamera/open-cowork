/**
 * Tests for the agent-runner formatting helpers (log summaries, error text and
 * token-usage normalisation), extracted from CoworkAgentRunner.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeTokenUsage,
  safeStringify,
  summarizeMessageForLog,
  toErrorText,
} from '../src/main/agent/agent-runner-formatting';

describe('safeStringify', () => {
  it('serializes plain values', () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
  });

  it('honours the indentation argument', () => {
    expect(safeStringify({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
  });

  it('survives circular references', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(safeStringify(circular)).toContain('[Unserializable:');
  });

  it('survives BigInt values', () => {
    expect(safeStringify(1n)).toContain('[Unserializable:');
  });

  it('always returns a string for values JSON.stringify drops', () => {
    expect(safeStringify(undefined)).toBe('undefined');
    expect(safeStringify(() => undefined)).toContain('=>');
  });
});

describe('summarizeMessageForLog', () => {
  it('marks non-objects as absent', () => {
    expect(summarizeMessageForLog(null)).toEqual({ present: false });
    expect(summarizeMessageForLog(undefined)).toEqual({ present: false });
    expect(summarizeMessageForLog('assistant')).toEqual({ present: false });
    expect(summarizeMessageForLog(42)).toEqual({ present: false });
  });

  it('summarizes an SDK message', () => {
    const summary = summarizeMessageForLog({
      role: 'assistant',
      stopReason: 'end_turn',
      content: [{ type: 'text' }, 'raw', 42, null, {}],
      usage: { input_tokens: 3, output_tokens: 5 },
    });

    expect(summary).toEqual({
      present: true,
      role: 'assistant',
      stopReason: 'end_turn',
      contentBlocks: 5,
      contentTypes: ['text', 'string', 'number', 'object', 'unknown'],
      usage: { input: 3, output: 5 },
    });
  });

  it('uses undefined for a non-string role and a missing stop reason', () => {
    const summary = summarizeMessageForLog({ role: 7, content: 'not-an-array' });

    expect(summary.role).toBeUndefined();
    expect(summary.stopReason).toBeUndefined();
    expect(summary.contentBlocks).toBe(0);
    expect(summary.contentTypes).toEqual([]);
    expect(summary.usage).toBeUndefined();
  });

  it('only keeps the first eight content types', () => {
    const content = Array.from({ length: 12 }, () => ({ type: 'text' }));
    const summary = summarizeMessageForLog({ content });

    expect(summary.contentBlocks).toBe(12);
    expect(summary.contentTypes).toHaveLength(8);
  });
});

describe('toErrorText', () => {
  it('reads the message of an Error', () => {
    expect(toErrorText(new Error('boom'))).toBe('boom');
  });

  it('passes strings through', () => {
    expect(toErrorText('plain failure')).toBe('plain failure');
  });

  it('reads a message property from a plain object', () => {
    expect(toErrorText({ message: 'from object' })).toBe('from object');
  });

  it('serializes an object without a usable message', () => {
    expect(toErrorText({ message: '   ' })).toBe('{"message":"   "}');
    expect(toErrorText({ code: 'ENOENT' })).toBe('{"code":"ENOENT"}');
  });

  it('stringifies primitives', () => {
    expect(toErrorText(42)).toBe('42');
    expect(toErrorText(null)).toBe('null');
  });

  it('never throws on undefined', () => {
    expect(toErrorText(undefined)).toBe('undefined');
  });

  it('falls back to String() when the value cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(toErrorText(circular)).toBe('[object Object]');
  });
});

describe('normalizeTokenUsage', () => {
  it('rejects non-object usage', () => {
    expect(normalizeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeTokenUsage(null)).toBeUndefined();
    expect(normalizeTokenUsage(12)).toBeUndefined();
    expect(normalizeTokenUsage('1/2')).toBeUndefined();
  });

  it('reads plain input/output', () => {
    expect(normalizeTokenUsage({ input: 10, output: 20 })).toEqual({ input: 10, output: 20 });
  });

  it('reads snake_case usage', () => {
    expect(normalizeTokenUsage({ input_tokens: 1, output_tokens: 2 })).toEqual({
      input: 1,
      output: 2,
    });
  });

  it('reads camelCase usage', () => {
    expect(normalizeTokenUsage({ inputTokens: 5, outputTokens: 6 })).toEqual({
      input: 5,
      output: 6,
    });
  });

  it('prefers plain keys over aliases', () => {
    expect(
      normalizeTokenUsage({ input: 1, input_tokens: 99, output: 2, output_tokens: 99 })
    ).toEqual({ input: 1, output: 2 });
  });

  it('requires both counters to be numbers', () => {
    expect(normalizeTokenUsage({ input: 1 })).toBeUndefined();
    expect(normalizeTokenUsage({ output: 1 })).toBeUndefined();
    expect(normalizeTokenUsage({ input: '1', output: 2 })).toBeUndefined();
  });
});
