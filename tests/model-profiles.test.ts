import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL_PROFILES,
  inferCapabilities,
  isProfileEligible,
  profileById,
  profilesForTaskKind,
  rankProfiles,
  routeModel,
  scoreProfile,
} from '../src/main/agent/model-profiles';
import type { ModelBenchmark, ModelProfile } from '../src/shared/model-routing-types';

const profile = (id: ModelProfile['id']): ModelProfile => {
  const found = profileById(id);
  if (!found) throw new Error('missing profile ' + id);
  return found;
};

describe('DEFAULT_MODEL_PROFILES', () => {
  it('ships the four profiles the plan asks for', () => {
    expect(DEFAULT_MODEL_PROFILES.map((entry) => entry.id)).toEqual([
      'fast',
      'balanced',
      'strong',
      'local',
    ]);
    expect(profile('local').capabilities.local).toBe(true);
    expect(profile('fast').capabilities.local).toBe(false);
  });

  it('lists the profiles recommended for a task kind', () => {
    expect(profilesForTaskKind('review').map((entry) => entry.id)).toEqual(['strong']);
    expect(profileById('nope' as never)).toBeNull();
  });
});

describe('inferCapabilities', () => {
  it('detects local models from their id', () => {
    expect(inferCapabilities('ollama/qwen2.5-coder:7b').local).toBe(true);
    expect(inferCapabilities('qwen2.5-coder:7b').local).toBe(true);
    expect(inferCapabilities('anthropic/claude-sonnet-4-6').local).toBe(false);
  });

  it('detects vision and context windows', () => {
    const claude = inferCapabilities('anthropic/claude-sonnet-4-6');
    expect(claude.vision).toBe(true);
    expect(claude.contextWindow).toBe(200_000);

    expect(inferCapabilities('openai/gpt-4o').vision).toBe(true);
    expect(inferCapabilities('meta/llama-3-8b').vision).toBe(false);
    expect(inferCapabilities('some/1m-model').contextWindow).toBe(1_000_000);
    expect(inferCapabilities('some/32k-model').contextWindow).toBe(32_768);
  });

  it('flags non-chat models and honours overrides', () => {
    expect(inferCapabilities('openai/text-embedding-3-large').tools).toBe(false);
    expect(inferCapabilities('anthropic/claude-sonnet-4-6', { vision: false }).vision).toBe(false);
  });
});

describe('isProfileEligible', () => {
  it('enforces confidentiality, capabilities and budgets', () => {
    expect(isProfileEligible(profile('fast'), { taskKind: 'general', confidential: true })).toEqual({
      eligible: false,
      reasons: ['requires a local model'],
    });
    expect(isProfileEligible(profile('local'), { taskKind: 'general', confidential: true }).eligible).toBe(
      true
    );
    expect(
      isProfileEligible(profile('local'), { taskKind: 'general', requiresVision: true }).reasons
    ).toEqual(['model has no vision support']);
    expect(
      isProfileEligible(profile('strong'), { taskKind: 'general', maxCostTier: 2 }).reasons
    ).toEqual(['cost tier 4 above the limit']);
    expect(
      isProfileEligible(profile('local'), { taskKind: 'general', minContextWindow: 100_000 }).reasons
    ).toEqual(['context window below 100000']);
  });
});

describe('scoreProfile and rankProfiles', () => {
  it('rewards recommendation, preference and benchmarks, and penalizes cost', () => {
    expect(scoreProfile(profile('balanced'), { taskKind: 'implementation' })).toBe(1.5);
    expect(scoreProfile(profile('strong'), { taskKind: 'implementation' })).toBe(-1.5);
    expect(
      scoreProfile(profile('fast'), { taskKind: 'review', preferredProfile: 'fast' })
    ).toBe(3);
  });

  it('ranks eligible profiles deterministically', () => {
    const ranked = rankProfiles({ taskKind: 'review' }).map((entry) => entry.id);
    expect(ranked[0]).toBe('strong');
    expect(ranked).toHaveLength(4);
  });
});

describe('routeModel', () => {
  it('prefers the local profile for implementation (local-first)', () => {
    const decision = routeModel({ taskKind: 'implementation' });
    expect(decision).toMatchObject({ profileId: 'local', provider: 'ollama', local: true });
    expect(decision.reason).toContain('recommended for implementation');
    expect(decision.reason).toContain('runs locally');
    expect(decision.fallbacks.length).toBe(3);
  });

  it('prefers the strong profile for review', () => {
    expect(routeModel({ taskKind: 'review' }).profileId).toBe('strong');
  });

  it('honours an explicit preferred profile', () => {
    const decision = routeModel({ taskKind: 'review', preferredProfile: 'fast' });
    expect(decision.profileId).toBe('fast');
    expect(decision.reason).toContain('preferred profile');
  });

  it('lets a benchmark outrank the default recommendation', () => {
    const benchmarks: ModelBenchmark[] = [
      {
        modelId: 'claude-sonnet-4-6',
        taskKind: 'implementation',
        runs: 3,
        successes: 3,
        avgLatencyMs: 1000,
        avgCostUsd: 0.02,
        score: 1,
      },
    ];
    const decision = routeModel({ taskKind: 'implementation' }, DEFAULT_MODEL_PROFILES, benchmarks);
    expect(decision.profileId).toBe('balanced');
    expect(decision.reason).toContain('100% success over 3 runs');
    expect(decision.estimatedCostUsd).toBe(0.02);
  });

  it('restricts confidential work to local models', () => {
    expect(routeModel({ taskKind: 'review', confidential: true }).profileId).toBe('local');
  });

  it('respects cost and context budgets', () => {
    expect(routeModel({ taskKind: 'review', maxCostTier: 1 }).profileId).toBe('fast');
    expect(routeModel({ taskKind: 'implementation', minContextWindow: 100_000 }).profileId).toBe(
      'balanced'
    );
  });

  it('throws when nothing is eligible', () => {
    expect(() =>
      routeModel({ taskKind: 'general', confidential: true, requiresVision: true })
    ).toThrow('No model profile matches the request constraints.');
  });
});
