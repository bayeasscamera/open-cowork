/**
 * @module shared/diff-preview
 * v3.5: Side-by-Side & Granular Unified Diff Engine
 */

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
}

export interface FileDiffResult {
  filePath: string;
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

export function computeUnifiedDiff(
  filePath: string,
  oldContent: string,
  newContent: string
): FileDiffResult {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;

  let o = 0;
  let n = 0;

  while (o < oldLines.length || n < newLines.length) {
    if (o < oldLines.length && n < newLines.length && oldLines[o] === newLines[n]) {
      lines.push({
        type: 'unchanged',
        oldLineNumber: o + 1,
        newLineNumber: n + 1,
        content: oldLines[o],
      });
      o++;
      n++;
    } else if (o < oldLines.length && (n >= newLines.length || !newLines.includes(oldLines[o]))) {
      lines.push({
        type: 'removed',
        oldLineNumber: o + 1,
        content: oldLines[o],
      });
      deletions++;
      o++;
    } else if (n < newLines.length) {
      lines.push({
        type: 'added',
        newLineNumber: n + 1,
        content: newLines[n],
      });
      additions++;
      n++;
    }
  }

  return {
    filePath,
    lines,
    additions,
    deletions,
  };
}
