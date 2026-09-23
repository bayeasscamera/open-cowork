import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, fn),
  },
}));
vi.mock('../src/main/utils/logger', () => ({ log: vi.fn(), logError: vi.fn() }));

import { registerModelRoutingIpcHandlers } from '../src/main/ipc/model-routing-handlers';
import { ModelBenchmarkStore } from '../src/main/agent/model-benchmark';
import type { ModelBenchmark, ModelProfile, RegistryValidation, RoutingDecision } from '../src/shared/model-routing-types';

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error('no handler for ' + channel);
  return handler({}, ...args);
};

describe('model-routing-ipc-handlers', () => {
  let benchmarks: ModelBenchmarkStore;

  beforeEach(() => {
    mocks.handlers.clear();
    benchmarks = new ModelBenchmarkStore();
    registerModelRoutingIpcHandlers({ benchmarks });
  });

  it('registers the full model routing channel surface', () => {
    expect(Array.from(mocks.handlers.keys()).sort()).toEqual([
      'modelRouting.benchmarks',
      'modelRouting.clearBenchmarks',
      'modelRouting.probeLocal',
      'modelRouting.profiles',
      'modelRouting.recordBenchmark',
      'modelRouting.route',
      'modelRouting.validateRegistry',
    ]);
  });

  it('exposes the four profiles', async () => {
    const profiles = (await invoke('modelRouting.profiles')) as ModelProfile[];
    expect(profiles.map((profile) => profile.id)).toEqual(['fast', 'balanced', 'strong', 'local']);
    expect(profiles[0].capabilities).toBeDefined();
  });

  it('routes a task and validates the request', async () => {
    const decision = (await invoke('modelRouting.route', { taskKind: 'review' })) as RoutingDecision;
    expect(decision.profileId).toBe('strong');
    expect(decision.reason).toContain('recommended for review');
    expect(decision.fallbacks.length).toBe(3);

    await expect(invoke('modelRouting.route', { taskKind: 'nope' })).rejects.toThrow(
      'Unknown task kind'
    );
    await expect(
      invoke('modelRouting.route', { taskKind: 'review', preferredProfile: 'nope' })
    ).rejects.toThrow('Unknown model profile');
  });

  it('restricts confidential routing to local models', async () => {
    const decision = (await invoke('modelRouting.route', {
      taskKind: 'review',
      confidential: true,
    })) as RoutingDecision;
    expect(decision.local).toBe(true);
    expect(decision.profileId).toBe('local');
  });

  it('records and lists local benchmarks', async () => {
    expect(await invoke('modelRouting.benchmarks')).toEqual([]);

    const recorded = (await invoke('modelRouting.recordBenchmark', {
      modelId: 'claude-sonnet-4-6',
      taskKind: 'implementation',
      success: true,
      latencyMs: 1200,
      costUsd: 0.02,
    })) as ModelBenchmark;
    expect(recorded).toMatchObject({ runs: 1, successes: 1, avgCostUsd: 0.02 });

    const listed = (await invoke('modelRouting.benchmarks', 'claude-sonnet-4-6')) as ModelBenchmark[];
    expect(listed).toHaveLength(1);
    expect(await invoke('modelRouting.clearBenchmarks')).toEqual({ cleared: 1 });

    await expect(
      invoke('modelRouting.recordBenchmark', { modelId: '', taskKind: 'general' })
    ).rejects.toThrow('Benchmark model id must be a non-empty string.');
    await expect(
      invoke('modelRouting.recordBenchmark', { modelId: 'm', taskKind: 'nope' })
    ).rejects.toThrow('Unknown task kind');
  });

  it('validates registry entries', async () => {
    const accepted = (await invoke('modelRouting.validateRegistry', {
      repoId: 'org/model-GGUF',
    })) as RegistryValidation;
    expect(accepted.valid).toBe(true);
    expect(accepted.suggestedProfile).toBe('local');

    const rejected = (await invoke('modelRouting.validateRegistry', {
      repoId: 'org/model',
      url: 'https://evil.example.com/model',
    })) as RegistryValidation;
    expect(rejected.valid).toBe(false);
    expect(rejected.reasons[0]).toContain('not an allowlisted registry');
  });

  it('refuses an unknown local provider without probing', async () => {
    await expect(invoke('modelRouting.probeLocal', 'nope')).rejects.toThrow(
      'Unknown local provider'
    );
  });

  it('probes every local provider when no kind is given', async () => {
    const probes = (await invoke('modelRouting.probeLocal')) as Array<{ kind: string }>;
    expect(probes.map((probe) => probe.kind)).toEqual([
      'ollama',
      'lm-studio',
      'vllm',
      'openai-compatible',
    ]);
  });
});
