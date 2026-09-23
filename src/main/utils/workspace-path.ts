/**
 * @module main/utils/workspace-path
 *
 * Resolve a renderer-supplied path to a real file inside a workspace root.
 * Shared by the editor bridge and the targeted test re-run so both apply the
 * same containment rule: no absolute escape, no traversal segment, no symlink
 * escape and no control characters.
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

function realPathOf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** Control characters would corrupt a URI or an argv entry. */
export function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Resolve a requested path to a real file inside the workspace root. Returns
 * null when the path escapes the root (lexically or through a symlink), does
 * not exist, is not a regular file, or carries control characters.
 */
export function resolveWorkspaceFile(root: string, requested: unknown): string | null {
  if (typeof requested !== 'string') return null;
  const trimmed = requested.trim();
  if (!trimmed) return null;
  if (hasControlCharacters(trimmed)) return null;
  const normalizedRoot = resolve(root);
  const target = isAbsolute(trimmed) ? resolve(trimmed) : resolve(normalizedRoot, trimmed);
  const realRoot = realPathOf(normalizedRoot);
  const realTarget = realPathOf(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null;
  try {
    if (!statSync(realTarget).isFile()) return null;
  } catch {
    return null;
  }
  return target;
}
