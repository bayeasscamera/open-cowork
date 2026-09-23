import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  buildEditorUrl,
  detectEditorSchemes,
  normalizeEditorLine,
  openFileInEditor,
  resolveEditorTarget,
  type EditorOpener,
} from '../src/main/utils/open-in-editor';

let root = '';
let outsideFile = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'open-in-editor-'));
  outsideFile = join(tmpdir(), 'open-in-editor-outside-' + process.pid + '.ts');
  writeFileSync(join(root, 'src.ts'), 'export const a = 1;\n');
  writeFileSync(outsideFile, 'outside\n');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'deep.ts'), 'export const b = 2;\n');
  mkdirSync(join(root, 'folder'));
  symlinkSync(outsideFile, join(root, 'escape.ts'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideFile, { force: true });
});

function fakeOpener(overrides: Partial<EditorOpener> = {}): {
  opener: EditorOpener;
  openExternal: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
} {
  const openExternal = vi.fn(async () => undefined);
  const openPath = vi.fn(async () => '');
  const opener: EditorOpener = {
    openExternal: overrides.openExternal ?? openExternal,
    openPath: overrides.openPath ?? openPath,
  };
  return { opener, openExternal, openPath };
}

describe('detectEditorSchemes', () => {
  const base = { home: '/Users/dev', pathEntries: [] as string[], exists: () => false };

  it('finds a macOS application bundle in /Applications', () => {
    const schemes = detectEditorSchemes({
      ...base,
      platform: 'darwin',
      exists: (candidate) => candidate === join('/Applications', 'Cursor.app'),
    });
    expect(schemes).toEqual(['cursor']);
  });

  it('finds a macOS application bundle in the user Applications folder', () => {
    const schemes = detectEditorSchemes({
      ...base,
      platform: 'darwin',
      exists: (candidate) => candidate === join('/Users/dev', 'Applications', 'Zed.app'),
    });
    expect(schemes).toEqual(['zed']);
  });

  it('keeps the preference order when several editors are installed', () => {
    const schemes = detectEditorSchemes({
      ...base,
      platform: 'darwin',
      exists: (candidate) =>
        candidate === join('/Applications', 'Visual Studio Code.app') ||
        candidate === join('/Applications', 'Cursor.app'),
    });
    expect(schemes).toEqual(['vscode', 'cursor']);
  });

  it('finds a binary on PATH on linux', () => {
    const schemes = detectEditorSchemes({
      ...base,
      platform: 'linux',
      pathEntries: ['/usr/local/bin', '/usr/bin'],
      exists: (candidate) => candidate === join('/usr/local/bin', 'code'),
    });
    expect(schemes).toEqual(['vscode']);
  });

  it('accepts the .cmd shim on Windows', () => {
    const schemes = detectEditorSchemes({
      ...base,
      platform: 'win32',
      pathEntries: ['C:\\tools'],
      exists: (candidate) => candidate === join('C:\\tools', 'code.cmd'),
    });
    expect(schemes).toEqual(['vscode']);
  });

  it('ignores empty PATH entries', () => {
    const schemes = detectEditorSchemes({
      ...base,
      platform: 'linux',
      pathEntries: ['', '/usr/bin'],
      exists: () => false,
    });
    expect(schemes).toEqual([]);
  });

  it('reports nothing when no editor is installed', () => {
    expect(detectEditorSchemes({ ...base, platform: 'darwin' })).toEqual([]);
  });
});

