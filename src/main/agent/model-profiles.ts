/**
 * @module main/agent/model-profiles
 *
 * Cowork 4.0 — Phase 7: named model profiles (fast, balanced, strong, local) and
 * the deterministic router that picks one for a task. Capability inference is a
 * documented heuristic; benchmarks refine the choice when they exist.
 */

import type {
  ModelBenchmark,
  ModelCapabilities,
  ModelProfile,
  ModelProfileId,
  RoutingDecision,
  RoutingRequest,
  TaskKind,
} from '../../shared/model-routing-types';

export const DEFAULT_MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: 'fast',
    label: 'Fast',
    description: 'Cheap, quick turns for exploration and small edits',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    capabilities: {
      tools: true,
      vision: false,
      json: true,
      streaming: true,
      contextWindow: 200_000,
      local: false,
    },
    costTier: 1,
    recommendedFor: ['exploration', 'general'],
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Default implementation profile: good quality per dollar',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    capabilities: {
      tools: true,
      vision: true,
      json: true,
      streaming: true,
      contextWindow: 200_000,
      local: false,
    },
    costTier: 2,
    recommendedFor: ['implementation', 'general'],
  },
  {
    id: 'strong',
    label: 'Strong',
    description: 'Deep reasoning for adversarial review and hard debugging',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    capabilities: {
      tools: true,
      vision: true,
      json: true,
      streaming: true,
      contextWindow: 200_000,
      local: false,
    },
    costTier: 4,
    recommendedFor: ['review'],
  },
  {
    id: 'local',
    label: 'Local',
    description: 'Runs on this machine, no data leaves the workspace',
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    capabilities: {
      tools: true,
      vision: false,
      json: true,
      streaming: true,
      contextWindow: 32_768,
      local: true,
    },
    costTier: 1,
    recommendedFor: ['exploration', 'implementation'],
  },
];

/** Heuristic capability inference from a model id. */
export function inferCapabilities(
  modelId: string,
  overrides: Partial<ModelCapabilities> = {}
): ModelCapabilities {
  const id = modelId.toLowerCase();
  const hasProviderPrefix = id.includes('/');
  const localMarker = /(ollama|lm-?studio|gguf|vllm|q[45]_[k0])/.test(id);
  const contextWindow = /1m/.test(id)
    ? 1_000_000
    : /200k|claude/.test(id)
      ? 200_000
      : /128k/.test(id)
        ? 128_000
        : /32k/.test(id)
          ? 32_768
          : 8_192;

  const capabilities: ModelCapabilities = {
    tools: !/embed|rerank|whisper|tts/.test(id),
    vision: /vision|llava|pixtral|gpt-4o|gpt-4\.1|claude|gemini|qwen.*vl|minicpm-v/.test(id),
    json: true,
    streaming: true,
    contextWindow,
    local: localMarker || !hasProviderPrefix,
  };
  return { ...capabilities, ...overrides };
}

export function profileById(
  id: ModelProfileId,
  profiles: readonly ModelProfile[] = DEFAULT_MODEL_PROFILES
): ModelProfile | null {
  return profiles.find((profile) => profile.id === id) ?? null;
}

export interface Eligibility {
  eligible: boolean;
  reasons: string[];
}

export function isProfileEligible(profile: ModelProfile, request: RoutingRequest): Eligibility {
  const reasons: string[] = [];
  if (request.confidential && !profile.capabilities.local) {
    reasons.push('requires a local model');
  }
  if (request.requiresTools && !profile.capabilities.tools) {
    reasons.push('model has no tool support');
  }
  if (request.requiresVision && !profile.capabilities.vision) {
    reasons.push('model has no vision support');
  }
  if (request.requiresJson && !profile.capabilities.json) {
    reasons.push('model has no JSON mode');
  }
  if (request.maxCostTier !== undefined && profile.costTier > request.maxCostTier) {
    reasons.push('cost tier ' + profile.costTier + ' above the limit');
  }
  if (request.minContextWindow !== undefined) {
    const window = profile.capabilities.contextWindow;
    if (window === null || window < request.minContextWindow) {
      reasons.push('context window below ' + request.minContextWindow);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

function benchmarkFor(
  profile: ModelProfile,
  request: RoutingRequest,
  benchmarks: readonly ModelBenchmark[]
): ModelBenchmark | null {
  return (
    benchmarks.find(
      (entry) =>
        entry.modelId === profile.model && entry.taskKind === request.taskKind && entry.runs > 0
    ) ?? null
  );
}

/** Higher is better. Deterministic for identical inputs. */
export function scoreProfile(
  profile: ModelProfile,
  request: RoutingRequest,
  benchmarks: readonly ModelBenchmark[] = []
): number {
  let score = 0;
  if (profile.recommendedFor.includes(request.taskKind)) {
    score += 2;
  }
  if (profile.id === request.preferredProfile) {
    score += 3;
  }
  if (profile.capabilities.local && request.confidential) {
    score += 1;
  }
  score -= (profile.costTier - 1) * 0.5;

  const benchmark = benchmarkFor(profile, request, benchmarks);
  if (benchmark) {
    score += benchmark.score * 4;
  }
  return Number(score.toFixed(4));
}

export function rankProfiles(
  request: RoutingRequest,
  profiles: readonly ModelProfile[] = DEFAULT_MODEL_PROFILES,
  benchmarks: readonly ModelBenchmark[] = []
): ModelProfile[] {
  return profiles
    .filter((profile) => isProfileEligible(profile, request).eligible)
    .slice()
    .sort((a, b) => {
      const delta = scoreProfile(b, request, benchmarks) - scoreProfile(a, request, benchmarks);
      if (delta !== 0) {
        return delta;
      }
      if (a.costTier !== b.costTier) {
        return a.costTier - b.costTier;
      }
      return a.id.localeCompare(b.id);
    });
}

export function routeModel(
  request: RoutingRequest,
  profiles: readonly ModelProfile[] = DEFAULT_MODEL_PROFILES,
  benchmarks: readonly ModelBenchmark[] = []
): RoutingDecision {
  const ranked = rankProfiles(request, profiles, benchmarks);
  const chosen = ranked[0];
  if (!chosen) {
    throw new Error('No model profile matches the request constraints.');
  }

  const reasons: string[] = [];
  if (chosen.recommendedFor.includes(request.taskKind)) {
    reasons.push('recommended for ' + request.taskKind);
  }
  if (chosen.id === request.preferredProfile) {
    reasons.push('preferred profile');
  }
  const benchmark = benchmarkFor(chosen, request, benchmarks);
  if (benchmark) {
    reasons.push(
      Math.round((benchmark.successes / benchmark.runs) * 100) +
        '% success over ' +
        benchmark.runs +
        ' runs'
    );
  }
  if (chosen.capabilities.local) {
    reasons.push('runs locally');
  }
  reasons.push('cost tier ' + chosen.costTier);

  return {
    profileId: chosen.id,
    provider: chosen.provider,
    model: chosen.model,
    reason: reasons.join(', '),
    fallbacks: ranked.slice(1).map((profile) => profile.provider + '/' + profile.model),
    estimatedCostUsd: benchmark ? benchmark.avgCostUsd : null,
    local: chosen.capabilities.local,
  };
}

export function profilesForTaskKind(
  taskKind: TaskKind,
  profiles: readonly ModelProfile[] = DEFAULT_MODEL_PROFILES
): ModelProfile[] {
  return profiles.filter((profile) => profile.recommendedFor.includes(taskKind));
}
