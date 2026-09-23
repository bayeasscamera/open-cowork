/**
 * @module shared/write-scope-conflicts
 *
 * Cowork 4.0 — Lot D: sub-agent conflict handling.
 *
 * Two sub-agents that run concurrently and declare overlapping write scopes
 * race on the same files: the last writer wins, and the evidence the other
 * agent produced describes a state that no longer exists. Nothing prevented
 * that before — `writeScope` was only rendered as prompt text, and the
 * scheduler serialised writers on a single boolean that ignored the paths.
 *
 * This module is the pure, filesystem-free algebra shared by the planner (to
 * report conflicts and re-order execution groups) and the orchestrator (to
 * refuse to start two overlapping writers in the same batch).
 *
 * Overlap detection is deliberately conservative: when in doubt it reports a
 * conflict, because serialising two agents costs a little time while a lost
 * write costs correctness. A glob whose static prefix is a prefix of another
 * scope is therefore treated as overlapping even when the concrete path would
 * not match (e.g. `*.ts` vs `src/a.ts`).
 */

/** The minimum shape needed to reason about write conflicts. */
export interface WriteScopeTask {
  id: string;
  writeScope: readonly string[];
  dependsOn?: readonly string[];
}

/** Two tasks that would write the same files if they ran concurrently. */
export interface WriteScopeConflict {
  /** Id of the first task, in plan order. */
  a: string;
  /** Id of the second task, in plan order. */
  b: string;
  /** Declared scope entries (from either side) that overlap. Sorted, unique. */
  paths: string[];
}

export interface SerializedGroups {
  /** Groups with conflicting tasks pushed into a later group. */
  groups: string[][];
  /** Ordering edges added to remove a conflict: `before` runs first. */
  serialized: Array<{ before: string; after: string }>;
}

const MAGIC_TOKENS = ['*', '?', '['];

/**
 * Canonical form of one declared scope entry: forward slashes, no duplicate
 * separators, no leading `./`, no trailing slash. The empty string means the
 * workspace root (it overlaps everything). `null` means the entry is unusable.
 */
export function normalizeScopeEntry(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  let value = raw.trim().replace(/\\/g, '/');
  value = value.replace(/\/{2,}/g, '/');
  while (value.startsWith('./')) {
    value = value.slice(2);
  }
  value = value.replace(/\/+$/, '');
  return value === '.' ? '' : value;
}

/** True when the entry contains a glob metacharacter. */
export function hasGlobMagic(entry: string): boolean {
  for (const token of MAGIC_TOKENS) {
    if (entry.includes(token)) {
      return true;
    }
  }
  return false;
}

/** Path segments of a normalised entry; the root is the empty list. */
export function scopeSegments(entry: string): string[] {
  return entry === '' ? [] : entry.split('/');
}

/** Segments before the first glob metacharacter. */
export function staticPrefixSegments(entry: string): string[] {
  const prefix: string[] = [];
  for (const segment of scopeSegments(entry)) {
    if (hasGlobMagic(segment)) {
      break;
    }
    prefix.push(segment);
  }
  return prefix;
}

function isSegmentPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) {
    return false;
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (prefix[index] !== full[index]) {
      return false;
    }
  }
  return true;
}

/** True when two declared entries can name the same file or directory. */
export function scopeEntriesOverlap(a: string, b: string): boolean {
  const left = normalizeScopeEntry(a);
  const right = normalizeScopeEntry(b);
  if (left === null || right === null) {
    return false;
  }
  const leftMagic = hasGlobMagic(left);
  const rightMagic = hasGlobMagic(right);

  if (!leftMagic && !rightMagic) {
    const leftSegments = scopeSegments(left);
    const rightSegments = scopeSegments(right);
    return (
      isSegmentPrefix(leftSegments, rightSegments) ||
      isSegmentPrefix(rightSegments, leftSegments)
    );
  }

  if (leftMagic && rightMagic) {
    const leftPrefix = staticPrefixSegments(left);
    const rightPrefix = staticPrefixSegments(right);
    return (
      isSegmentPrefix(leftPrefix, rightPrefix) || isSegmentPrefix(rightPrefix, leftPrefix)
    );
  }

  const globPrefix = staticPrefixSegments(leftMagic ? left : right);
  const concrete = scopeSegments(leftMagic ? right : left);
  return isSegmentPrefix(globPrefix, concrete) || isSegmentPrefix(concrete, globPrefix);
}

