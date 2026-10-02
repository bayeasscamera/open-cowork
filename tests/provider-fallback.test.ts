import { describe, expect, it } from 'vitest';

import {
  buildFallbackCandidates,
  classifyForFallback,
  selectOverflowFallback,
  shouldFallbackToProvider,
} from '../src/main/agent/provider-fallback';
import type { AppConfig } from '../src/main/config/config-store';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
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
    coworkInstructions: '',
    tavilyApiKey: '',
    braveApiKey: '',
    trayEnabled: false,
    enableThinking: false,
    isConfigured: true,
    ...overrides,
  } as AppConfig;
}

describe('shouldFallbackToProvider', () => {
  it('retries a rate limit with no tool side effects', () => {
    expect(
      shouldFallbackToProvider({ errorCode: 'rate_limited', toolExecutions: 0 })
    ).toBe(true);
  });

  it('retries gateway 5xx and network failures with no tool side effects', () => {
    expect(
      shouldFallbackToProvider({ errorCode: 'server_error', toolExecutions: 0 })
    ).toBe(true);
    expect(
      shouldFallbackToProvider({ errorCode: 'network_error', toolExecutions: 0 })
    ).toBe(true);
  });

  it('never replays a turn that ran tools', () => {
    expect(
      shouldFallbackToProvider({ errorCode: 'rate_limited', toolExecutions: 1 })
    ).toBe(false);
  });

  it('never replays aborted turns', () => {
    expect(
      shouldFallbackToProvider({ errorCode: 'rate_limited', toolExecutions: 0, aborted: true })
    ).toBe(false);
  });

  it('never replays auth, bad-request, timeout or empty-result failures', () => {
    for (const errorCode of [
      'auth_failed',
      'upstream_400',
      'timeout',
      'empty_result',
      'stream_error',
    ] as const) {
      expect(shouldFallbackToProvider({ errorCode, toolExecutions: 0 })).toBe(false);
    }
  });
});

describe('classifyForFallback', () => {
  it('classifies the gateway campaign-quota message as rate limited', () => {
    expect(
      classifyForFallback(
        "429 You've used this campaign's own allowance. Use the paid model 'qwen3.8-flash' to keep going."
      )
    ).toBe('rate_limited');
  });
});

describe('buildFallbackCandidates', () => {
  const sets = [
    { id: 'default', name: 'Default' },
    { id: 'backup', name: 'Backup' },
    { id: 'third', name: 'Third' },
  ];

  function projectSet(id: string) {
    return id === 'missing' ? undefined : makeConfig({ activeConfigSetId: id });
  }

  it('excludes the failed set and keeps declaration order', () => {
    const candidates = buildFallbackCandidates({
      configSets: sets,
      failedConfigSetId: 'default',
      projectSet,
      hasUsableCredentials: () => true,
    });
    expect(candidates.map((candidate) => candidate.configSetId)).toEqual(['backup', 'third']);
  });

  it('skips sets without usable credentials', () => {
    const candidates = buildFallbackCandidates({
      configSets: sets,
      failedConfigSetId: 'default',
      projectSet,
      hasUsableCredentials: (config) => config.activeConfigSetId !== 'backup',
    });
    expect(candidates.map((candidate) => candidate.configSetId)).toEqual(['third']);
  });

  it('skips sets that cannot be projected', () => {
    const candidates = buildFallbackCandidates({
      configSets: [...sets, { id: 'missing', name: 'Missing' }],
      failedConfigSetId: 'default',
      projectSet,
      hasUsableCredentials: () => true,
    });
    expect(candidates.map((candidate) => candidate.configSetId)).toEqual(['backup', 'third']);
  });

  it('caps the candidate list', () => {
    const candidates = buildFallbackCandidates({
      configSets: sets,
      failedConfigSetId: 'default',
      projectSet,
      hasUsableCredentials: () => true,
      maxCandidates: 1,
    });
    expect(candidates.map((candidate) => candidate.configSetId)).toEqual(['backup']);
  });

  it('returns nothing when only the failed set exists', () => {
    const candidates = buildFallbackCandidates({
      configSets: [{ id: 'default', name: 'Default' }],
      failedConfigSetId: 'default',
      projectSet,
      hasUsableCredentials: () => true,
    });
    expect(candidates).toEqual([]);
  });
});

describe('selectOverflowFallback', () => {
  it('picks the first candidate with a strictly larger window', () => {
    expect(
      selectOverflowFallback({
        failedWindow: 200_000,
        candidates: [
          { configSetId: 'same', window: 200_000 },
          { configSetId: 'small', window: 32_000 },
          { configSetId: 'big', window: 1_000_000 },
        ],
      })
    ).toEqual({ configSetId: 'big', window: 1_000_000 });
  });

  it('returns undefined when no candidate is larger (no double-bill)', () => {
    expect(
      selectOverflowFallback({
        failedWindow: 200_000,
        candidates: [
          { configSetId: 'same', window: 200_000 },
          { configSetId: 'small', window: 32_000 },
        ],
      })
    ).toBeUndefined();
    expect(selectOverflowFallback({ failedWindow: 200_000, candidates: [] })).toBeUndefined();
  });

  it('returns undefined for a degenerate failed window', () => {
    expect(
      selectOverflowFallback({
        failedWindow: 0,
        candidates: [{ configSetId: 'big', window: 1_000_000 }],
      })
    ).toBeUndefined();
  });
});
