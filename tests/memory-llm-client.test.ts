import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runPiAiOneShotMock = vi.hoisted(() => vi.fn());

vi.mock('../src/main/agent/sdk-one-shot', () => ({
  runPiAiOneShot: runPiAiOneShotMock,
}));

import type { AppConfig } from '../src/main/config/config-store';
import { MemoryLLMClient } from '../src/main/memory/memory-llm-client';

function makeConfig(timeoutMs: number): AppConfig {
  return {
    provider: 'custom',
    customProtocol: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    activeProfileKey: 'custom:openai',
    profiles: {},
    activeConfigSetId: 'default',
    configSets: [],
    agentCliPath: '',
    defaultWorkdir: '',
    globalSkillsPath: '',
    enableDevLogs: false,
    theme: 'light',
    sandboxEnabled: false,
    memoryEnabled: true,
    memoryRuntime: {
      llm: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: '',
        timeoutMs,
      },
      embedding: {
        inheritFromActive: true,
        apiKey: '',
        baseUrl: '',
        model: 'text-embedding-3-small',
        timeoutMs: 180000,
      },
      useEmbedding: false,
      maxNavSteps: 2,
      ingestionConcurrency: 4,
      storageRoot: '',
      evalEnabled: false,
      evalWorkspaces: [],
      evalMaxRounds: 12,
      evalArtifactsRoot: '',
      promptIterationRounds: 2,
    },
    enableThinking: false,
    isConfigured: true,
  };
}

function withMemoryModel(config: AppConfig, model: string): AppConfig {
  const runtime = config.memoryRuntime;
  if (!runtime) throw new Error('fixture must define memoryRuntime');
  return { ...config, memoryRuntime: { ...runtime, llm: { ...runtime.llm, model } } };
}

describe('MemoryLLMClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runPiAiOneShotMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const configAt = (index: number) =>
    runPiAiOneShotMock.mock.calls[index]?.[2] as { model: string } | undefined;

  it('aborts one-shot completions with the configured memory LLM timeout', async () => {
    let signal: AbortSignal | undefined;
    runPiAiOneShotMock.mockImplementation((_prompt, _systemPrompt, _config, options) => {
      signal = options?.signal;
      return new Promise(() => undefined);
    });

    const client = new MemoryLLMClient(() => makeConfig(5000));
    const completion = client
      .complete({
        systemPrompt: 'memory system',
        userPrompt: 'memory user',
      })
      .then(
        () => null,
        (error: unknown) => error as Error
      );

    await vi.advanceTimersByTimeAsync(4999);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    const error = await completion;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Memory LLM request timed out after 5000ms');
  });

  it('falls back to the active model when the configured memory model denies access', async () => {
    runPiAiOneShotMock
      .mockRejectedValueOnce(
        new Error('403 This token has no access to model @cf/qwen/qwen3.8-27b (request id: r1)')
      )
      .mockResolvedValueOnce({ text: 'recovered', hasThinking: false, durationMs: 5 });
    const client = new MemoryLLMClient(() => withMemoryModel(makeConfig(5000), '@cf/qwen/qwen3.8-27b'));

    await expect(
      client.complete({ systemPrompt: 'memory system', userPrompt: 'memory user' })
    ).resolves.toEqual({ text: 'recovered' });

    expect(runPiAiOneShotMock).toHaveBeenCalledTimes(2);
    expect(configAt(0)?.model).toBe('@cf/qwen/qwen3.8-27b');
    expect(configAt(1)?.model).toBe('test-model');
  });

  it('bypasses a denied memory model until the breaker cooldown expires', async () => {
    runPiAiOneShotMock
      .mockRejectedValueOnce(new Error('403 This token has no access to model blocked-model'))
      .mockResolvedValue({ text: 'ok', hasThinking: false, durationMs: 1 });
    const client = new MemoryLLMClient(() => withMemoryModel(makeConfig(5000), 'blocked-model'), {
      cooldownMs: 60_000,
    });
    const complete = () => client.complete({ systemPrompt: 'memory system', userPrompt: 'u' });

    await complete();
    await complete();
    expect(runPiAiOneShotMock).toHaveBeenCalledTimes(3);
    expect(configAt(2)?.model).toBe('test-model');

    await vi.advanceTimersByTimeAsync(60_001);
    await complete();
    expect(runPiAiOneShotMock).toHaveBeenCalledTimes(4);
    expect(configAt(3)?.model).toBe('blocked-model');
  });

  it('propagates transient provider errors without falling back', async () => {
    runPiAiOneShotMock.mockRejectedValueOnce(
      new Error('429 You have reached the request limit: Maximum 5 requests within 1 minutes.')
    );
    const client = new MemoryLLMClient(() => withMemoryModel(makeConfig(5000), 'blocked-model'));

    await expect(client.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow('429');
    expect(runPiAiOneShotMock).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when the memory model already matches the active model', async () => {
    runPiAiOneShotMock.mockRejectedValueOnce(
      new Error('403 This token has no access to model test-model')
    );
    const client = new MemoryLLMClient(() => makeConfig(5000));

    await expect(client.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow('403');
    expect(runPiAiOneShotMock).toHaveBeenCalledTimes(1);
  });
});
