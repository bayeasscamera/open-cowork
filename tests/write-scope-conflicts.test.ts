import { describe, expect, it } from 'vitest';
import {
  conflictingTaskIds,
  conflictsForTask,
  dependsTransitively,
  findWriteScopeConflicts,
  normalizeScopeEntry,
  overlappingScopePaths,
  scopeEntriesOverlap,
  serializeConflictingGroups,
  staticPrefixSegments,
  writeScopesOverlap,
} from '../src/shared/write-scope-conflicts';

describe('normalizeScopeEntry', () => {
  it('canonicalises separators and relative prefixes', () => {
    expect(normalizeScopeEntry('  src\\main\\a.ts ')).toBe('src/main/a.ts');
    expect(normalizeScopeEntry('./src//a.ts')).toBe('src/a.ts');
    expect(normalizeScopeEntry('src/a.ts/')).toBe('src/a.ts');
    expect(normalizeScopeEntry('.')).toBe('');
  });

  it('rejects non-strings', () => {
    expect(normalizeScopeEntry(42)).toBeNull();
    expect(normalizeScopeEntry(null)).toBeNull();
    expect(normalizeScopeEntry(undefined)).toBeNull();
  });
});

describe('scopeEntriesOverlap', () => {
  it('matches identical and ancestor paths', () => {
    expect(scopeEntriesOverlap('src/a.ts', 'src/a.ts')).toBe(true);
    expect(scopeEntriesOverlap('src', 'src/main/a.ts')).toBe(true);
    expect(scopeEntriesOverlap('src/main/a.ts', 'src')).toBe(true);
  });

  it('does not match siblings or segment-prefix lookalikes', () => {
    expect(scopeEntriesOverlap('src/a.ts', 'src/b.ts')).toBe(false);
    expect(scopeEntriesOverlap('src', 'src2/a.ts')).toBe(false);
    expect(scopeEntriesOverlap('tests/a.ts', 'src/a.ts')).toBe(false);
  });

  it('treats a glob prefix as overlapping its subtree', () => {
    expect(scopeEntriesOverlap('src/**', 'src/main/a.ts')).toBe(true);
    expect(scopeEntriesOverlap('src/**', 'src')).toBe(true);
    expect(scopeEntriesOverlap('src/**', 'tests/**')).toBe(false);
    expect(scopeEntriesOverlap('src/*.ts', 'src/a.ts')).toBe(true);
    expect(scopeEntriesOverlap('src/main/*.ts', 'src/a.ts')).toBe(false);
  });

  it('is conservative for a glob whose static prefix is the root', () => {
    // Documented false positive: `*.ts` has an empty static prefix.
    expect(scopeEntriesOverlap('*.ts', 'src/a.ts')).toBe(true);
  });

  it('lets the workspace root overlap everything', () => {
    expect(scopeEntriesOverlap('.', 'anything/at/all.ts')).toBe(true);
    expect(scopeEntriesOverlap('**', 'anything.ts')).toBe(true);
  });
});

describe('staticPrefixSegments', () => {
  it('stops at the first glob segment', () => {
    expect(staticPrefixSegments('src/main/**/*.ts')).toEqual(['src', 'main']);
    expect(staticPrefixSegments('src/a.ts')).toEqual(['src', 'a.ts']);
    expect(staticPrefixSegments('**')).toEqual([]);
  });
});

describe('overlappingScopePaths', () => {
  it('returns the overlapping entries from either side, sorted and unique', () => {
    expect(overlappingScopePaths(['src/a.ts', 'docs/x.md'], ['src/a.ts', 'src'])).toEqual([
      'src',
      'src/a.ts',
    ]);
    expect(overlappingScopePaths(['src/a.ts'], ['tests/**'])).toEqual([]);
  });

  it('exposes a boolean helper', () => {
    expect(writeScopesOverlap(['src/a.ts'], ['src'])).toBe(true);
    expect(writeScopesOverlap(['src/a.ts'], ['tests'])).toBe(false);
  });
});

describe('dependsTransitively', () => {
  const tasks = [
    { id: 'a', writeScope: [], dependsOn: [] },
    { id: 'b', writeScope: [], dependsOn: ['a'] },
    { id: 'c', writeScope: [], dependsOn: ['b'] },
  ];

  it('walks the chain in both directions', () => {
    expect(dependsTransitively(tasks, 'c', 'a')).toBe(true);
    expect(dependsTransitively(tasks, 'a', 'c')).toBe(false);
    expect(dependsTransitively(tasks, 'a', 'a')).toBe(false);
  });
});

