/**
 * @module main/memory/project-memory-store
 *
 * Cowork 4.0 — Phase 4: the four-layer project memory. Pure in-memory store with
 * deterministic ordering, so it is fully unit-testable and the persistence layer
 * can be added later without touching the rules.
 */

import * as path from 'node:path';
import type {
  MemoryInjection,
  MemoryLayer,
  MemoryProvenance,
  MemoryQuery,
  ProjectMemoryItem,
  ProjectMemoryOverview,
  UpsertMemoryInput,
} from '../../shared/project-memory-types';
import { MEMORY_LAYERS } from '../../shared/project-memory-types';
import {
  formatMemoryInjection,
  isExpired,
  rankMemoryItems,
  type RankOptions,
} from './memory-relevance';

/** Default lifetime per layer: task state is volatile, rules are durable. */
export const DEFAULT_TTL_MS: Readonly<Record<MemoryLayer, number | null>> = Object.freeze({
  'task-state': 3 * 24 * 60 * 60 * 1000,
  errors: 90 * 24 * 60 * 60 * 1000,
  decisions: null,
  rules: null,
});

/** Workspace key: the normalized absolute path, so renames are explicit. */
export function workspaceKeyFor(workspacePath: string): string {
  return path.resolve(workspacePath).split(path.sep).join('/');
}

function defaultId(): string {
  return 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export interface ProjectMemoryStoreOptions {
  now?: () => number;
  /** Deterministic id generator (tests inject a counter). */
  idFactory?: () => string;
}

export class ProjectMemoryStore {
  private readonly items = new Map<string, ProjectMemoryItem>();
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: ProjectMemoryStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory ?? defaultId;
  }

  public size(): number {
    return this.items.size;
  }

  /** Insert or update an item. Updating keeps the original creation time. */
  public upsert(input: UpsertMemoryInput): ProjectMemoryItem {
    const now = this.now();
    const existing = input.id ? this.items.get(input.id) : undefined;
    const ttl = input.ttlMs === undefined ? DEFAULT_TTL_MS[input.layer] : input.ttlMs;

    const item: ProjectMemoryItem = {
      id: existing?.id ?? input.id ?? this.idFactory(),
      workspaceKey: input.workspaceKey,
      layer: input.layer,
      statement: input.statement.trim(),
      provenance: input.provenance,
      tags: (input.tags ?? []).map((tag) => tag.toLowerCase()),
      confidence: input.confidence ?? (existing?.confidence ?? 0.8),
      createdAt: existing?.createdAt ?? input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
      expiresAt: ttl === null || ttl === undefined ? null : now + ttl,
    };

    this.items.set(item.id, item);
    return { ...item };
  }

  public get(id: string): ProjectMemoryItem | null {
    const item = this.items.get(id);
    return item ? { ...item } : null;
  }

  /** Remove an item; returns whether something was removed. */
  public remove(id: string): boolean {
    return this.items.delete(id);
  }

  /** Remove every item of a workspace, optionally restricted to one layer. */
  public clearWorkspace(workspaceKey: string, layer?: MemoryLayer): number {
    let removed = 0;
    for (const [id, item] of this.items) {
      if (item.workspaceKey !== workspaceKey) {
        continue;
      }
      if (layer && item.layer !== layer) {
        continue;
      }
      this.items.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** Drop everything whose TTL elapsed. Returns the ids removed. */
  public purgeExpired(workspaceKey?: string): string[] {
    const now = this.now();
    const removed: string[] = [];
    for (const [id, item] of this.items) {
      if (workspaceKey && item.workspaceKey !== workspaceKey) {
        continue;
      }
      if (isExpired(item, now)) {
        this.items.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  /** All items of a workspace, newest first. Expired items are excluded. */
  public list(workspaceKey: string, layer?: MemoryLayer, options: RankOptions = {}): ProjectMemoryItem[] {
    const now = options.now ?? this.now();
    return Array.from(this.items.values())
      .filter((item) => item.workspaceKey === workspaceKey)
      .filter((item) => (layer ? item.layer === layer : true))
      .filter((item) => !isExpired(item, now))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((item) => ({ ...item }));
  }

  /** Ranked items for a task, with the reason each one was selected. */
  public query(query: MemoryQuery, options: RankOptions = {}) {
    const items = Array.from(this.items.values());
    return rankMemoryItems(items, query, { now: options.now ?? this.now() });
  }

  /** Prompt-ready injection for the current task (Phase 4.3). */
  public buildInjection(query: MemoryQuery, options: RankOptions = {}): MemoryInjection {
    const items = Array.from(this.items.values());
    const result = formatMemoryInjection(query.workspaceKey, items, query, {
      now: options.now ?? this.now(),
    });
    return {
      workspaceKey: query.workspaceKey,
      items: result.selected,
      text: result.text,
      considered: result.considered,
    };
  }

  public overview(workspaceKey: string, options: RankOptions = {}): ProjectMemoryOverview {
    const now = options.now ?? this.now();
    const layers = MEMORY_LAYERS.reduce(
      (accumulator, layer) => {
        accumulator[layer] = 0;
        return accumulator;
      },
      {} as Record<MemoryLayer, number>
    );

    let expired = 0;
    let updatedAt = 0;

    for (const item of this.items.values()) {
      if (item.workspaceKey !== workspaceKey) {
        continue;
      }
      if (isExpired(item, now)) {
        expired += 1;
        continue;
      }
      layers[item.layer] += 1;
      updatedAt = Math.max(updatedAt, item.updatedAt);
    }

    return { workspaceKey, layers, expired, updatedAt };
  }
}

/** Deduplicate identical statements coming from different sources. */
export function dedupeByStatement(items: ProjectMemoryItem[]): ProjectMemoryItem[] {
  const seen = new Map<string, ProjectMemoryItem>();
  for (const item of items) {
    const key = item.layer + '::' + item.statement.trim().toLowerCase();
    const existing = seen.get(key);
    if (!existing || existing.confidence < item.confidence) {
      seen.set(key, item);
    }
  }
  return Array.from(seen.values());
}

/** Helper to build provenance without repeating the shape everywhere. */
export function provenance(
  source: MemoryProvenance['source'],
  reference: string,
  locator?: string
): MemoryProvenance {
  return locator ? { source, reference, locator } : { source, reference };
}
