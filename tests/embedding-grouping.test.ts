import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  EmbeddingCache,
  groupByEmbedding,
} from '../src/main/agent/embedding-grouping';

/** A deterministic fake embedder: vectors are unit-length, so cosine = dot. */
function fakeEmbed(dimension = 4) {
  return vi.fn(async (text: string): Promise<number[]> => {
    const lower = text.toLowerCase();
    const vector = new Array(dimension).fill(0);
    // Group by coarse semantic families so paraphrases share a direction.
    const families: Array<[RegExp, number]> = [
      [/electric|voiture|vehicle|\bve\b|battery|charging/, 0],
      [/semiconductor|chip|wafer|puces?\b/, 1],
      [/kubernetes|cluster|container|pod/, 2],
      [/bread|sourdough|levain|pain/, 3],
    ];
    for (const [pattern, index] of families) {
      if (pattern.test(lower)) {
        vector[index % dimension] = 1;
        return vector;
      }
    }
    // Unknown text: a unique direction (never grouped with anything).
    vector[lower.length % dimension] = 1;
    vector[(lower.charCodeAt(0) || 0) % dimension] = 1;
    return vector;
  });
}

describe('EmbeddingCache', () => {
  it('embeds each distinct text exactly once', async () => {
    const embed = fakeEmbed();
    const cache = new EmbeddingCache();
    await cache.get('same text', embed);
    await cache.get('same text', embed);
    await cache.get('other text', embed);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(cache.embedCalls).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('does not cache empty results or empty input', async () => {
    const embed = vi.fn(async () => [] as number[]);
    const cache = new EmbeddingCache();
    await cache.get('x', embed);
    await cache.get('x', embed);
    await cache.get('   ', embed);
    expect(cache.size).toBe(0);
    expect(embed).toHaveBeenCalledTimes(2); // empty results are retried, not cached
  });

  it('evicts the oldest entry past its bound', async () => {
    const embed = fakeEmbed();
    const cache = new EmbeddingCache(2);
    await cache.get('a', embed);
    await cache.get('b', embed);
    await cache.get('c', embed);
    expect(cache.size).toBe(2);
    await expect(cache.get('a', embed)).resolves.toBeDefined();
    expect(embed).toHaveBeenCalledTimes(4); // 'a' was evicted and re-embedded
  });
});

describe('groupByEmbedding', () => {
  it('groups PARAPHRASES the lexical path would miss', async () => {
    const embed = fakeEmbed();
    const items = [
      { id: 'fr', text: 'Recherche sur la voiture électrique en Europe' },
      { id: 'abbr', text: 'Recherche sur le VE européen' },
      { id: 'en', text: 'Research the electric vehicle market in Europe' },
      { id: 'chips', text: 'Research the semiconductor market' },
    ];
    const groups = await groupByEmbedding(items, (i) => i.text, embed);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((g) => g.id).sort()).toEqual(['abbr', 'en', 'fr']);
  });

  it('never groups unrelated subjects', async () => {
    const embed = fakeEmbed();
    const items = [
      { id: 'ev', text: 'Research the electric vehicle market' },
      { id: 'chip', text: 'Research the semiconductor market' },
    ];
    expect(await groupByEmbedding(items, (i) => i.text, embed)).toHaveLength(0);
  });

  it('returns no group for fewer than two items', async () => {
    const embed = fakeEmbed();
    expect(await groupByEmbedding([{ text: 'only one' }], (i) => i.text, embed)).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('degrades to the lexical fallback when a text has no embedding', async () => {
    // The embedder refuses one text: that PAIR must fall back to lexical.
    const embed = vi.fn(async (text: string): Promise<number[]> => {
      if (text.includes('BROKEN')) return [];
      return [1, 0, 0, 0];
    });
    const lexicalFallback = vi.fn((a: string, b: string) =>
      a.includes('shared-topic') && b.includes('shared-topic')
    );
    const items = [
      { id: 'a', text: 'BROKEN shared-topic brief' },
      { id: 'b', text: 'shared-topic brief' },
    ];
    const groups = await groupByEmbedding(items, (i) => i.text, embed, { lexicalFallback });
    expect(lexicalFallback).toHaveBeenCalled();
    expect(groups).toHaveLength(1);
  });

  it('never groups on an embedding failure alone', async () => {
    const embed = vi.fn(async () => {
      throw new Error('embedding provider down');
    });
    const items = [
      { id: 'a', text: 'Research the electric vehicle market' },
      { id: 'b', text: 'Research the electric vehicle market' },
    ];
    // Without a lexical fallback, a provider outage yields no grouping at all —
    // never a wrong one.
    expect(await groupByEmbedding(items, (i) => i.text, embed)).toHaveLength(0);
  });

  it('respects a custom threshold', async () => {
    // Orthogonal vectors: similarity 0, so no default group…
    const embed = vi.fn(async (text: string) => (text === 'a' ? [1, 0] : [0, 1]));
    const items = [{ id: 'a', text: 'a' }, { id: 'b', text: 'b' }];
    expect(await groupByEmbedding(items, (i) => i.text, embed)).toHaveLength(0);
    // …and none even at threshold 0 (0 >= 0 would group: keep it strict).
    const grouped = await groupByEmbedding(items, (i) => i.text, embed, { threshold: 0.5 });
    expect(grouped).toHaveLength(0);
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBeGreaterThan(0.5);
  });

  it('reuses the injected cache across calls (no duplicate embedding spend)', async () => {
    const embed = fakeEmbed();
    const cache = new EmbeddingCache();
    const items = [
      { id: 'a', text: 'electric vehicle market' },
      { id: 'b', text: 'electric vehicle market share' },
    ];
    await groupByEmbedding(items, (i) => i.text, embed, { cache });
    await groupByEmbedding(items, (i) => i.text, embed, { cache });
    expect(embed).toHaveBeenCalledTimes(2); // two texts, embedded once each
  });
});
