/**
 * @module main/memory/memory-relevance
 *
 * Cowork 4.0 — Phase 4.3: only the memory that is relevant to the current task
 * should reach the prompt. Scoring is deterministic, dependency-free and
 * explainable: every selection carries the reason it was chosen.
 */

import type {
  MemoryLayer,
  MemoryQuery,
  ProjectMemoryItem,
  ScoredMemoryItem,
} from '../../shared/project-memory-types';
import { MEMORY_LAYERS } from '../../shared/project-memory-types';

/** Layers that matter most when the agent is about to write code. */
export const LAYER_WEIGHT: Readonly<Record<MemoryLayer, number>> = Object.freeze({
  rules: 1.1,
  decisions: 1,
  'task-state': 1.25,
  errors: 1.35,
});

/** Items older than this are progressively down-ranked unless pinned. */
const FRESHNESS_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'dans',
  'pour',
  'avec',
  'les',
  'des',
  'une',
  'que',
  'qui',
  'est',
  'sur',
  'aux',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ_\-.]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

/** Jaccard-ish overlap between the query tokens and the item text/tags. */
export function lexicalOverlap(queryTokens: string[], item: ProjectMemoryItem): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const haystack = new Set([...tokenize(item.statement), ...item.tags.map((tag) => tag.toLowerCase())]);
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      hits += 1;
      continue;
    }
    for (const candidate of haystack) {
      if (candidate.startsWith(token) || token.startsWith(candidate)) {
        hits += 0.5;
        break;
      }
    }
  }
  return hits / queryTokens.length;
}

export function isExpired(item: ProjectMemoryItem, now: number): boolean {
  return item.expiresAt !== null && item.expiresAt <= now;
}

/** Freshness factor in (0, 1]; brand-new items score 1. */
export function freshness(item: ProjectMemoryItem, now: number): number {
  const age = Math.max(0, now - item.updatedAt);
  return Math.pow(0.5, age / FRESHNESS_HALF_LIFE_MS);
}

export interface RankOptions {
  now?: number;
}

/**
 * Rank memory items for a task. Pure: same inputs, same order.
 */
export function rankMemoryItems(
  items: ProjectMemoryItem[],
  query: MemoryQuery,
  options: RankOptions = {}
): ScoredMemoryItem[] {
  const now = options.now ?? Date.now();
  const layers = new Set<MemoryLayer>(query.layers ?? MEMORY_LAYERS);
  const queryTokens = tokenize(query.query);
  const minConfidence = query.minConfidence ?? 0;

  const scored: ScoredMemoryItem[] = [];

  for (const item of items) {
    if (item.workspaceKey !== query.workspaceKey) {
      continue;
    }
    if (!layers.has(item.layer)) {
      continue;
    }
    if (isExpired(item, now)) {
      continue;
    }
    if (item.confidence < minConfidence) {
      continue;
    }

    const overlap = lexicalOverlap(queryTokens, item);
    const fresh = freshness(item, now);
    // A task-relevant item never scores zero: rules and current state are
    // always context, even when the wording differs from the request.
    const base = item.layer === 'rules' || item.layer === 'task-state' ? 0.35 : 0;
    const score = (base + overlap) * LAYER_WEIGHT[item.layer] * (0.6 + 0.4 * fresh) * item.confidence;

    if (score <= 0) {
      continue;
    }

    scored.push({
      item,
      score: Number(score.toFixed(4)),
      reason: describeReason(item, overlap, fresh),
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.item.updatedAt - a.item.updatedAt;
  });

  const limit = query.limit ?? 20;
  return scored.slice(0, Math.max(0, limit));
}

function describeReason(item: ProjectMemoryItem, overlap: number, fresh: number): string {
  const parts = ['layer ' + item.layer];
  if (overlap > 0) {
    parts.push('keyword overlap ' + Math.round(overlap * 100) + '%');
  }
  if (fresh < 0.5) {
    parts.push('ageing');
  }
  parts.push('source ' + item.provenance.source);
  return parts.join(', ');
}

/**
 * Render the ranked items as prompt text. Provenance is always visible so the
 * model can cite where a rule or a past regression came from.
 */
export function formatMemoryInjection(
  workspaceKey: string,
  items: ProjectMemoryItem[],
  query: MemoryQuery,
  options: RankOptions = {}
): { text: string; considered: number; selected: ScoredMemoryItem[] } {
  const eligible = items.filter(
    (item) => item.workspaceKey === workspaceKey && !isExpired(item, options.now ?? Date.now())
  );
  const selected = rankMemoryItems(items, query, options);

  if (selected.length === 0) {
    return { text: '', considered: eligible.length, selected };
  }

  const lines: string[] = ['<project_memory workspace="' + workspaceKey + '">'];
  for (const layer of MEMORY_LAYERS) {
    const layerItems = selected.filter((entry) => entry.item.layer === layer);
    if (layerItems.length === 0) {
      continue;
    }
    lines.push('  <layer name="' + layer + '">');
    for (const entry of layerItems) {
      const provenance = entry.item.provenance;
      const locator = provenance.locator ? '#' + provenance.locator : '';
      lines.push(
        '    - ' +
          entry.item.statement +
          ' [' +
          provenance.source +
          ':' +
          provenance.reference +
          locator +
          ']'
      );
    }
    lines.push('  </layer>');
  }
  lines.push('</project_memory>');

  return { text: lines.join('\n'), considered: eligible.length, selected };
}
