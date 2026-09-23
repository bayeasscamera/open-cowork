import { describe, expect, it } from 'vitest';
import {
  LAYER_WEIGHT,
  formatMemoryInjection,
  freshness,
  isExpired,
  lexicalOverlap,
  rankMemoryItems,
  tokenize,
} from '../src/main/memory/memory-relevance';
import type { MemoryLayer, ProjectMemoryItem } from '../src/shared/project-memory-types';

const WS = '/tmp/cowork-ws';
const NOW = 1_000_000;
const HALF_LIFE = 14 * 24 * 60 * 60 * 1000;

function item(
  overrides: Partial<ProjectMemoryItem> & { layer: MemoryLayer; statement: string }
): ProjectMemoryItem {
  return {
    id: overrides.id ?? 'id-' + overrides.statement,
    workspaceKey: overrides.workspaceKey ?? WS,
    layer: overrides.layer,
    statement: overrides.statement,
    provenance: overrides.provenance ?? { source: 'session', reference: 's1' },
    tags: overrides.tags ?? [],
    confidence: overrides.confidence ?? 0.8,
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    expiresAt: overrides.expiresAt ?? null,
  };
}

describe('tokenize', () => {
  it('lowercases, drops stop words and tokens shorter than three characters', () => {
    expect(tokenize('The quick brown fox and the lazy dog')).toEqual([
      'quick',
      'brown',
      'fox',
      'lazy',
      'dog',
    ]);
    expect(tokenize('Dans le pour avec les des une que qui est sur aux')).toEqual([]);
  });

  it('keeps identifiers, paths and accents', () => {
    expect(tokenize('src/main/memory-store.ts and régénération')).toEqual([
      'src',
      'main',
      'memory-store.ts',
      'régénération',
    ]);
  });
});

describe('lexicalOverlap', () => {
  it('returns zero without query tokens', () => {
    expect(lexicalOverlap([], item({ layer: 'rules', statement: 'rule' }))).toBe(0);
  });

  it('scores exact hits fully and prefix hits at half weight', () => {
    const subject = item({
      layer: 'rules',
      statement: 'Avoid using any in TypeScript',
      tags: ['strict'],
    });

    expect(lexicalOverlap(['typescript'], subject)).toBe(1);
    expect(lexicalOverlap(['type'], subject)).toBe(0.5);
    expect(lexicalOverlap(['typescript', 'strict', 'billing'], subject)).toBeCloseTo(2 / 3, 5);
  });
});

describe('isExpired and freshness', () => {
  it('treats null expiry as permanent and compares timestamps otherwise', () => {
    expect(isExpired(item({ layer: 'rules', statement: 'r' }), NOW)).toBe(false);
    expect(isExpired(item({ layer: 'errors', statement: 'e', expiresAt: NOW }), NOW)).toBe(true);
    expect(isExpired(item({ layer: 'errors', statement: 'e', expiresAt: NOW + 1 }), NOW)).toBe(false);
  });

  it('halves the score every 14 days of age', () => {
    const fresh = item({ layer: 'rules', statement: 'r' });
    const old = item({ layer: 'rules', statement: 'r', updatedAt: NOW - HALF_LIFE });

    expect(freshness(fresh, NOW)).toBe(1);
    expect(freshness(old, NOW)).toBeCloseTo(0.5, 5);
  });
});