describe('normalizeEditorLine', () => {
  it('keeps a positive integer', () => {
    expect(normalizeEditorLine(1)).toBe(1);
    expect(normalizeEditorLine(432)).toBe(432);
  });

  it('floors a fractional line', () => {
    expect(normalizeEditorLine(12.9)).toBe(12);
  });

  it('rejects zero, negatives and non-finite numbers', () => {
    expect(normalizeEditorLine(0)).toBeNull();
    expect(normalizeEditorLine(-3)).toBeNull();
    expect(normalizeEditorLine(Number.NaN)).toBeNull();
    expect(normalizeEditorLine(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeEditorLine(2_000_000)).toBeNull();
  });

  it('rejects a non-number', () => {
    expect(normalizeEditorLine('12')).toBeNull();
    expect(normalizeEditorLine(null)).toBeNull();
    expect(normalizeEditorLine(undefined)).toBeNull();
  });
});

describe('buildEditorUrl', () => {
  it('builds a VS Code deep link with a line and column', () => {
    expect(buildEditorUrl('vscode', '/Users/dev/a b/src.ts', 12)).toBe(
      'vscode://file/Users/dev/a%20b/src.ts:12:1'
    );
  });

  it('omits the position when there is no line', () => {
    expect(buildEditorUrl('vscode', '/Users/dev/src.ts', null)).toBe(
      'vscode://file/Users/dev/src.ts'
    );
  });

  it('uses the Sublime query format', () => {
    expect(buildEditorUrl('subl', '/Users/dev/src.ts', 7)).toBe(
      'subl://open?url=file:///Users/dev/src.ts&line=7'
    );
    expect(buildEditorUrl('subl', '/Users/dev/src.ts', null)).toBe(
      'subl://open?url=file:///Users/dev/src.ts'
    );
  });

  it('normalizes Windows separators', () => {
    expect(buildEditorUrl('vscode', 'C:\\proj\\src.ts', 3)).toBe('vscode://file/C:/proj/src.ts:3:1');
  });
});

describe('resolveEditorTarget', () => {
  it('resolves a relative path inside the root', () => {
    expect(resolveEditorTarget(root, 'src.ts')).toBe(join(root, 'src.ts'));
  });

  it('resolves a nested relative path', () => {
    expect(resolveEditorTarget(root, 'nested/deep.ts')).toBe(join(root, 'nested', 'deep.ts'));
  });

  it('accepts an absolute path inside the root', () => {
    expect(resolveEditorTarget(root, join(root, 'src.ts'))).toBe(join(root, 'src.ts'));
  });

  it('refuses a traversal escape', () => {
    expect(resolveEditorTarget(root, '../outside.ts')).toBeNull();
  });

  it('refuses an absolute path outside the root', () => {
    expect(resolveEditorTarget(root, outsideFile)).toBeNull();
  });

  it('refuses a symlink pointing outside the root', () => {
    expect(resolveEditorTarget(root, 'escape.ts')).toBeNull();
  });

  it('refuses a directory', () => {
    expect(resolveEditorTarget(root, 'folder')).toBeNull();
  });

  it('refuses a missing file', () => {
    expect(resolveEditorTarget(root, 'nope.ts')).toBeNull();
  });

  it('refuses blank and non-string input', () => {
    expect(resolveEditorTarget(root, '   ')).toBeNull();
    expect(resolveEditorTarget(root, '')).toBeNull();
    expect(resolveEditorTarget(root, 42)).toBeNull();
    expect(resolveEditorTarget(root, null)).toBeNull();
  });

  it('refuses control characters', () => {
    expect(resolveEditorTarget(root, 'src.ts\u0000')).toBeNull();
    expect(resolveEditorTarget(root, 'src\u0007.ts')).toBeNull();
  });
});

describe('openFileInEditor', () => {
  it('opens through the first working editor scheme', async () => {
    const { opener, openExternal, openPath } = fakeOpener();
    const result = await openFileInEditor(
      { root, path: 'src.ts', line: 12, schemes: ['vscode'] },
      opener
    );
    expect(result).toEqual({ success: true, method: 'vscode' });
    expect(openExternal).toHaveBeenCalledWith(
      'vscode://file' + encodeURI(join(root, 'src.ts')) + ':12:1'
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it('omits the position when no line is given', async () => {
    const { opener, openExternal } = fakeOpener();
    await openFileInEditor({ root, path: 'src.ts', schemes: ['vscode'] }, opener);
    expect(openExternal).toHaveBeenCalledWith('vscode://file' + encodeURI(join(root, 'src.ts')));
  });

  it('treats line 0 as no line', async () => {
    const { opener, openExternal } = fakeOpener();
    await openFileInEditor({ root, path: 'src.ts', line: 0, schemes: ['vscode'] }, opener);
    expect(openExternal).toHaveBeenCalledWith('vscode://file' + encodeURI(join(root, 'src.ts')));
  });

  it('falls through to the next scheme when one fails', async () => {
    const openExternal = vi.fn(async (url: string) => {
      if (url.startsWith('vscode://')) throw new Error('no handler');
    });
    const { opener } = fakeOpener({ openExternal });
    const result = await openFileInEditor(
      { root, path: 'src.ts', schemes: ['vscode', 'cursor'] },
      opener
    );
    expect(result).toEqual({ success: true, method: 'cursor' });
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('falls back to the OS default application when no scheme works', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('no handler');
    });
    const { opener, openPath } = fakeOpener({ openExternal });
    const result = await openFileInEditor(
      { root, path: 'src.ts', schemes: ['vscode', 'cursor'] },
      opener
    );
    expect(result).toEqual({ success: true, method: 'default' });
    expect(openPath).toHaveBeenCalledWith(join(root, 'src.ts'));
  });

  it('reports a failure when the default application refuses the file', async () => {
    const openPath = vi.fn(async () => 'no application knows how to open this');
    const { opener } = fakeOpener({ openPath });
    const result = await openFileInEditor({ root, path: 'src.ts', schemes: [] }, opener);
    expect(result).toEqual({ success: false, error: 'open_failed' });
  });

  it('reports a failure when the default application throws', async () => {
    const openPath = vi.fn(async () => {
      throw new Error('boom');
    });
    const { opener } = fakeOpener({ openPath });
    const result = await openFileInEditor({ root, path: 'src.ts', schemes: [] }, opener);
    expect(result).toEqual({ success: false, error: 'open_failed' });
  });

  it('never asks the OS to open a target outside the workspace', async () => {
    const { opener, openExternal, openPath } = fakeOpener();
    const result = await openFileInEditor(
      { root, path: outsideFile, schemes: ['vscode'] },
      opener
    );
    expect(result).toEqual({ success: false, error: 'invalid_target' });
    expect(openExternal).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });
});
