import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveWorkspaceFile } from '../src/main/utils/workspace-path';

let root = '';
let outsideFile = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'workspace-path-'));
  outsideFile = join(tmpdir(), 'workspace-path-outside-' + process.pid + '.ts');
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

describe('resolveWorkspaceFile', () => {
  it('resolves a relative path inside the root', () => {
    expect(resolveWorkspaceFile(root, 'src.ts')).toBe(join(root, 'src.ts'));
  });

  it('resolves a nested relative path', () => {
    expect(resolveWorkspaceFile(root, 'nested/deep.ts')).toBe(join(root, 'nested', 'deep.ts'));
  });

  it('accepts an absolute path inside the root', () => {
    expect(resolveWorkspaceFile(root, join(root, 'src.ts'))).toBe(join(root, 'src.ts'));
  });

  it('refuses a traversal escape', () => {
    expect(resolveWorkspaceFile(root, '../outside.ts')).toBeNull();
  });

  it('refuses an absolute path outside the root', () => {
    expect(resolveWorkspaceFile(root, outsideFile)).toBeNull();
  });

  it('refuses a symlink pointing outside the root', () => {
    expect(resolveWorkspaceFile(root, 'escape.ts')).toBeNull();
  });

  it('refuses a directory', () => {
    expect(resolveWorkspaceFile(root, 'folder')).toBeNull();
  });

  it('refuses a missing file', () => {
    expect(resolveWorkspaceFile(root, 'nope.ts')).toBeNull();
  });

  it('refuses blank and non-string input', () => {
    expect(resolveWorkspaceFile(root, '   ')).toBeNull();
    expect(resolveWorkspaceFile(root, '')).toBeNull();
    expect(resolveWorkspaceFile(root, 42)).toBeNull();
    expect(resolveWorkspaceFile(root, null)).toBeNull();
  });

  it('refuses control characters', () => {
    expect(resolveWorkspaceFile(root, 'src.ts\u0000')).toBeNull();
    expect(resolveWorkspaceFile(root, 'src\u0007.ts')).toBeNull();
  });
});
