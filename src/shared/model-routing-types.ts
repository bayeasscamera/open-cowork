/**
 * @module shared/model-routing-types
 *
 * Cowork 4.0 — Phase 7: model profiles and local-first routing. These types cross
 * the preload bridge, so they must never import from `src/main`.
 */

export type ModelProfileId = 'fast' | 'balanced' | 'strong' | 'local';

export type TaskKind = 'exploration' | 'implementation' | 'review' | 'general';

export interface ModelCapabilities {
  tools: boolean;
  vision: boolean;
  json: boolean;
  streaming: boolean;
  /** Context window in tokens when known. */
  contextWindow: number | null;
  /** The model runs entirely on this machine. */
  local: boolean;
}

export interface ModelProfile {
  id: ModelProfileId;
  label: string;
  description: string;
  provider: string;
  model: string;
  capabilities: ModelCapabilities;
  /** Relative cost tier: 1 is cheapest, 4 is most expensive. */
  costTier: number;
  recommendedFor: TaskKind[];
}

export interface RoutingRequest {
  taskKind: TaskKind;
  requiresTools?: boolean;
  requiresVision?: boolean;
  requiresJson?: boolean;
  /** When true, only models that run locally are eligible. */
  confidential?: boolean;
  /** Reject profiles whose cost tier is above this value. */
  maxCostTier?: number;
  /** Prefer this profile when it is eligible. */
  preferredProfile?: ModelProfileId;
  minContextWindow?: number;
}

export interface RoutingDecision {
  profileId: ModelProfileId;
  provider: string;
  model: string;
  /** Human-readable justification, shown in the UI. */
  reason: string;
  /** "provider/model" of the next eligible profiles. */
  fallbacks: string[];
  estimatedCostUsd: number | null;
  local: boolean;
}

export interface BenchmarkRecordInput {
  modelId: string;
  taskKind: TaskKind;
  success: boolean;
  latencyMs: number;
  costUsd?: number;
}

export interface ModelBenchmark {
  modelId: string;
  taskKind: TaskKind;
  runs: number;
  successes: number;
  avgLatencyMs: number;
  avgCostUsd: number;
  /** 0..1 composite of success rate and speed. */
  score: number;
}

export type LocalProviderKind = 'ollama' | 'lm-studio' | 'vllm' | 'openai-compatible';

export interface LocalProviderPreset {
  kind: LocalProviderKind;
  label: string;
  baseUrl: string;
  modelsPath: string;
  responseShape: 'ollama' | 'openai';
}

export interface LocalProviderProbe {
  kind: LocalProviderKind;
  baseUrl: string;
  reachable: boolean;
  models: string[];
  error?: string;
}

export interface RegistryEntryInput {
  /** Hugging Face repository id, e.g. "org/model-GGUF". */
  repoId: string;
  url?: string;
  fileName?: string;
  sizeBytes?: number;
  sha256?: string;
  taskKinds?: TaskKind[];
}

export interface RegistryValidation {
  valid: boolean;
  /** Every failed rule, in a stable order. */
  reasons: string[];
  normalizedUrl: string | null;
  host: string | null;
  /** Profile the entry looks suited for, when valid. */
  suggestedProfile: ModelProfileId | null;
}

export const MODEL_PROFILE_IDS: readonly ModelProfileId[] = [
  'fast',
  'balanced',
  'strong',
  'local',
] as const;

export const TASK_KINDS: readonly TaskKind[] = [
  'exploration',
  'implementation',
  'review',
  'general',
] as const;

export const LOCAL_PROVIDER_KINDS: readonly LocalProviderKind[] = [
  'ollama',
  'lm-studio',
  'vllm',
  'openai-compatible',
] as const;
