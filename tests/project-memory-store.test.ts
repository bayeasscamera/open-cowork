import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TTL_MS,
  ProjectMemoryStore,
  dedupeByStatement,
  provenance,
  workspaceKeyFor,
} from '../src/main/memory/project-memory-store';
import type { ProjectMemoryItem } from '../src/shared/project-memory-types';

const WS = '/tmp/cowork-ws';
const OTHER_WS = '/tmp/other-ws';

function createStore(startAt = 1_000_000) {
  const clock = { value: startAt };
  let counter = 0;
  const store = new ProjectMemoryStore({
    now: () => clock.value,
    idFactory: () => 'id-' + ++counter,
  });
  return { store, clock };
}

function itemOf(store: ProjectMemoryStore, id: string): ProjectMemoryItem {
  const item = store.get(id);
  if (!item) {
    throw new Error('missing item ' + id);
  }
  return item;
}

describe('workspaceKeyFor', () => {
  it('normalizes to an absolute, forward-slashed path', () => {
    const key = workspaceKeyFor('src');
    expect(key).toContain('/src');
    expect(key.startsWith('/')).toBe(true);
    expect(key).not.toContain('\\');
  });
});

describe('ProjectMemoryStore.upsert', () => {
  it('trims the statement, lowercases tags and applies layer defaults', () => {
    const { store } = createStore();
    const item = store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: '  Never use any.  ',
      provenance: provenance('doc', 'AGENTS.md'),
      tags: ['TypeScript', 'STRICT'],
    });

    expect(item.id).toBe('id-1');
    expect(item.statement).toBe('Never use any.');
    expect(item.tags).toEqual(['typescript', 'strict']);
    expect(item.confidence).toBe(0.8);
    expect(item.expiresAt).toBeNull();
    expect(item.createdAt).toBe(1_000_000);
    expect(item.updatedAt).toBe(1_000_000);
  });

  it('gives volatile layers a TTL and durable layers none', () => {
    const { store } = createStore();
    const taskState = store.upsert({
      workspaceKey: WS,
      layer: 'task-state',
      statement: 'Phase 4 in flight',
      provenance: provenance('session', 's1'),
    });
    const errors = store.upsert({
      workspaceKey: WS,
      layer: 'errors',
      statement: 'better-sqlite3 ABI mismatch',
      provenance: provenance('test', 'npm test'),
    });

    expect(taskState.expiresAt).toBe(1_000_000 + DEFAULT_TTL_MS['task-state']!);
    expect(errors.expiresAt).toBe(1_000_000 + DEFAULT_TTL_MS.errors!);
  });

  it('honours an explicit ttlMs override, including null', () => {
    const { store } = createStore();
    const pinned = store.upsert({
      workspaceKey: WS,
      layer: 'task-state',
      statement: 'pinned note',
      provenance: provenance('user-decision', 'u1'),
      ttlMs: null,
    });
    const short = store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'expires fast',
      provenance: provenance('doc', 'x.md'),
      ttlMs: 10,
    });

    expect(pinned.expiresAt).toBeNull();
    expect(short.expiresAt).toBe(1_000_010);
  });

  it('updates in place and keeps the original creation time', () => {
    const { store, clock } = createStore();
    const created = store.upsert({
      workspaceKey: WS,
      layer: 'decisions',
      statement: 'Use workflow-types for IPC',
      provenance: provenance('adr', 'adr-001'),
      id: 'stable',
    });

    clock.value = 2_000_000;
    const updated = store.upsert({
      workspaceKey: WS,
      layer: 'decisions',
      statement: 'Use workflow-types for IPC payloads',
      provenance: provenance('adr', 'adr-001'),
      id: 'stable',
      confidence: 0.95,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBe(2_000_000);
    expect(updated.confidence).toBe(0.95);
    expect(store.size()).toBe(1);
  });

  it('returns a defensive copy from get', () => {
    const { store } = createStore();
    const item = store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'rule',
      provenance: provenance('doc', 'a'),
    });
    item.statement = 'tampered';

    expect(itemOf(store, item.id).statement).toBe('rule');
  });
});

describe('ProjectMemoryStore.remove and clearWorkspace', () => {
  it('removes a single item and reports whether it existed', () => {
    const { store } = createStore();
    const item = store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'rule',
      provenance: provenance('doc', 'a'),
    });

    expect(store.remove(item.id)).toBe(true);
    expect(store.remove(item.id)).toBe(false);
    expect(store.size()).toBe(0);
  });

  it('clears a whole workspace or a single layer of it', () => {
    const { store } = createStore();
    store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'r1',
      provenance: provenance('doc', 'a'),
    });
    store.upsert({
      workspaceKey: WS,
      layer: 'errors',
      statement: 'e1',
      provenance: provenance('test', 'b'),
    });
    store.upsert({
      workspaceKey: OTHER_WS,
      layer: 'rules',
      statement: 'r2',
      provenance: provenance('doc', 'c'),
    });

    expect(store.clearWorkspace(WS, 'rules')).toBe(1);
    expect(store.list(WS)).toHaveLength(1);
    expect(store.clearWorkspace(WS)).toBe(1);
    expect(store.list(WS)).toHaveLength(0);
    expect(store.list(OTHER_WS)).toHaveLength(1);
  });
});

