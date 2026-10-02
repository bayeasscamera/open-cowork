import { describe, expect, it, beforeEach } from 'vitest';

import {
  estimateTextTokens,
  getLearnedContextLimit,
  parseUpstreamContextLimit,
  recordLearnedContextLimit,
  resetLearnedContextLimits,
  resolveEffectiveContextWindow,
  shouldRefusePromptPreflight,
} from '../src/main/agent/learned-context-limits';

beforeEach(() => {
  resetLearnedContextLimits();
});

describe('parseUpstreamContextLimit', () => {
  it('parses the relay phrasing from the reported 400', () => {
    expect(
      parseUpstreamContextLimit(
        'Upstream rejected the request (400). Raw error: 400 Input exceeds context window ' +
          'for opencode-go/space-bunny-free: estimated 201274 input tokens, limit 200000.'
      )
    ).toBe(200000);
  });

  it('parses "tokens > N maximum" and "maximum context length is N"', () => {
    expect(parseUpstreamContextLimit('prompt is too long: 250000 tokens > 200000 maximum')).toBe(
      200000
    );
    expect(
      parseUpstreamContextLimit("This model's maximum context length is 8192 tokens")
    ).toBe(8192);
  });

  it('returns undefined when no plausible limit is present', () => {
    expect(parseUpstreamContextLimit('401 unauthorized')).toBeUndefined();
    expect(parseUpstreamContextLimit('')).toBeUndefined();
    expect(parseUpstreamContextLimit('limit banana')).toBeUndefined();
  });

  it('rejects implausible numbers instead of poisoning the store', () => {
    expect(parseUpstreamContextLimit('limit 12')).toBeUndefined();
    expect(parseUpstreamContextLimit('limit 99999999999')).toBeUndefined();
  });
});

describe('learned limit store', () => {
  it('records and reads back a limit per model id', () => {
    recordLearnedContextLimit('opencode-go/space-bunny-free', 200000);
    expect(getLearnedContextLimit('opencode-go/space-bunny-free')).toBe(200000);
    expect(getLearnedContextLimit('other/model')).toBeUndefined();
  });

  it('keys are case-insensitive and trimmed', () => {
    recordLearnedContextLimit('  OpenCode-Go/Space-Bunny-Free ', 200000);
    expect(getLearnedContextLimit('opencode-go/space-bunny-free')).toBe(200000);
  });

  it('keeps the smallest observed limit (safe belief wins)', () => {
    recordLearnedContextLimit('m', 200000);
    recordLearnedContextLimit('m', 128000);
    expect(getLearnedContextLimit('m')).toBe(128000);
    recordLearnedContextLimit('m', 500000);
    expect(getLearnedContextLimit('m')).toBe(128000);
  });

  it('ignores empty ids and insane limits without throwing', () => {
    expect(() => {
      recordLearnedContextLimit('', 200000);
      recordLearnedContextLimit(undefined, 200000);
      recordLearnedContextLimit('m', undefined);
      recordLearnedContextLimit('m', 42);
    }).not.toThrow();
    expect(getLearnedContextLimit('m')).toBeUndefined();
  });
});

describe('resolveEffectiveContextWindow', () => {
  it('prefers the learned ground truth over a fictive configured window', () => {
    recordLearnedContextLimit('opencode-go/space-bunny-free', 200000);
    expect(
      resolveEffectiveContextWindow({
        modelId: 'opencode-go/space-bunny-free',
        configuredWindow: 1_000_000,
        fallbackWindow: 128000,
      })
    ).toBe(200000);
  });

  it('treats an explicit user setting as a cap even without learning', () => {
    expect(
      resolveEffectiveContextWindow({
        modelId: 'unknown/model',
        configuredWindow: 180000,
        fallbackWindow: 128000,
      })
    ).toBe(180000);
  });

  it('falls back when nothing is known, never returning <= 0', () => {
    expect(
      resolveEffectiveContextWindow({ modelId: 'unknown/model', fallbackWindow: 128000 })
    ).toBe(128000);
    expect(
      resolveEffectiveContextWindow({
        modelId: 'unknown/model',
        configuredWindow: 0,
        fallbackWindow: 0,
      })
    ).toBe(128_000);
  });
});

describe('pre-flight guard', () => {
  it('estimates ~chars/4 tokens', () => {
    expect(estimateTextTokens('abcd')).toBe(1);
    expect(estimateTextTokens('a'.repeat(400))).toBe(100);
    expect(estimateTextTokens('')).toBe(0);
  });

  it('refuses only when the prompt alone already exceeds the window', () => {
    expect(
      shouldRefusePromptPreflight({ estimatedTokens: 200001, effectiveWindow: 200000 })
    ).toBe(true);
    expect(
      shouldRefusePromptPreflight({ estimatedTokens: 200000, effectiveWindow: 200000 })
    ).toBe(false);
    expect(
      shouldRefusePromptPreflight({ estimatedTokens: 50000, effectiveWindow: 200000 })
    ).toBe(false);
  });

  it('never refuses on a degenerate window', () => {
    expect(shouldRefusePromptPreflight({ estimatedTokens: 10_000_000, effectiveWindow: 0 })).toBe(
      false
    );
  });
});
