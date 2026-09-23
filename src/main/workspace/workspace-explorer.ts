/**
 * @module main/workspace/workspace-explorer
 *
 * Cowork 4.0 — Phase 6: bounded workspace browsing for the control center. Every
 * path is resolved and containment-checked before it is touched, so the
 * renderer can never escape the active workspace.
 */

import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import type {
  WorkspaceEntry,
  WorkspaceFileContent,
  WorkspaceTreeOptions,
} from '../../shared/control-center-types';
import { isPathWithinRoot } from '../tools/path-containment';

export const WORKSPACE_IGNORED_DIRS: readonly string[] = [
  '.git',
  '.cowork-worktrees',
  '.cowork-user-data',
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'target',
];

export const WORKSPACE_IGNORED_FILES: readonly string[] = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MAX_ENTRIES = 400;
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

export function isIgnoredWorkspaceName(name: string): boolean {
  return WORKSPACE_IGNORED_DIRS.includes(name) || WORKSPACE_IGNORED_FILES.includes(name);
}

export function normalizeWorkspaceRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Resolve a workspace-relative path, refusing anything that escapes the root. */
export function resolveWorkspacePath(root: string, relativePath: string): string {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, relativePath);
  if (!isPathWithinRoot(target, rootResolved)) {
    throw new Error('Path is outside the workspace: ' + relativePath);
  }
  return target;
}

/** Directory tree, directories first then alphabetical, bounded in depth and size. */
export async function listWorkspaceTree(
  root: string,
  options: WorkspaceTreeOptions = {}
): Promise<WorkspaceEntry[]> {
  const maxDepth = Math.max(1, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const budget = { remaining: maxEntries };

  const walk = async (absoluteDir: string, depth: number, relative: string): Promise<WorkspaceEntry[]> => {
    if (depth > maxDepth || budget.remaining <= 0) {
      return [];
    }
    let dirents: Dirent[] = [];
    try {
      dirents = await fs.readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const visible = dirents
      .filter((dirent) => !dirent.isSymbolicLink() && !isIgnoredWorkspaceName(dirent.name))
      .sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) {
          return aDir - bDir;
        }
        return a.name.localeCompare(b.name);
      });

    const entries: WorkspaceEntry[] = [];
    for (const dirent of visible) {
      if (budget.remaining <= 0) {
        break;
      }
      budget.remaining -= 1;
      const childRelative = relative ? relative + '/' + dirent.name : dirent.name;
      const childAbsolute = path.join(absoluteDir, dirent.name);

      if (dirent.isDirectory()) {
        const children = await walk(childAbsolute, depth + 1, childRelative);
        entries.push({ name: dirent.name, path: childRelative, kind: 'directory', children });
        continue;
      }

      if (!dirent.isFile()) {
        continue;
      }

      const entry: WorkspaceEntry = { name: dirent.name, path: childRelative, kind: 'file' };
      try {
        const stat = await fs.stat(childAbsolute);
        entry.sizeBytes = stat.size;
        entry.modifiedAt = stat.mtimeMs;
      } catch {
        // A file can disappear mid-walk; the entry stays valid without stats.
      }
      entries.push(entry);
    }
    return entries;
  };

  return walk(path.resolve(root), 1, '');
}

/** Read a bounded, workspace-contained text file. */
export async function readWorkspaceFile(
  root: string,
  relativePath: string,
  maxBytes: number = DEFAULT_MAX_FILE_BYTES
): Promise<WorkspaceFileContent> {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  if (normalized.trim().length === 0) {
    throw new Error('A file path is required.');
  }
  const target = resolveWorkspacePath(root, normalized);
  const stat = await fs.stat(target);
  if (!stat.isFile()) {
    throw new Error('Not a file: ' + normalized);
  }

  // Resolve symlinks before the final containment check.
  const realRoot = await fs.realpath(path.resolve(root));
  const realTarget = await fs.realpath(target);
  if (!isPathWithinRoot(realTarget, realRoot)) {
    throw new Error('Access denied: path is outside the workspace: ' + normalized);
  }

  const limit = Math.max(1, maxBytes);
  const handle = await fs.open(target, 'r');
  try {
    const length = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return {
      path: normalized,
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      sizeBytes: stat.size,
      truncated: stat.size > limit,
    };
  } finally {
    await handle.close();
  }
}
