import { describe, expect, it } from 'vitest';
import { ModelRoutingService, inferTaskKind } from '../src/main/agent/model-routing-service';
import { ModelBenchmarkStore } from '../src/main/agent/model-benchmark';

describe('inferTaskKind', () => {
  it('detects review work', () => {
    expect(inferTaskKind('Fais un audit de sécurité de ce module')).toBe('review');
    expect(inferTaskKind('Please review this pull request')).toBe('review');
  });

  it('detects implementation work', () => {
    expect(inferTaskKind('Implémente la phase 6')).toBe('implementation');
    expect(inferTaskKind('Fix the failing test')).toBe('implementation');
  });

  it('detects exploration work', () => {
    expect(inferTaskKind('Explique comment fonctionne le path resolver')).toBe('exploration');
    expect(inferTaskKind('Where is the session manager defined?')).toBe('exploration');
  });

  it('prefers the more specific signal on a tie', () => {
    expect(inferTaskKind('cherche le bug et corrige-le')).toBe('implementation');
  });

  it('falls back to general', () => {
    expect(inferTaskKind('')).toBe('general');
    expect(inferTaskKind('   ')).toBe('general');
    expect(inferTaskKind('Bonjour')).toBe('general');
  });
});

describe('ModelRoutingService', () => {
  it('is disabled by default so nothing changes implicitly', () => {
    const service = new ModelRoutingService();
    expect(service.state()).toEqual({ enabled: false, activeProfile: null });
    expect(
      service.resolveModel({ sessionId: 's', prompt: 'fix the bug', fallbackModel: 'm' })
    ).toBeUndefined();
  });

  it('selecting a profile is the opt-in', () => {
    const service = new ModelRoutingService();
    expect(service.setActiveProfile('fast')).toEqual({ enabled: true, activeProfile: 'fast' });
    expect(
      service.resolveModel({ sessionId: 's', prompt: 'fix the bug', fallbackModel: 'm' })
    ).toBe('claude-haiku-4-5');
  });

  it('clears the active profile without touching the switch', () => {
    const service = new ModelRoutingService();
    service.setActiveProfile('strong');
    expect(service.setActiveProfile(null)).toEqual({ enabled: true, activeProfile: null });
    expect(
      service.resolveModel({ sessionId: 's', prompt: 'fix', fallbackModel: 'm' })
    ).toBeUndefined();
  });

  it('can be switched off without losing the profile', () => {
    const service = new ModelRoutingService();
    service.setActiveProfile('balanced');
    expect(service.setEnabled(false)).toEqual({ enabled: false, activeProfile: 'balanced' });
    expect(
      service.resolveModel({ sessionId: 's', prompt: 'fix', fallbackModel: 'm' })
    ).toBeUndefined();
  });

  it('rejects an unknown profile', () => {
    const service = new ModelRoutingService();
    expect(() => service.setActiveProfile('nope' as never)).toThrow('Unknown model profile');
  });

  it('routes through the shared primitives', () => {
    const service = new ModelRoutingService();
    const decision = service.route({ taskKind: 'review' });
    expect(decision.profileId).toBe('strong');
    expect(decision.model).toBe('claude-opus-4-6');
  });

  it('records benchmarks that influence later routing', () => {
    const benchmarks = new ModelBenchmarkStore();
    const service = new ModelRoutingService({ benchmarks });
    service.recordBenchmark({
      modelId: 'qwen2.5-coder:7b',
      taskKind: 'general',
      success: true,
      latencyMs: 200,
    });
    expect(service.benchmarks.size()).toBe(1);
  });

  it('never throws out of resolveModel when no profile is eligible', () => {
    const service = new ModelRoutingService({
      profiles: [
        {
          id: 'fast',
          label: 'Fast',
          description: '',
          provider: 'anthropic',
          model: 'tiny',
          capabilities: {
            tools: false,
            vision: false,
            json: false,
            streaming: true,
            contextWindow: null,
            local: false,
          },
          costTier: 1,
          recommendedFor: [],
        },
      ],
    });
    service.setActiveProfile('fast');
    expect(
      service.resolveModel({ sessionId: 's', prompt: 'fix', fallbackModel: 'm' })
    ).toBeUndefined();
  });
});
