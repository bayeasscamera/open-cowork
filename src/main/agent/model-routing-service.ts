/**
 * @module main/agent/model-routing-service
 *
 * Cowork 4.0 — Phase 7: turns the routing primitives into a stateful service the
 * agent runner can consult. It owns the human opt-in (enabled + active profile)
 * and infers the task kind from the user prompt, so live model selection stays
 * explainable instead of magic.
 */

import type {
  ModelBenchmark,
  ModelProfile,
  ModelProfileId,
  ModelRoutingState,
  RoutingDecision,
  RoutingRequest,
  TaskKind,
} from '../../shared/model-routing-types';

export type { ModelRoutingState };
import { DEFAULT_MODEL_PROFILES, isProfileEligible, profileById, routeModel } from './model-profiles';
import { ModelBenchmarkStore, type BenchmarkRecordInput } from './model-benchmark';


export interface ModelRoutingServiceOptions {
  profiles?: readonly ModelProfile[];
  benchmarks?: ModelBenchmarkStore;
}

/** One finished run, as observed by the agent runner. */
export interface ModelRunInput {
  modelId: string;
  prompt: string;
  success: boolean;
  latencyMs: number;
  costUsd?: number;
}

/** Input the runner passes when it needs a model for one prompt. */
export interface ModelResolutionInput {
  sessionId: string;
  prompt: string;
  /** Model that would be used without adaptive routing. */
  fallbackModel: string;
}

/**
 * Keyword weights per task kind. Weight encodes specificity: an audit is a
 * stronger signal than a generic "how does this work" question.
 */
const TASK_KIND_HINTS: ReadonlyArray<{ kind: TaskKind; weight: number; keywords: readonly string[] }> = [
  {
    kind: 'review',
    weight: 3,
    keywords: [
      'review',
      'code review',
      'audit',
      'security review',
      'vulnerability',
      'vulnerabilit',
      'regression',
      'critique',
      'relis',
      'relecture',
      'securite',
      'sécurité',
      'verifie que',
      'vérifie que',
    ],
  },
  {
    kind: 'implementation',
    weight: 2,
    keywords: [
      'implement',
      'implémente',
      'ajoute',
      'add ',
      'create',
      'crée',
      'cree',
      'build',
      'write',
      'refactor',
      'refactorise',
      'rename',
      'migrate',
      'migre',
      'fix',
      'corrige',
      'repare',
      'répare',
      'bug',
      'patch',
      'update',
      'met à jour',
    ],
  },
  {
    kind: 'exploration',
    weight: 1,
    keywords: [
      'explain',
      'explique',
      'why',
      'pourquoi',
      'how does',
      'comment fonctionne',
      'understand',
      'comprendre',
      'where is',
      'où est',
      'ou est',
      'search',
      'cherche',
      'trouve',
      'explore',
      'document',
      'summarize',
      'resume',
      'résume',
    ],
  },
];

/**
 * Infer the task kind from a free-form prompt. Deterministic and total: an
 * unrecognised prompt is a `general` task.
 */
