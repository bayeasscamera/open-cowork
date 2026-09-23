import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ROUTING_CASES,
  measureBenchmarkEffect,
  validateRoutingDecision,
  validateRoutingEndToEnd,
} from '../src/main/agent/routing-validation';
import { DEFAULT_MODEL_PROFILES, routeModel } from '../src/main/agent/model-profiles';
import type { ModelBenchmark, RoutingRequest } from '../src/shared/model-routing-types';

describe('validateRoutingEndToEnd', () => {
  it('accepts every default case against the shipped profiles', () => {
    const report = validateRoutingEndToEnd({ cases: DEFAULT_ROUTING_CASES, now: () => 7 });
    expect(report.ok).toBe(true);
    expect(report.checkedAt).toBe(7);
    expect(report.outcomes).toHaveLength(DEFAULT_ROUTING_CASES.length);
    expect(report.outcomes.every((outcome) => outcome.violations.length === 0)).toBe(true);
  });

  it('pins the cases that carry an explicit expectation', () => {
    const report = validateRoutingEndToEnd({ cases: DEFAULT_ROUTING_CASES });
    const byId = new Map(report.outcomes.map((outcome) => [outcome.caseId, outcome.decision]));
    expect(byId.get('confidential-local-only')?.profileId).toBe('local');
    expect(byId.get('confidential-local-only')?.local).toBe(true);
    expect(byId.get('preferred-profile-honoured')?.profileId).toBe('strong');
  });

  it('reports a violation when the decision names the wrong model', () => {
    const request: RoutingRequest = { taskKind: 'implementation', requiresTools: true };
    const decision = routeModel(request);
    const violations = validateRoutingDecision(
      request,
      { ...decision, model: 'not-the-model' },
      DEFAULT_MODEL_PROFILES,
      []
    );
    expect(violations.join(' ')).toContain('but profile');
  });

  it('reports a violation when a fallback is unknown', () => {
    const request: RoutingRequest = { taskKind: 'review' };
    const decision = routeModel(request);
    const violations = validateRoutingDecision(request, {
      ...decision,
      fallbacks: ['ghost/model'],
    });
    expect(violations.join(' ')).toContain('not a known profile');
  });

  it('flags a confidential request routed to a non-local model', () => {
    const request: RoutingRequest = {
      taskKind: 'implementation',
      requiresTools: true,
      confidential: true,
    };
    const decision = routeModel(request);
    const violations = validateRoutingDecision(request, { ...decision, local: false });
    expect(violations).toContain(
      'request is confidential but the chosen model is not local'
    );
  });

  it('fails the case when the expected profile is not chosen', () => {
    const report = validateRoutingEndToEnd({
      cases: [
        {
          id: 'forced',
          description: 'must land on the local profile',
          request: { taskKind: 'general' },
          expectedProfileId: 'local',
        },
      ],
    });
    expect(report.ok).toBe(false);
    expect(report.outcomes[0].violations.join(' ')).toContain('expected profile "local"');
  });
});

describe('measureBenchmarkEffect', () => {
  const benchmark = (modelId: string): ModelBenchmark => ({
    modelId,
    taskKind: 'review',
    success: true,
    latencyMs: 1200,
    recordedAt: 1,
  });

  it('shows that local evidence can move the choice', () => {
    const request: RoutingRequest = { taskKind: 'review', requiresTools: true };
    const baseline = routeModel(request);
    const strong = DEFAULT_MODEL_PROFILES.find((profile) => profile.id === 'strong');
    if (!strong) {
      throw new Error('the strong profile must exist');
    }

    const effect = measureBenchmarkEffect(request, strong.model, [benchmark(strong.model)]);
    expect(effect.taskKind).toBe('review');
    expect(effect.modelId).toBe(strong.model);
    expect(effect.withoutBenchmark).toBe(baseline.profileId);
    expect(typeof effect.changed).toBe('boolean');
  });

  it('never changes the choice for an irrelevant benchmark', () => {
    const request: RoutingRequest = { taskKind: 'review', requiresTools: true };
    const effect = measureBenchmarkEffect(request, 'ghost/model', []);
    expect(effect.changed).toBe(false);
    expect(effect.withBenchmark).toBe(effect.withoutBenchmark);
  });
});
