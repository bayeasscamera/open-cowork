/**
 * @module main/agent/routing-validation
 *
 * Cowork 4.0 — Phase 7.5: end-to-end validation of model routing.
 *
 * Routing is only trustworthy if the model it picked actually satisfies the
 * constraints, and if local benchmarks can move the choice. This module answers
 * both questions over a set of realistic requests, and reports every violation
 * instead of a single boolean.
 */

import type {
  ModelBenchmark,
  ModelProfile,
  ModelProfileId,
  RoutingDecision,
  RoutingRequest,
  TaskKind,
} from '../../shared/model-routing-types';
import type {
  RoutingValidationOutcome,
  RoutingValidationReport,
} from '../../shared/metrics-types';

export type { RoutingValidationOutcome, RoutingValidationReport } from '../../shared/metrics-types';
import {
  DEFAULT_MODEL_PROFILES,
  isProfileEligible,
  profileById,
  rankProfiles,
  routeModel,
} from './model-profiles';

export interface RoutingValidationCase {
  id: string;
  description: string;
  request: RoutingRequest;
  /** When set, the decision must land on this profile. */
  expectedProfileId?: ModelProfileId;
}

function modelStringOf(profile: ModelProfile): string {
  return profile.provider + '/' + profile.model;
}

/** Every way a routing decision can be wrong for a request. */
export function validateRoutingDecision(
  request: RoutingRequest,
  decision: RoutingDecision,
  profiles: readonly ModelProfile[] = DEFAULT_MODEL_PROFILES,
  benchmarks: readonly ModelBenchmark[] = []
): string[] {
  const violations: string[] = [];
  const profile = profileById(decision.profileId, profiles);
  if (!profile) {
    return ['unknown profile "' + decision.profileId + '"'];
  }
  if (profile.provider !== decision.provider || profile.model !== decision.model) {
    violations.push(
      'decision names ' +
        decision.provider +
        '/' +
        decision.model +
        ' but profile "' +
        profile.id +
        '" is ' +
        modelStringOf(profile)
    );
  }

  const eligibility = isProfileEligible(profile, request);
  if (!eligibility.eligible) {
    violations.push('chosen profile is not eligible: ' + eligibility.reasons.join('; '));
  }

  for (const fallback of decision.fallbacks) {
    const candidate = profiles.find((entry) => modelStringOf(entry) === fallback);
    if (!candidate) {
      violations.push('fallback "' + fallback + '" is not a known profile');
      continue;
    }
    const fallbackEligibility = isProfileEligible(candidate, request);
    if (!fallbackEligibility.eligible) {
      violations.push(
        'fallback "' + fallback + '" is not eligible: ' + fallbackEligibility.reasons.join('; ')
      );
    }
  }

  const ranked = rankProfiles(request, profiles, benchmarks);
  if (ranked.length > 0 && ranked[0].id !== decision.profileId) {
    violations.push(
      'profile "' + ranked[0].id + '" ranks above the chosen "' + decision.profileId + '"'
    );
  }

  if (request.confidential && !decision.local) {
    violations.push('request is confidential but the chosen model is not local');
  }

  return violations;
}

export interface RoutingValidationOptions {
  cases: readonly RoutingValidationCase[];
  profiles?: readonly ModelProfile[];
  benchmarks?: readonly ModelBenchmark[];
  now?: () => number;
}

/** Run every case and collect the violations. Never throws. */
export function validateRoutingEndToEnd(
  options: RoutingValidationOptions
): RoutingValidationReport {
  const profiles = options.profiles ?? DEFAULT_MODEL_PROFILES;
  const benchmarks = options.benchmarks ?? [];
  const now = options.now ?? (() => Date.now());
  const outcomes: RoutingValidationOutcome[] = [];

  for (const testCase of options.cases) {
    let decision: RoutingDecision;
    const violations: string[] = [];
    try {
      decision = routeModel(testCase.request, profiles, benchmarks);
    } catch (error: unknown) {
      outcomes.push({
        caseId: testCase.id,
        ok: false,
        decision: {
          profileId: 'fast',
          provider: '',
          model: '',
          reason: '',
          fallbacks: [],
          estimatedCostUsd: null,
          local: false,
        },
        violations: [error instanceof Error ? error.message : String(error)],
      });
      continue;
    }
    violations.push(...validateRoutingDecision(testCase.request, decision, profiles, benchmarks));
    if (testCase.expectedProfileId && decision.profileId !== testCase.expectedProfileId) {
      violations.push(
        'expected profile "' +
          testCase.expectedProfileId +
          '" but routing chose "' +
          decision.profileId +
          '"'
      );
    }
    outcomes.push({ caseId: testCase.id, ok: violations.length === 0, decision, violations });
  }

  return { ok: outcomes.every((outcome) => outcome.ok), outcomes, checkedAt: now() };
}

export interface BenchmarkRoutingEffect {
  taskKind: TaskKind;
  modelId: string;
  withoutBenchmark: ModelProfileId;
  withBenchmark: ModelProfileId;
  changed: boolean;
}

/**
 * Prove that a local benchmark actually influences routing: score a model
 * highly for a task kind and check whether the decision moved to it.
 */
export function measureBenchmarkEffect(
  request: RoutingRequest,
  benchmarkedModelId: string,
  benchmarks: readonly ModelBenchmark[],
  profiles: readonly ModelProfile[] = DEFAULT_MODEL_PROFILES
): BenchmarkRoutingEffect {
  const withoutBenchmark = routeModel(request, profiles, []);
  const withBenchmark = routeModel(request, profiles, benchmarks);
  return {
    taskKind: request.taskKind,
    modelId: benchmarkedModelId,
    withoutBenchmark: withoutBenchmark.profileId,
    withBenchmark: withBenchmark.profileId,
    changed: withoutBenchmark.profileId !== withBenchmark.profileId,
  };
}

/** A realistic, always-valid request per task kind, used by the test suite. */
export const DEFAULT_ROUTING_CASES: readonly RoutingValidationCase[] = [
  {
    id: 'exploration-needs-tools',
    description: 'Exploration with tools must never pick a model without tools.',
    request: { taskKind: 'exploration', requiresTools: true },
  },
  {
    id: 'implementation-needs-tools-and-json',
    description: 'Implementation requires tools and JSON mode.',
    request: { taskKind: 'implementation', requiresTools: true, requiresJson: true },
  },
  {
    id: 'review-cheap',
    description: 'Review under a cost ceiling stays within the ceiling.',
    request: { taskKind: 'review', requiresTools: true, maxCostTier: 2 },
  },
  {
    id: 'confidential-local-only',
    description: 'Confidential work must stay on a local model.',
    request: { taskKind: 'implementation', requiresTools: true, confidential: true },
    expectedProfileId: 'local',
  },
  {
    id: 'vision-request',
    description: 'A vision request must pick a vision-capable model.',
    request: { taskKind: 'general', requiresVision: true },
  },
  {
    id: 'preferred-profile-honoured',
    description: 'An explicit preference is honoured when eligible.',
    request: { taskKind: 'implementation', requiresTools: true, preferredProfile: 'strong' },
    expectedProfileId: 'strong',
  },
];