describe('ProjectMemoryStore.purgeExpired', () => {
  it('drops expired items, optionally scoped to one workspace', () => {
    const { store, clock } = createStore();
    const volatile = store.upsert({
      workspaceKey: WS,
      layer: 'task-state',
      statement: 'volatile',
      provenance: provenance('session', 's1'),
      ttlMs: 100,
    });
    const stable = store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'stable',
      provenance: provenance('doc', 'a'),
      ttlMs: null,
    });
    const other = store.upsert({
      workspaceKey: OTHER_WS,
      layer: 'task-state',
      statement: 'other volatile',
      provenance: provenance('session', 's2'),
      ttlMs: 100,
    });

    clock.value += 1_000;

    expect(store.purgeExpired(WS)).toEqual([volatile.id]);
    expect(store.get(stable.id)).not.toBeNull();
    expect(store.get(other.id)).not.toBeNull();

    expect(store.purgeExpired()).toEqual([other.id]);
    expect(store.size()).toBe(1);
  });
});

describe('ProjectMemoryStore.list and overview', () => {
  it('lists newest first, excluding expired items and honouring the layer filter', () => {
    const { store, clock } = createStore();
    store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'old rule',
      provenance: provenance('doc', 'a'),
      id: 'old',
    });
    clock.value += 500;
    store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'new rule',
      provenance: provenance('doc', 'b'),
      id: 'new',
    });
    store.upsert({
      workspaceKey: WS,
      layer: 'errors',
      statement: 'expired error',
      provenance: provenance('test', 'c'),
      id: 'gone',
      ttlMs: 10,
    });

    clock.value += 100;

    expect(store.list(WS).map((entry) => entry.id)).toEqual(['new', 'old']);
    expect(store.list(WS, 'errors')).toEqual([]);
    expect(store.list(OTHER_WS)).toEqual([]);
  });

  it('summarizes per-layer counts and the number of expired items', () => {
    const { store, clock } = createStore();
    store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'r',
      provenance: provenance('doc', 'a'),
    });
    clock.value += 10;
    store.upsert({
      workspaceKey: WS,
      layer: 'errors',
      statement: 'e',
      provenance: provenance('test', 'b'),
    });
    store.upsert({
      workspaceKey: WS,
      layer: 'task-state',
      statement: 'expired',
      provenance: provenance('session', 's'),
      ttlMs: 1,
    });

    clock.value += 10;

    const overview = store.overview(WS);
    expect(overview.workspaceKey).toBe(WS);
    expect(overview.layers).toEqual({ rules: 1, decisions: 0, 'task-state': 0, errors: 1 });
    expect(overview.expired).toBe(1);
    expect(overview.updatedAt).toBe(1_000_010);

    expect(store.overview(OTHER_WS).updatedAt).toBe(0);
  });
});

describe('ProjectMemoryStore.query and buildInjection', () => {
  it('ranks items for a task and exposes the prompt-ready text', () => {
    const { store } = createStore();
    store.upsert({
      workspaceKey: WS,
      layer: 'rules',
      statement: 'Never use any in TypeScript',
      provenance: provenance('doc', 'AGENTS.md', 'Code standards'),
      tags: ['typescript'],
    });
    store.upsert({
      workspaceKey: WS,
      layer: 'errors',
      statement: 'Unrelated billing failure',
      provenance: provenance('test', 'billing.test.ts'),
    });

    const injection = store.buildInjection({ workspaceKey: WS, query: 'typescript strictness' });

    expect(injection.items.map((entry) => entry.item.layer)).toEqual(['rules']);
    expect(injection.text).toContain('<project_memory workspace="' + WS + '">');
    expect(injection.text).toContain('[doc:AGENTS.md#Code standards]');
    expect(injection.considered).toBe(2);
  });

  it('returns an empty injection when nothing matches the workspace', () => {
    const { store } = createStore();
    const injection = store.buildInjection({ workspaceKey: WS, query: 'anything' });

    expect(injection.text).toBe('');
    expect(injection.items).toEqual([]);
    expect(injection.considered).toBe(0);
  });
});

describe('dedupeByStatement', () => {
  it('keeps the most confident duplicate per layer and statement', () => {
    const base = {
      workspaceKey: WS,
      provenance: provenance('doc', 'a'),
      tags: [],
      createdAt: 1,
      updatedAt: 1,
      expiresAt: null,
    };
    const deduped = dedupeByStatement([
      { ...base, id: 'low', layer: 'rules', statement: 'No any', confidence: 0.4 },
      { ...base, id: 'high', layer: 'rules', statement: ' no any ', confidence: 0.9 },
      { ...base, id: 'other-layer', layer: 'errors', statement: 'No any', confidence: 0.5 },
    ]);

    expect(deduped.map((entry) => entry.id).sort()).toEqual(['high', 'other-layer']);
  });
});

describe('provenance', () => {
  it('omits the locator when it is not provided', () => {
    expect(provenance('commit', 'abc123')).toEqual({ source: 'commit', reference: 'abc123' });
    expect(provenance('commit', 'abc123', 'src/a.ts:12')).toEqual({
      source: 'commit',
      reference: 'abc123',
      locator: 'src/a.ts:12',
    });
  });
});