describe('findWriteScopeConflicts', () => {
  it('reports unordered overlapping writers', () => {
    const conflicts = findWriteScopeConflicts([
      { id: 'a', writeScope: ['src/a.ts'] },
      { id: 'b', writeScope: ['src/a.ts'] },
    ]);
    expect(conflicts).toEqual([{ a: 'a', b: 'b', paths: ['src/a.ts'] }]);
  });

  it('ignores ordered writers and read-only tasks', () => {
    expect(
      findWriteScopeConflicts([
        { id: 'a', writeScope: ['src/a.ts'] },
        { id: 'b', writeScope: ['src/a.ts'], dependsOn: ['a'] },
        { id: 'c', writeScope: [] },
      ])
    ).toEqual([]);
  });

  it('ignores ordered writers across a longer chain', () => {
    expect(
      findWriteScopeConflicts([
        { id: 'a', writeScope: ['src'] },
        { id: 'b', writeScope: ['src/a.ts'], dependsOn: ['a'] },
        { id: 'c', writeScope: ['src/a.ts'], dependsOn: ['b'] },
      ])
    ).toEqual([]);
  });

  it('reports every conflicting pair deterministically', () => {
    const conflicts = findWriteScopeConflicts([
      { id: 'a', writeScope: ['src'] },
      { id: 'b', writeScope: ['src/a.ts'] },
      { id: 'c', writeScope: ['tests/**'] },
    ]);
    expect(conflicts).toEqual([{ a: 'a', b: 'b', paths: ['src', 'src/a.ts'] }]);
    expect(conflictingTaskIds(conflicts)).toEqual(['a', 'b']);
    expect(conflictsForTask(conflicts, 'b')).toHaveLength(1);
    expect(conflictsForTask(conflicts, 'c')).toEqual([]);
  });
});

function collides(
  conflicts: Array<{ a: string; b: string }>,
  left: string,
  right: string
): boolean {
  return conflicts.some(
    (conflict) =>
      (conflict.a === left && conflict.b === right) ||
      (conflict.a === right && conflict.b === left)
  );
}

describe('serializeConflictingGroups', () => {
  it('defers the conflicting task to the next group', () => {
    const result = serializeConflictingGroups([['a', 'b', 'c']], [
      { a: 'a', b: 'b', paths: ['src/a.ts'] },
    ]);
    expect(result.groups).toEqual([['a', 'c'], ['b']]);
    expect(result.serialized).toEqual([{ before: 'a', after: 'b' }]);
  });

  it('keeps disjoint tasks together', () => {
    const result = serializeConflictingGroups([['a', 'b']], []);
    expect(result.groups).toEqual([['a', 'b']]);
    expect(result.serialized).toEqual([]);
  });

  it('leaves a task that only conflicts with a deferred one in the first group', () => {
    const result = serializeConflictingGroups([['a', 'b', 'c']], [
      { a: 'a', b: 'b', paths: ['src/a.ts'] },
      { a: 'b', b: 'c', paths: ['src/a.ts'] },
    ]);
    expect(result.groups).toEqual([['a', 'c'], ['b']]);
    expect(result.serialized).toEqual([{ before: 'a', after: 'b' }]);
  });

  it('preserves later dependency groups', () => {
    const result = serializeConflictingGroups([['a', 'b'], ['d']], [
      { a: 'a', b: 'b', paths: ['src/a.ts'] },
    ]);
    expect(result.groups).toEqual([['a'], ['b'], ['d']]);
  });

  it('never leaves two conflicting tasks in one group', () => {
    const conflicts = [
      { a: 'a', b: 'b', paths: ['x'] },
      { a: 'a', b: 'c', paths: ['x'] },
      { a: 'b', b: 'c', paths: ['x'] },
      { a: 'c', b: 'd', paths: ['y'] },
    ];
    const result = serializeConflictingGroups([['a', 'b', 'c', 'd']], conflicts);
    for (const group of result.groups) {
      for (const id of group) {
        const partner = group.find((other) => other !== id && collides(conflicts, id, other));
        expect(partner).toBeUndefined();
      }
    }
    expect(result.groups.flat().sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
