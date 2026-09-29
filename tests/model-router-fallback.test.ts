import { describe, expect, it } from 'vitest';

import { DynamicModelRouter } from '../src/main/agent/model-router';

function rateLimitError(): Error {
  const error = new Error(
    "429 You've used this campaign's own allowance. Use the paid model 'qwen3.8-flash' to keep going."
  );
  (error as { status?: number }).status = 429;
  return error;
}

describe('DynamicModelRouter.executeWithFallback', () => {
  it('returns the first endpoint without a fallback attempt', async () => {
    const router = new DynamicModelRouter([
      { provider: 'a', baseUrl: 'https://a.test', apiKey: 'k', model: 'm', priority: 1 },
    ]);
    const result = await router.executeWithFallback(async () => 'ok');
    expect(result.result).toBe('ok');
    expect(result.fallbacksAttempted).toBe(0);
  });

  it('retries a rate limit on the next endpoint', async () => {
    const seen: string[] = [];
    const router = new DynamicModelRouter([
      { provider: 'a', baseUrl: 'https://a.test', apiKey: 'k', model: 'm', priority: 1 },
      { provider: 'b', baseUrl: 'https://b.test', apiKey: 'k', model: 'm', priority: 2 },
    ]);
    const result = await router.executeWithFallback(async (endpoint) => {
      seen.push(endpoint.provider);
      if (endpoint.provider === 'a') {
        throw rateLimitError();
      }
      return 'recovered';
    });
    expect(seen).toEqual(['a', 'b']);
    expect(result.result).toBe('recovered');
    expect(result.usedEndpoint.provider).toBe('b');
    expect(result.fallbacksAttempted).toBe(1);
  });

  it('does not retry an auth failure', async () => {
    const seen: string[] = [];
    const router = new DynamicModelRouter([
      { provider: 'a', baseUrl: 'https://a.test', apiKey: 'k', model: 'm', priority: 1 },
      { provider: 'b', baseUrl: 'https://b.test', apiKey: 'k', model: 'm', priority: 2 },
    ]);
    await expect(
      router.executeWithFallback(async (endpoint) => {
        seen.push(endpoint.provider);
        throw new Error('401 unauthorized: invalid api key');
      })
    ).rejects.toThrow('401 unauthorized');
    expect(seen).toEqual(['a']);
  });

  it('throws when every endpoint is rate limited', async () => {
    const router = new DynamicModelRouter([
      { provider: 'a', baseUrl: 'https://a.test', apiKey: 'k', model: 'm', priority: 1 },
      { provider: 'b', baseUrl: 'https://b.test', apiKey: 'k', model: 'm', priority: 2 },
    ]);
    await expect(
      router.executeWithFallback(async () => {
        throw rateLimitError();
      })
    ).rejects.toThrow('2 routes testées');
  });
});
