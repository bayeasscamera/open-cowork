/**
 * @module shared/project-memory-types
 *
 * Cowork 4.0 — Phase 4: the project memory is split into four layers so the
 * agent can inject exactly the part a task needs, with visible provenance.
 */

export type MemoryLayer =
  /** Conventions and hard rules of the repository. */
  | 'rules'
  /** Architecture decisions (ADR-like), with rationale. */
  | 'decisions'
  /** Current task state: what is in flight, what was approved. */
  | 'task-state'
  /** Errors and regressions already encountered. */
  | 'errors';

export const MEMORY_LAYERS: readonly MemoryLayer[] = [
  'rules',
  'decisions',
  'task-state',
  'errors',
] as const;

export type MemorySource =
  | 'commit'
  | 'test'
  | 'adr'
  | 'doc'
  | 'user-decision'
  | 'session'
  | 'agent';

export interface MemoryProvenance {
  source: MemorySource;
  /** Repository path, commit sha, session id or URL. */
  reference: string;
  /** Optionally a finer locator inside the reference (line, section). */
  locator?: string;
}

export interface ProjectMemoryItem {
  id: string;
  workspaceKey: string;
  layer: MemoryLayer;
  /** Short, self-contained statement injected into the prompt. */
  statement: string;
  provenance: MemoryProvenance;
  /** Free-form keywords used for relevance scoring. */
  tags: string[];
  /** Higher wins when relevance ties. */
  confidence: number;
  createdAt: number;
  updatedAt: number;
  /** Absolute expiry timestamp, or null when the item never expires. */
  expiresAt: number | null;
}

export interface UpsertMemoryInput {
  workspaceKey: string;
  layer: MemoryLayer;
  statement: string;
  provenance: MemoryProvenance;
  tags?: string[];
  confidence?: number;
  /** Time-to-live in milliseconds; overrides the layer default. */
  ttlMs?: number | null;
  id?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface MemoryQuery {
  workspaceKey: string;
  /** Task description used for relevance scoring. */
  query: string;
  /** Layers to consider; defaults to all four. */
  layers?: MemoryLayer[];
  /** Hard cap on returned items. */
  limit?: number;
  /** Skip items whose confidence is below this value. */
  minConfidence?: number;
}

export interface ScoredMemoryItem {
  item: ProjectMemoryItem;
  score: number;
  /** Human-readable reason the item was selected (shown in the UI). */
  reason: string;
}

export interface MemoryInjection {
  workspaceKey: string;
  items: ScoredMemoryItem[];
  /** Prompt-ready text with provenance markers. */
  text: string;
  /** Total number of items considered before ranking. */
  considered: number;
}

export interface ProjectMemoryOverview {
  workspaceKey: string;
  layers: Record<MemoryLayer, number>;
  expired: number;
  updatedAt: number;
}
