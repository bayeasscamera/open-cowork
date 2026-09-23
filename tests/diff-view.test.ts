import { describe, expect, it } from 'vitest';
import {
  MAX_DIFF_LINES,
  buildDiffView,
  diffLineAnchor,
  groupDiffHunks,
  toDiffLines,
  type DiffLine,
} from '../src/shared/diff-view';

function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => prefix + (index + 1));
}

describe('toDiffLines', () => {
  it('treats an empty file as having no lines', () => {
    expect(toDiffLines('')).toEqual([]);
  });

  it('drops the phantom line produced by a trailing newline', () => {
    expect(toDiffLines('a\nb\n')).toEqual(['a', 'b']);
    expect(toDiffLines('a\nb')).toEqual(['a', 'b']);
  });

  it('keeps genuine blank lines', () => {
    expect(toDiffLines('\n')).toEqual(['']);
    expect(toDiffLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });
});

describe('buildDiffView', () => {
  it('returns nothing when both sides are null', () => {
    expect(buildDiffView(null, null)).toEqual({
      hunks: [],
      added: 0,
      removed: 0,
      truncated: false,
    });
  });

  it('numbers every line of a created file as added', () => {
    const view = buildDiffView(null, 'a\nb\n');
    expect(view.added).toBe(2);
    expect(view.removed).toBe(0);
    expect(view.hunks).toHaveLength(1);
    expect(view.hunks[0].lines).toEqual([
      { kind: 'added', text: 'a', oldLine: null, newLine: 1 },
      { kind: 'added', text: 'b', oldLine: null, newLine: 2 },
    ]);
  });

  it('numbers every line of a deleted file as removed', () => {
    const view = buildDiffView('a\nb\n', null);
    expect(view.added).toBe(0);
    expect(view.removed).toBe(2);
    expect(view.hunks[0].lines).toEqual([
      { kind: 'removed', text: 'a', oldLine: 1, newLine: null },
      { kind: 'removed', text: 'b', oldLine: 2, newLine: null },
    ]);
  });

  it('reports no hunk when the content is unchanged', () => {
    const view = buildDiffView('a\nb\n', 'a\nb\n');
    expect(view.hunks).toEqual([]);
    expect(view.added).toBe(0);
    expect(view.removed).toBe(0);
  });

  it('numbers both sides of a replaced line and keeps the surrounding context', () => {
    const view = buildDiffView('a\nb\nc\n', 'a\nB\nc\n');
    expect(view.added).toBe(1);
    expect(view.removed).toBe(1);
    expect(view.hunks).toHaveLength(1);
    expect(view.hunks[0].header).toBe('@@ -1,3 +1,3 @@');
    expect(view.hunks[0].lines.map((line) => line.kind)).toEqual([
      'context',
      'removed',
      'added',
      'context',
    ]);
    expect(view.hunks[0].lines[1]).toEqual({ kind: 'removed', text: 'b', oldLine: 2, newLine: null });
    expect(view.hunks[0].lines[2]).toEqual({ kind: 'added', text: 'B', oldLine: null, newLine: 2 });
  });

  it('limits a hunk to the requested context lines', () => {
    const before = numbered('L', 20).join('\n');
    const after = numbered('L', 20);
    after[14] = 'changed';
    const view = buildDiffView(before, after.join('\n'));
    expect(view.hunks).toHaveLength(1);
    const hunk = view.hunks[0];
    expect(hunk.header).toBe('@@ -12,7 +12,7 @@');
    expect(hunk.lines).toHaveLength(8);
    expect(hunk.lines[0]).toMatchObject({ kind: 'context', oldLine: 12, newLine: 12 });
    expect(hunk.lines[7]).toMatchObject({ kind: 'context', oldLine: 18, newLine: 18 });
  });

  it('splits distant changes into separate hunks', () => {
    const after = numbered('L', 30);
    after[4] = 'first';
    after[24] = 'second';
    const view = buildDiffView(numbered('L', 30).join('\n'), after.join('\n'));
    expect(view.hunks).toHaveLength(2);
    expect(view.hunks[0].header).toBe('@@ -2,7 +2,7 @@');
    expect(view.hunks[1].header).toBe('@@ -22,7 +22,7 @@');
  });

  it('merges changes separated by less than twice the context', () => {
    const after = numbered('L', 30);
    after[4] = 'first';
    after[7] = 'second';
    const view = buildDiffView(numbered('L', 30).join('\n'), after.join('\n'));
    expect(view.hunks).toHaveLength(1);
    expect(view.hunks[0].header).toBe('@@ -2,10 +2,10 @@');
  });

  it('marks a pure insertion with a null old line', () => {
    const view = buildDiffView('a\nc\n', 'a\nb\nc\n');
    expect(view.added).toBe(1);
    expect(view.removed).toBe(0);
    const added = view.hunks[0].lines.find((line) => line.kind === 'added');
    expect(added).toEqual({ kind: 'added', text: 'b', oldLine: null, newLine: 2 });
  });

  it('honours a custom context size', () => {
    const after = numbered('L', 20);
    after[9] = 'changed';
    const view = buildDiffView(numbered('L', 20).join('\n'), after.join('\n'), { contextLines: 0 });
    expect(view.hunks[0].lines).toHaveLength(2);
    expect(view.hunks[0].header).toBe('@@ -10,1 +10,1 @@');
  });

  it('falls back to a truncated whole-block diff for huge files', () => {
    const before = numbered('old-', MAX_DIFF_LINES + 1).join('\n');
    const after = numbered('new-', MAX_DIFF_LINES + 1).join('\n');
    const view = buildDiffView(before, after);
    expect(view.truncated).toBe(true);
    expect(view.removed).toBe(MAX_DIFF_LINES + 1);
    expect(view.added).toBe(MAX_DIFF_LINES + 1);
    expect(view.hunks).toHaveLength(1);
  });

  it('does not flag a small change as truncated', () => {
    expect(buildDiffView('a\n', 'b\n').truncated).toBe(false);
  });
});

describe('groupDiffHunks', () => {
  it('returns no hunk for an empty script', () => {
    expect(groupDiffHunks([])).toEqual([]);
  });

  it('returns no hunk for an all-context script', () => {
    const ops: DiffLine[] = [{ kind: 'context', text: 'a', oldLine: 1, newLine: 1 }];
    expect(groupDiffHunks(ops)).toEqual([]);
  });
});

describe('diffLineAnchor', () => {
  it('prefers the new file line number', () => {
    expect(diffLineAnchor({ kind: 'added', text: 'a', oldLine: null, newLine: 7 })).toBe(7);
  });

  it('falls back to the old file line number for a deletion', () => {
    expect(diffLineAnchor({ kind: 'removed', text: 'a', oldLine: 4, newLine: null })).toBe(4);
  });

  it('falls back to the first line when neither side is numbered', () => {
    expect(diffLineAnchor({ kind: 'context', text: 'a', oldLine: null, newLine: null })).toBe(1);
  });
});