export function inferTaskKind(prompt: string): TaskKind {
  const normalized = (prompt ?? '').toLowerCase();
  if (normalized.trim().length === 0) {
    return 'general';
  }
  let best: { kind: TaskKind; score: number } | null = null;
  for (const entry of TASK_KIND_HINTS) {
    let score = 0;
    for (const keyword of entry.keywords) {
      if (normalized.includes(keyword)) {
        score += entry.weight;
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { kind: entry.kind, score };
    }
  }
  return best ? best.kind : 'general';
}

/**
 * Phase 7 routing service. Disabled by default: nothing changes for a user who
 * never picks a profile.
 */
export class ModelRoutingService {
  public readonly profiles: readonly ModelProfile[];
  public readonly benchmarks: ModelBenchmarkStore;

  private enabled = false;
  private activeProfile: ModelProfileId | null = null;

  constructor(options: ModelRoutingServiceOptions = {}) {
    this.profiles = options.profiles ?? DEFAULT_MODEL_PROFILES;
    this.benchmarks = options.benchmarks ?? new ModelBenchmarkStore();
  }

  public state(): ModelRoutingState {
    return { enabled: this.enabled, activeProfile: this.activeProfile };
  }

  public setEnabled(enabled: boolean): ModelRoutingState {
    this.enabled = enabled === true;
    return this.state();
  }

  /**
   * Selecting a profile is the opt-in: it enables routing. Passing null clears
   * the profile but keeps the switch as the user left it.
   */
  public setActiveProfile(profile: ModelProfileId | null): ModelRoutingState {
    if (profile === null) {
      this.activeProfile = null;
      return this.state();
    }
    if (!this.profiles.some((candidate) => candidate.id === profile)) {
      throw new Error('Unknown model profile: ' + String(profile));
    }
    this.activeProfile = profile;
    this.enabled = true;
    return this.state();
  }

  public route(request: RoutingRequest): RoutingDecision {
    return routeModel(request, this.profiles, this.benchmarks.list());
  }

  public recordBenchmark(input: BenchmarkRecordInput): ModelBenchmark {
    return this.benchmarks.record(input);
  }

  /**
   * Resolve the model for one run, or undefined to keep the configured model.
   * Never throws: a routing failure must not break the agent loop.
   */
  public resolveModel(input: ModelResolutionInput): string | undefined {
    if (!this.enabled || !this.activeProfile) {
      return undefined;
    }
    try {
      const request: RoutingRequest = {
        taskKind: inferTaskKind(input.prompt),
        requiresTools: true,
        preferredProfile: this.activeProfile,
      };
      // An explicit profile choice is a direct instruction, so honour it whenever
      // it is eligible; only fall back to scoring when it is not. The benchmark
      // therefore refines routing without silently overriding the human.
      const preferred = profileById(this.activeProfile, this.profiles);
      if (preferred && isProfileEligible(preferred, request).eligible) {
        return qualify(preferred.provider, preferred.model);
      }
      const decision = routeModel(request, this.profiles, this.benchmarks.list());
      return qualify(decision.provider, decision.model);
    } catch {
      return undefined;
    }
  }

  /**
   * Map an observed model id onto the profile it belongs to, so a benchmark
   * recorded for "anthropic/claude-sonnet-4-6" also matches the bare
   * "claude-sonnet-4-6" a profile declares. Unknown ids pass through unchanged.
   */
  public normalizeBenchmarkModelId(modelId: string): string {
    const trimmed = modelId.trim();
    const profile = this.profiles.find(
      (candidate) =>
        candidate.model === trimmed || candidate.provider + '/' + candidate.model === trimmed
    );
    return profile ? profile.model : trimmed;
  }

  /**
   * Record the outcome of one real run so later routing decisions are backed by
   * local evidence. Returns null when there is nothing usable to record, and
   * never throws: telemetry must not break the agent loop.
   */
  public recordRun(input: ModelRunInput): ModelBenchmark | null {
    const modelId = this.normalizeBenchmarkModelId(input.modelId ?? '');
    if (modelId.length === 0) {
      return null;
    }
    try {
      return this.benchmarks.record({
        modelId,
        taskKind: inferTaskKind(input.prompt ?? ''),
        success: input.success === true,
        latencyMs:
          typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs)
            ? Math.max(0, input.latencyMs)
            : 0,
        ...(typeof input.costUsd === 'number' && Number.isFinite(input.costUsd)
          ? { costUsd: Math.max(0, input.costUsd) }
          : {}),
      });
    } catch {
      return null;
    }
  }

  /** Persist the opt-in state and the local benchmark evidence. */
  public serialize(): ModelRoutingSnapshot {
    return { state: this.state(), benchmarks: this.benchmarks.serialize() };
  }

  /** Restore a persisted snapshot; malformed entries are skipped. */
  public restore(snapshot: ModelRoutingSnapshot | null): number {
    if (!snapshot) {
      return 0;
    }
    if (snapshot.state) {
      this.enabled = snapshot.state.enabled === true;
      const profile = snapshot.state.activeProfile;
      this.activeProfile =
        profile && this.profiles.some((candidate) => candidate.id === profile) ? profile : null;
    }
    return this.benchmarks.restore(Array.isArray(snapshot.benchmarks) ? snapshot.benchmarks : []);
  }
}

/** Durable shape of the routing service (Phase 7.4). */
export interface ModelRoutingSnapshot {
  state: ModelRoutingState;
  benchmarks: ModelBenchmark[];
}

/** "provider/model" so the pi registry can resolve the profile's provider. */
function qualify(provider: string, model: string): string | undefined {
  const modelId = model?.trim();
  if (!modelId || modelId.length === 0) {
    return undefined;
  }
  const providerId = provider?.trim();
  return providerId && !modelId.includes('/') ? providerId + '/' + modelId : modelId;
}
