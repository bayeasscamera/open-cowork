import { beforeEach, describe, expect, it, vi } from 'vitest';

// fetch is stubbed per-test; no other dependency.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {
  evaluateRoutingSignal,
  formatRoutingHint,
} from '../src/main/agent/openjev-router';

const ENABLED = { enabled: true, baseUrl: 'http://127.0.0.1:8080' };
const DISABLED = { enabled: false, baseUrl: 'http://127.0.0.1:8080' };

const okResponse = (answers: Record<string, unknown>) => ({
  ok: true,
  json: async () => ({
    model: 'openjev-0.1',
    answers,
    usage: { input_tokens: 42, output_tokens: 0 },
  }),
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe('openjev-router — advisory routing signal', () => {
  it('parses a verdict (noul + score) and measures its own latency', async () => {
    fetchMock.mockResolvedValueOnce(
      okResponse({
        needs_swarm: { noul: 0.85, confidence: 0.9 },
        complexity: { score: 1.4, confidence: 0.7 },
      })
    );
    const verdict = await evaluateRoutingSignal('Refactor the auth module', ENABLED);
    expect(verdict).toBeTruthy();
    expect(verdict!.needsSwarm).toBe(0.85);
    expect(verdict!.complexity).toBe(1.4);
    expect(verdict!.latencyMs).toBeLessThan(1500);
    // The exact audited wire shape was used.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8080/v1/systemone',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"needs_swarm"'),
      })
    );
  });

  it('returns null WITHOUT blocking when OpenJev is down (fallback path)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const started = Date.now();
    const verdict = await evaluateRoutingSignal('anything', ENABLED);
    expect(verdict).toBeNull();
    // Well under the 1500ms budget: a down server must never stall a turn.
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('is inert when disabled (no call at all)', async () => {
    const verdict = await evaluateRoutingSignal('anything', DISABLED);
    expect(verdict).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on a malformed response instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ answers: {} }) });
    expect(await evaluateRoutingSignal('x', ENABLED)).toBeNull();
  });

  it('aborts slow servers within the routing budget', async () => {
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted'))
          );
        })
    );
    const started = Date.now();
    expect(await evaluateRoutingSignal('x', ENABLED)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('routing hint formatting', () => {
  it('injects a clearly-marked advisory block with the leaning', () => {
    const hint = formatRoutingHint({
      needsSwarm: 0.85,
      complexity: 1.4,
      confidence: 0.9,
      latencyMs: 40,
    });
    expect(hint).toContain('<routing_hint source="openjev">');
    expect(hint).toContain('0.85');
    expect(hint).toContain('LIKELY warranted');
    expect(formatRoutingHint(null)).toBe('');
  });
});