/**
 * Declared entries from either scope that overlap, normalised, sorted and
 * de-duplicated. An empty result means the two scopes are provably disjoint.
 */
export function overlappingScopePaths(a: readonly string[], b: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const left of a) {
    for (const right of b) {
      if (!scopeEntriesOverlap(left, right)) {
        continue;
      }
      const leftEntry = normalizeScopeEntry(left);
      const rightEntry = normalizeScopeEntry(right);
      if (leftEntry) {
        paths.add(leftEntry);
      }
      if (rightEntry) {
        paths.add(rightEntry);
      }
    }
  }
  return Array.from(paths).sort();
}

/** True when the two write scopes can name the same file. */
export function writeScopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return overlappingScopePaths(a, b).length > 0;
}

/** True when `to` is reachable from `from` through `dependsOn` edges. */
export function dependsTransitively(
  tasks: readonly WriteScopeTask[],
  from: string,
  to: string
): boolean {
  if (from === to) {
    return false;
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>([from]);
  const stack: string[] = [from];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) {
      break;
    }
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (dependency === to) {
        return true;
      }
      if (!seen.has(dependency)) {
        seen.add(dependency);
        stack.push(dependency);
      }
    }
  }
  return false;
}

/**
 * Every pair of writing tasks that is *not* ordered by a dependency and whose
 * declared write scopes overlap. Ordered pairs are skipped: they already run
 * one after the other, so they cannot race.
 */
export function findWriteScopeConflicts(
  tasks: readonly WriteScopeTask[]
): WriteScopeConflict[] {
  const writers = tasks.filter((task) => (task.writeScope ?? []).length > 0);
  const conflicts: WriteScopeConflict[] = [];
  for (let index = 0; index < writers.length; index += 1) {
    for (let other = index + 1; other < writers.length; other += 1) {
      const a = writers[index];
      const b = writers[other];
      if (dependsTransitively(tasks, a.id, b.id) || dependsTransitively(tasks, b.id, a.id)) {
        continue;
      }
      const paths = overlappingScopePaths(a.writeScope, b.writeScope);
      if (paths.length > 0) {
        conflicts.push({ a: a.id, b: b.id, paths });
      }
    }
  }
  return conflicts;
}

/** Every task id involved in at least one conflict, sorted. */
export function conflictingTaskIds(conflicts: readonly WriteScopeConflict[]): string[] {
  const ids = new Set<string>();
  for (const conflict of conflicts) {
    ids.add(conflict.a);
    ids.add(conflict.b);
  }
  return Array.from(ids).sort();
}

/** Conflicts a given task takes part in. */
export function conflictsForTask(
  conflicts: readonly WriteScopeConflict[],
  taskId: string
): WriteScopeConflict[] {
  return conflicts.filter((conflict) => conflict.a === taskId || conflict.b === taskId);
}

/**
 * Re-order dependency groups so no two tasks inside one group conflict: a
 * conflicting task is deferred to the next group, and the added ordering edge
 * is returned so the plan can explain why. Deterministic: the original order
 * inside a group is preserved, and the first task of a group is always kept.
 */
export function serializeConflictingGroups(
  groups: readonly (readonly string[])[],
  conflicts: readonly WriteScopeConflict[]
): SerializedGroups {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    const set = neighbours.get(a) ?? new Set<string>();
    set.add(b);
    neighbours.set(a, set);
  };
  for (const conflict of conflicts) {
    link(conflict.a, conflict.b);
    link(conflict.b, conflict.a);
  }
  const collide = (a: string, b: string): boolean => neighbours.get(a)?.has(b) === true;

  const resolved: string[][] = [];
  const serialized: Array<{ before: string; after: string }> = [];
  const pending: string[][] = groups.map((group) => [...group]);

  while (pending.length > 0) {
    const group = pending.shift();
    if (group === undefined) {
      break;
    }
    const placed: string[] = [];
    const deferred: string[] = [];
    for (const id of group) {
      const blocker = placed.find((candidate) => collide(candidate, id));
      if (blocker === undefined) {
        placed.push(id);
      } else {
        deferred.push(id);
        serialized.push({ before: blocker, after: id });
      }
    }
    if (placed.length > 0) {
      resolved.push(placed);
    }
    if (deferred.length > 0) {
      pending.unshift(deferred);
    }
  }

  return { groups: resolved, serialized };
}