describe('rankMemoryItems', () => {
  it('filters by workspace, layer, confidence and expiry', () => {
    const items = [
      item({ id: 'keep', layer: 'errors', statement: 'TypeScript strict failure' }),
      item({ id: 'other-ws', layer: 'errors', statement: 'TypeScript strict failure', workspaceKey: '/other' }),
      item({ id: 'other-layer', layer: 'decisions', statement: 'TypeScript strict decision' }),
      item({ id: 'low-confidence', layer: 'errors', statement: 'TypeScript strict failure', confidence: 0.1 }),
      item({ id: 'expired', layer: 'errors', statement: 'TypeScript strict failure', expiresAt: NOW - 1 }),
    ];

    const ranked = rankMemoryItems(
      items,
      { workspaceKey: WS, query: 'typescript strict', layers: ['errors'], minConfidence: 0.5 },
      { now: NOW }
    );

    expect(ranked.map((entry) => entry.item.id)).toEqual(['keep']);
  });

  it('always keeps rules and task state, but not unrelated errors or decisions', () => {
    const ranked = rankMemoryItems(
      [
        item({ id: 'rule', layer: 'rules', statement: 'Prefer small commits' }),
        item({ id: 'state', layer: 'task-state', statement: 'Working on phase 4' }),
        item({ id: 'error', layer: 'errors', statement: 'Unrelated billing crash' }),
        item({ id: 'decision', layer: 'decisions', statement: 'Use SQLite for storage' }),
      ],
      { workspaceKey: WS, query: 'completely different topic' },
      { now: NOW }
    );

    expect(ranked.map((entry) => entry.item.id)).toEqual(['state', 'rule']);
  });

  it('weights layers and reports an explainable reason', () => {
    const ranked = rankMemoryItems(
      [
        item({ id: 'rule', layer: 'rules', statement: 'Prefer small commits' }),
        item({ id: 'error', layer: 'errors', statement: 'typescript strict errors' }),
      ],
      { workspaceKey: WS, query: 'typescript strict' },
      { now: NOW }
    );

    expect(LAYER_WEIGHT.errors).toBeGreaterThan(LAYER_WEIGHT.rules);
    expect(ranked[0].item.id).toBe('error');
    expect(ranked[0].reason).toContain('layer errors');
    expect(ranked[0].reason).toContain('keyword overlap 100%');
    expect(ranked[0].reason).toContain('source session');
  });

  it('is deterministic and respects the limit', () => {
    const items = [
      item({ id: 'a', layer: 'errors', statement: 'shared topic' }),
      item({ id: 'b', layer: 'errors', statement: 'shared topic' }),
      item({ id: 'c', layer: 'errors', statement: 'shared topic' }),
    ];

    const first = rankMemoryItems(items, { workspaceKey: WS, query: 'shared topic', limit: 2 }, { now: NOW });
    const second = rankMemoryItems(items, { workspaceKey: WS, query: 'shared topic', limit: 2 }, { now: NOW });

    expect(first).toHaveLength(2);
    expect(first.map((entry) => entry.item.id)).toEqual(second.map((entry) => entry.item.id));
  });
});

describe('formatMemoryInjection', () => {
  it('groups selected items by layer with visible provenance', () => {
    const result = formatMemoryInjection(
      WS,
      [
        item({
          layer: 'rules',
          statement: 'Never use any',
          provenance: { source: 'doc', reference: 'AGENTS.md', locator: 'Code standards' },
        }),
        item({
          layer: 'errors',
          statement: 'ABI mismatch on better-sqlite3',
          provenance: { source: 'test', reference: 'npm test' },
        }),
      ],
      { workspaceKey: WS, query: 'abi mismatch better-sqlite3' },
      { now: NOW }
    );

    expect(result.text.startsWith('<project_memory workspace="' + WS + '">')).toBe(true);
    expect(result.text).toContain('<layer name="rules">');
    expect(result.text).toContain('<layer name="errors">');
    expect(result.text).toContain('Never use any [doc:AGENTS.md#Code standards]');
    expect(result.text).toContain('ABI mismatch on better-sqlite3 [test:npm test]');
    expect(result.text.endsWith('</project_memory>')).toBe(true);
  });

  it('returns empty text when no item is eligible', () => {
    const result = formatMemoryInjection(WS, [], { workspaceKey: WS, query: 'nothing' }, { now: NOW });

    expect(result.text).toBe('');
    expect(result.selected).toEqual([]);
    expect(result.considered).toBe(0);
  });

  it('counts eligible items that were not selected', () => {
    const result = formatMemoryInjection(
      WS,
      [
        item({ layer: 'errors', statement: 'Unrelated billing crash' }),
        item({ layer: 'rules', statement: 'Always commit before reporting' }),
      ],
      { workspaceKey: WS, query: 'zzz' },
      { now: NOW }
    );

    expect(result.considered).toBe(2);
    expect(result.selected.map((entry) => entry.item.layer)).toEqual(['rules']);
  });
});
