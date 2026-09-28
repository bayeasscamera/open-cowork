import { describe, it, expect } from 'vitest';
import {
  isContextOverflowError,
  shouldRetryOnContextOverflow,
} from '../src/main/agent/context-overflow';

describe('context overflow detection', () => {
  it('recognises the upstream phrasings', () => {
    const samples = [
      'context_length_exceeded',
      'This model\'s maximum context length is 8192 tokens',
      'prompt is too long: 250000 tokens > 200000 maximum',
      'too many tokens',
      'reduce the length of the messages to fit into the context window',
      'input length and `max_tokens` exceed context limit',
    ];
    for (const sample of samples) {
      expect(isContextOverflowError(new Error(sample)), sample).toBe(true);
    }
  });

  it('does not mistake other failures for an overflow', () => {
    const samples = ['401 unauthorized', '429 rate limit', '500 internal error', 'ETIMEDOUT'];
    for (const sample of samples) {
      expect(isContextOverflowError(new Error(sample)), sample).toBe(false);
    }
  });

  it('reads the message of a non-Error throw', () => {
    expect(isContextOverflowError('context window exceeded')).toBe(true);
  });
});

describe('fallback decision on a context overflow', () => {
  const overflow = new Error('maximum context length is 8192 tokens');

  it('still falls back for failures a different model can fix', () => {
    expect(
      shouldRetryOnContextOverflow({ error: new Error('429 rate limit'), sourceWindow: 8_000, fallbackWindow: 8_000 })
    ).toEqual({ retry: true });
  });

  it('does NOT double-bill an overflow on an equal window', () => {
    expect(shouldRetryOnContextOverflow({ error: overflow, sourceWindow: 200_000, fallbackWindow: 200_000 }))
      .toEqual({ retry: false, reason: 'context_overflow_not_recoverable' });
  });

  it('does NOT double-bill an overflow on a SMALLER window', () => {
    expect(shouldRetryOnContextOverflow({ error: overflow, sourceWindow: 200_000, fallbackWindow: 32_000 }))
      .toEqual({ retry: false, reason: 'context_overflow_not_recoverable' });
  });

  it('DOES retry when the fallback model has a strictly larger window', () => {
    // The one case where the replay can genuinely succeed: the same work fits
    // in a bigger window.
    expect(shouldRetryOnContextOverflow({ error: overflow, sourceWindow: 32_000, fallbackWindow: 200_000 }))
      .toEqual({ retry: true });
  });

  it('errs on not spending the retry when a window is unknown', () => {
    expect(shouldRetryOnContextOverflow({ error: overflow, sourceWindow: 200_000 }))
      .toEqual({ retry: false, reason: 'context_overflow_not_recoverable' });
    expect(shouldRetryOnContextOverflow({ error: overflow, fallbackWindow: 200_000 }))
      .toEqual({ retry: false, reason: 'context_overflow_not_recoverable' });
  });
});
