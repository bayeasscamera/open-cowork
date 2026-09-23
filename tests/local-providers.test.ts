import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROVIDER_PRESETS,
  isLocalBaseUrl,
  parseModelList,
  presetForKind,
  probeAllLocalProviders,
  probeLocalProvider,
} from '../src/main/agent/local-providers';

const jsonResponse = (payload: unknown, ok = true, status = 200) =>
  ({
    ok,
    status,
    json: async () => payload,
  }) as Response;

describe('isLocalBaseUrl', () => {
  it('accepts loopback only', () => {
    expect(isLocalBaseUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLocalBaseUrl('http://localhost:1234')).toBe(true);
    expect(isLocalBaseUrl('http://[::1]:8000')).toBe(true);
    expect(isLocalBaseUrl('http://192.168.1.10:11434')).toBe(false);
    expect(isLocalBaseUrl('https://example.com')).toBe(false);
    expect(isLocalBaseUrl('ftp://127.0.0.1')).toBe(false);
    expect(isLocalBaseUrl('not-a-url')).toBe(false);
  });
});

describe('presets and parsing', () => {
  it('exposes the four local providers', () => {
    expect(LOCAL_PROVIDER_PRESETS.map((preset) => preset.kind)).toEqual([
      'ollama',
      'lm-studio',
      'vllm',
      'openai-compatible',
    ]);
    expect(presetForKind('ollama')?.modelsPath).toBe('/api/tags');
    expect(presetForKind('nope' as never)).toBeNull();
  });

  it('parses Ollama and OpenAI model lists', () => {
    expect(parseModelList('ollama', { models: [{ name: 'llama3' }, { name: 'qwen' }, {}] })).toEqual([
      'llama3',
      'qwen',
    ]);
    expect(parseModelList('openai', { data: [{ id: 'a' }, { id: 'b' }, {}] })).toEqual(['a', 'b']);
    expect(parseModelList('openai', null)).toEqual([]);
    expect(parseModelList('ollama', { models: 'nope' })).toEqual([]);
  });
});

describe('probeLocalProvider', () => {
  it('returns the models of a reachable server', async () => {
    const probe = await probeLocalProvider('ollama', {
      fetchImpl: (async () => jsonResponse({ models: [{ name: 'llama3' }] })) as unknown as typeof fetch,
    });
    expect(probe).toEqual({
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      reachable: true,
      models: ['llama3'],
    });
  });

  it('refuses a non-loopback address without calling fetch', async () => {
    let called = false;
    const probe = await probeLocalProvider('vllm', {
      baseUrl: 'http://10.0.0.5:8000',
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(probe.reachable).toBe(false);
    expect(probe.error).toBe('Refusing to probe a non-loopback address.');
  });

  it('reports HTTP errors and network failures as data', async () => {
    const httpError = await probeLocalProvider('lm-studio', {
      fetchImpl: (async () => jsonResponse({}, false, 500)) as unknown as typeof fetch,
    });
    expect(httpError).toMatchObject({ reachable: false, error: 'HTTP 500' });

    const thrown = await probeLocalProvider('lm-studio', {
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });
    expect(thrown).toMatchObject({ reachable: false, error: 'connection refused' });
  });

  it('times out a hanging server', async () => {
    const probe = await probeLocalProvider('ollama', {
      timeoutMs: 200,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch,
    });
    expect(probe.reachable).toBe(false);
    expect(probe.error).toBe('aborted');
  });

  it('probes every preset', async () => {
    const probes = await probeAllLocalProviders({
      fetchImpl: (async () => jsonResponse({ data: [] })) as unknown as typeof fetch,
    });
    expect(probes).toHaveLength(4);
    expect(probes.every((probe) => probe.reachable)).toBe(true);
  });
});
