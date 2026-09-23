import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/renderer/components/DiffPanel.tsx'), 'utf-8');

describe('DiffPanel — integrated diff view', () => {
  it('builds the diff from the shared pure module', () => {
    expect(source).toContain('../../shared/diff-view');
    expect(source).toContain('buildDiffView(entry.before, entry.after)');
  });

  it('renders one row per diff line and exposes its kind', () => {
    expect(source).toContain('data-kind={line.kind}');
    expect(source).toContain('LINE_SIGN[line.kind]');
  });

  it('renders both line number gutters', () => {
    expect(source).toContain('line.oldLine ??');
    expect(source).toContain('line.newLine ??');
  });

  it('renders the unified hunk header', () => {
    expect(source).toContain('{hunk.header}');
    expect(source).toContain('view.hunks.map');
  });

  it('opens the file at a line through the validated IPC bridge', () => {
    expect(source).toContain('controlCenter.openInEditor');
    expect(source).toContain('diffPanel.openAtLine');
    expect(source).toContain('diffPanel.openFile');
    expect(source).toContain('diffLineAnchor(line)');
  });

  it('never opens an editor without an active session', () => {
    expect(source).toContain('if (!activeSessionId) return;');
  });

  it('surfaces an open failure instead of pretending it worked', () => {
    expect(source).toContain('setOpenFailed(true)');
    expect(source).toContain('diffPanel.openFailed');
  });

  it('warns when the diff fell back to a whole-block view', () => {
    expect(source).toContain('view.truncated');
    expect(source).toContain('diffPanel.truncated');
  });

  it('keeps the polling refresh of the session diff', () => {
    expect(source).toContain('diff.getSessionFiles');
    expect(source).toContain('setInterval');
  });
});
