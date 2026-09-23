import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_FILE_BYTES,
  isIgnoredWorkspaceName,
  listWorkspaceTree,
  normalizeWorkspaceRelativePath,
  readWorkspaceFile,
  resolveWorkspacePath,
} from '../src/main/workspace/workspace-explorer';

let root = '';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-explorer-'));
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# hello');
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'export const x = 1;');
  await fs.writeFile(path.join(root, 'src', 'nested', 'deep.ts'), 'export const y = 2;');
  await fs.writeFile(path.join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('workspace explorer helpers', () => {
  it('normalizes relative paths and flags ignored names', () => {
    expect(normalizeWorkspaceRelativePath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalizeWorkspaceRelativePath('src/a.ts/')).toBe('src/a.ts');
    expect(isIgnoredWorkspaceName('node_modules')).toBe(true);
    expect(isIgnoredWorkspaceName('.git')).toBe(true);
    expect(isIgnoredWorkspaceName('src')).toBe(false);
  });

  it('refuses paths that escape the workspace', () => {
    expect(() => resolveWorkspacePath(root, '../escape.txt')).toThrow('outside the workspace');
    expect(resolveWorkspacePath(root, 'src/index.ts')).toBe(path.join(root, 'src', 'index.ts'));
  });
});

describe('listWorkspaceTree', () => {
  it('walks directories first, alphabetically, and ignores heavy folders', async () => {
    const tree = await listWorkspaceTree(root);
    expect(tree.map((entry) => entry.name)).toEqual(['src', 'README.md']);

    const src = tree[0];
    expect(src.kind).toBe('directory');
    expect(src.children?.map((entry) => entry.name)).toEqual(['nested', 'index.ts']);
    expect(src.children?.[1].sizeBytes).toBeGreaterThan(0);
  });

  it('honours maxDepth and maxEntries', async () => {
    const shallow = await listWorkspaceTree(root, { maxDepth: 1 });
    expect(shallow[0].children).toEqual([]);

    const capped = await listWorkspaceTree(root, { maxEntries: 1 });
    expect(capped).toHaveLength(1);
  });

  it('returns an empty tree for a missing directory', async () => {
    expect(await listWorkspaceTree(path.join(root, 'does-not-exist'))).toEqual([]);
  });
});

describe('readWorkspaceFile', () => {
  it('reads a contained text file', async () => {
    const file = await readWorkspaceFile(root, 'src/index.ts');
    expect(file.content).toBe('export const x = 1;');
    expect(file.path).toBe('src/index.ts');
    expect(file.truncated).toBe(false);
  });

  it('truncates beyond the byte budget', async () => {
    const file = await readWorkspaceFile(root, 'README.md', 3);
    expect(file.content).toBe('# h');
    expect(file.truncated).toBe(true);
    expect(file.sizeBytes).toBe(7);
  });

  it('rejects escapes, directories and empty paths', async () => {
    await expect(readWorkspaceFile(root, '../secret.txt')).rejects.toThrow('outside the workspace');
    await expect(readWorkspaceFile(root, 'src')).rejects.toThrow('Not a file');
    await expect(readWorkspaceFile(root, '   ')).rejects.toThrow('A file path is required.');
    expect(DEFAULT_MAX_FILE_BYTES).toBeGreaterThan(1000);
  });
});
