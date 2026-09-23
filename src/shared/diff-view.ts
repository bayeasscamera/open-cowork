/**
 * @module shared/diff-view
 *
 * Pure structured diff builder shared by the renderer diff panel and any main
 * process consumer. A before/after pair becomes numbered hunks so the UI can
 * render an integrated diff (per-line colours, real line numbers) and offer
 * "open at line" without re-implementing the algorithm in the component.
 *
 * Dependency-free and bounded: a changed block larger than MAX_DIFF_LINES
 * falls back to a whole-block diff flagged as truncated, mirroring the
 * bounded LCS used by the session diff collector.
 */

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the "before" file; null for an added line. */
  oldLine: number | null;
  /** 1-based line number in the "after" file; null for a removed line. */
  newLine: number | null;
}

export interface DiffHunk {
  /** Unified-diff range header, e.g. "@@ -12,4 +12,6 @@". */
  header: string;
  lines: DiffLine[];
}

export interface DiffView {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the inputs exceeded the bound and hunks are a whole-block diff. */
  truncated: boolean;
}

export const DEFAULT_CONTEXT_LINES = 3;
export const MAX_DIFF_LINES = 2000;

/**
 * Split file content into lines without the phantom trailing empty line that a
 * trailing newline would otherwise produce. An empty file has no lines.
 */
export function toDiffLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line number a click should jump to: the new file when the line exists there. */
export function diffLineAnchor(line: DiffLine): number {
  return line.newLine ?? line.oldLine ?? 1;
}

function contextLine(text: string, oldLine: number, newLine: number): DiffLine {
  return { kind: 'context', text, oldLine, newLine };
}

/**
 * LCS edit script for the changed middle section, with absolute line numbers
 * (base = number of unchanged leading lines). Bounded by MAX_DIFF_LINES.
 */
function lcsOps(midOld: string[], midNew: string[], base: number): DiffLine[] {
  const rows = midOld.length;
  const cols = midNew.length;
  if (rows === 0 && cols === 0) return [];
  if (rows === 0) {
    return midNew.map((text, j) => ({ kind: 'added' as const, text, oldLine: null, newLine: base + j + 1 }));
  }
  if (cols === 0) {
    return midOld.map((text, i) => ({ kind: 'removed' as const, text, oldLine: base + i + 1, newLine: null }));
  }
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = midOld[i] === midNew[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (midOld[i] === midNew[j]) {
      ops.push(contextLine(midOld[i], base + i + 1, base + j + 1));
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: 'removed', text: midOld[i], oldLine: base + i + 1, newLine: null });
      i += 1;
    } else {
      ops.push({ kind: 'added', text: midNew[j], oldLine: null, newLine: base + j + 1 });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ kind: 'removed', text: midOld[i], oldLine: base + i + 1, newLine: null });
    i += 1;
  }
  while (j < cols) {
    ops.push({ kind: 'added', text: midNew[j], oldLine: null, newLine: base + j + 1 });
    j += 1;
  }
  return ops;
}

function buildOps(oldLines: string[], newLines: string[]): { ops: DiffLine[]; truncated: boolean } {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const ops: DiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push(contextLine(oldLines[i], i + 1, i + 1));
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);
  let truncated = false;
  if (midOld.length > MAX_DIFF_LINES || midNew.length > MAX_DIFF_LINES) {
    // Honest fallback for huge files: report the whole changed block.
    truncated = true;
    for (let i = 0; i < midOld.length; i += 1) {
      ops.push({ kind: 'removed', text: midOld[i], oldLine: prefix + i + 1, newLine: null });
    }
    for (let j = 0; j < midNew.length; j += 1) {
      ops.push({ kind: 'added', text: midNew[j], oldLine: null, newLine: prefix + j + 1 });
    }
  } else {
    ops.push(...lcsOps(midOld, midNew, prefix));
  }

  const oldSuffixStart = oldLines.length - suffix;
  const newSuffixStart = newLines.length - suffix;
  for (let i = 0; i < suffix; i += 1) {
    ops.push(contextLine(oldLines[oldSuffixStart + i], oldSuffixStart + i + 1, newSuffixStart + i + 1));
  }
  return { ops, truncated };
}

function rangeOf(lines: DiffLine[], side: 'old' | 'new'): { start: number; count: number } {
  let start = 0;
  let count = 0;
  for (const line of lines) {
    const value = side === 'old' ? line.oldLine : line.newLine;
    if (value !== null) {
      if (count === 0) start = value;
      count += 1;
    }
  }
  return { start, count };
}

/**
 * Group a flat edit script into unified-diff hunks: changes closer than
 * 2 * contextLines merge into one hunk, and each hunk keeps contextLines of
 * surrounding context. A script with no change produces no hunk.
 */
export function groupDiffHunks(
  ops: DiffLine[],
  contextLines: number = DEFAULT_CONTEXT_LINES
): DiffHunk[] {
  const context = Number.isFinite(contextLines) ? Math.max(0, Math.floor(contextLines)) : 0;
  const changed: number[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].kind !== 'context') changed.push(index);
  }
  if (changed.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let start = changed[0];
  let end = changed[0];
  for (let k = 1; k < changed.length; k += 1) {
    const index = changed[k];
    if (index - end - 1 <= context * 2) {
      end = index;
    } else {
      ranges.push([start, end]);
      start = index;
      end = index;
    }
  }
  ranges.push([start, end]);

  return ranges.map(([from, to]) => {
    const begin = Math.max(0, from - context);
    const finish = Math.min(ops.length - 1, to + context);
    const lines = ops.slice(begin, finish + 1);
    const oldRange = rangeOf(lines, 'old');
    const newRange = rangeOf(lines, 'new');
    return {
      header:
        '@@ -' + oldRange.start + ',' + oldRange.count + ' +' + newRange.start + ',' + newRange.count + ' @@',
      lines,
    };
  });
}

/**
 * Build the structured diff of a before/after pair. before === null means the
 * file was created, after === null means it was deleted; both null is empty.
 */
export function buildDiffView(
  before: string | null,
  after: string | null,
  options: { contextLines?: number } = {}
): DiffView {
  if (before === null && after === null) {
    return { hunks: [], added: 0, removed: 0, truncated: false };
  }
  const oldLines = before === null ? [] : toDiffLines(before);
  const newLines = after === null ? [] : toDiffLines(after);
  const { ops, truncated } = buildOps(oldLines, newLines);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === 'added') added += 1;
    else if (op.kind === 'removed') removed += 1;
  }
  return { hunks: groupDiffHunks(ops, options.contextLines), added, removed, truncated };
}
