/**
 * @module main/agent/embedding-grouping
 *
 * Semantic grouping on top of a caller-supplied embed() function.
 *
 * Lexical topic detection (see research-topic.ts) misses paraphrases: "voiture
 * électrique" and "VE" or "electric cars" describe the same subject with almost
 * no shared vocabulary. An embedding comparison catches those, at the cost of
 * one embed() call per text — which is why this module never embeds twice.
 *
 * Pure with respect to the application: it depends only on the injected
 * embed function, so it is unit-testable without a provider and cannot
 * accidentally trigger model spend in a test.
 *
 * Embedding is OPTIONAL by construction: any text whose embedding cannot be
 * computed degrades to the lexical path, never to a wrong grouping.
 */

import { cosineSimilarity } from '../memory/memory-utils';

/** Above this cosine similarity, two briefs are treated as the same subject. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.82;

/**
 * In-memory embedding cache. Keyed by the exact text, so repeated grouping
 * passes over the same delegations never re-embed — the cost stays "one
 * embedding per distinct brief", not "one per schedule attempt".
 */
export class EmbeddingCache {
  private readonly store = new Map<string, number[]>();
  /** Total embed() calls actually issued (measurable cost, for tests/logs). */
  private misses = 0;

  constructor(private readonly maxEntries = 500) {}

  get size(): number {
    return this.store.size;
  }

  get embedCalls(): number {
    return this.misses;
  }

  async get(text: string, embed: (text: string) => Promise<number[]>): Promise<number[]> {
    const key = text.trim();
    if (!key) return [];
    const cached = this.store.get(key);
    if (cached) return cached;
    this.misses += 1;
    const vector = await embed(key);
    if (vector.length > 0) {
      // Bound the cache: oldest insertion is evicted first (Map preserves order).
      if (this.store.size >= this.maxEntries) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) this.store.delete(oldest);
      }
      this.store.set(key, vector);
    }
    return vector;
  }

  clear(): void {
    this.store.clear();
    this.misses = 0;
  }
}

/**
 * Union-find over semantic similarity. Each text is embedded ONCE (through the
 * cache); any pair whose cosine similarity clears the threshold is merged.
 * Unembeddable texts (empty vectors) fall back to the caller-provided lexical
 * predicate, so a provider outage degrades instead of grouping wrongly.
 */
export async function groupByEmbedding<T>(
  items: T[],
  textOf: (item: T) => string,
  embed: (text: string) => Promise<number[]>,
  options: {
    threshold?: number;
    /** Fallback used when at least one of the two texts has no embedding. */
    lexicalFallback?: (a: string, b: string) => boolean;
    cache?: EmbeddingCache;
  } = {}
): Promise<T[][]> {
  if (items.length < 2) return [];
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const cache = options.cache ?? new EmbeddingCache();
  const texts = items.map((item) => textOf(item));
  const vectors = await Promise.all(
    texts.map(async (text) => {
      try {
        return await cache.get(text, embed);
      } catch {
        // A failing embed call must not break grouping: degrade to lexical.
        return [] as number[];
      }
    })
  );

  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    let cursor = i;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = vectors[i];
      const b = vectors[j];
      let same: boolean;
      if (a.length > 0 && b.length > 0) {
        same = cosineSimilarity(a, b) >= threshold;
      } else {
        same = options.lexicalFallback?.(texts[i], texts[j]) ?? false;
      }
      if (same) union(i, j);
    }
  }

  const groups = new Map<number, T[]>();
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) {
      bucket.push(items[i]);
    } else {
      groups.set(root, [items[i]]);
    }
  }
  return Array.from(groups.values()).filter((group) => group.length >= 2);
}
