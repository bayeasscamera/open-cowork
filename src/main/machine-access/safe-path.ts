/**
 * @module main/machine-access/safe-path
 *
 * Single safe-resolution function used by every file tool:
 * normalize (NFC) -> resolve (realpath first) -> policy check ->
 * re-verify just before execution (TOCTOU).
 */

import * as fs from 'fs';
import * as path from 'path';
import { isPathWithinRoot } from '../tools/path-containment';
import { isSensitivePath } from './sensitive-zones';
import type { AutonomyLevel, FolderGrant } from './types';

export interface SafePathOptions {
  workspaceRoot: string;
  grants?: FolderGrant[];
  autonomy?: AutonomyLevel;
  /** True for writes/deletes (requires read-write grant). */
  needsWrite?: boolean;
  now?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export interface SafePathResult {
  ok: boolean;
  /** Canonical real path (or lexical resolution for not-yet-existing targets). */
  realPath?: string;
  sensitive?: boolean;
  needsGrant?: boolean;
  error?: string;
}

const WINDOWS_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_PATH_CHARS = 4096;
const MAX_SEGMENT_CHARS = 255;

function isUnc(input: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(input) || /^\/\/[^/]+\/[^/]+/.test(input);
}

/** Lexical normalization shared by resolve + re-verify. */
export function normalizeInput(input: string, platform: NodeJS.Platform): string {
  // A NUL byte truncates the string in downstream OS APIs, which is a classic
  // path-confusion vector. It is REFUSED rather than stripped: silently
  // rewriting the input would make `a\0b` collide with `ab`.
  if (input.includes('\u0000')) {
    throw new Error('path contains a null byte');
  }
  let out = input.normalize('NFC');
  if (platform === 'win32') out = out.replace(/\//g, '\\');
  else out = out.replace(/\\/g, '/');
  return out.trim();
}

function grantCovers(
  realPath: string,
  grants: FolderGrant[],
  needsWrite: boolean,
  now: number,
  platform: NodeJS.Platform
): boolean {
  const caseInsensitive = platform !== 'linux';
  for (const grant of grants) {
    if (grant.expiresAt !== undefined && grant.expiresAt <= now) continue;
    if (needsWrite && grant.access !== 'read-write') continue;
    const grantPath = grant.path.normalize('NFC');
    if (isPathWithinRoot(realPath, grantPath, caseInsensitive)) return true;
  }
  return false;
}

/** Real path of an existing path, or undefined when it does not exist. */
function canonicalizeExisting(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

function checkLexicalHazards(
  normalized: string,
  workspaceRoot: string,
  platform: NodeJS.Platform
): string | null {
  if (normalized.length === 0) return 'empty path';
  if (normalized.length > MAX_PATH_CHARS) return 'path too long';
  for (const seg of normalized.split(/[\\/]/)) {
    if (seg.length > MAX_SEGMENT_CHARS) return 'path segment too long';
    const upper = seg.split('.')[0]?.toUpperCase() ?? '';
    if (platform === 'win32' && WINDOWS_DEVICE_NAMES.has(upper)) {
      return `reserved device name: ${seg}`;
    }
  }
  if (isUnc(normalized)) return 'network (UNC) path without explicit grant routing';
  void workspaceRoot;
  return null;
}

/**
 * Resolve `input` against the workspace/grants policy. Symlinks are followed
 * with realpath BEFORE the containment check; missing targets fall back to
 * lexical resolution against their nearest existing ancestor.
 */
export function resolveSafePath(input: string, options: SafePathOptions): SafePathResult {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now();
  const autonomy = options.autonomy ?? 'ask-always';
  let normalized: string;
  try {
    normalized = normalizeInput(input, platform);
  } catch (error) {
    // Refused inputs resolve as a refusal, never as a throw: a tool must not
    // crash the model loop because of a hostile path.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const hazard = checkLexicalHazards(normalized, options.workspaceRoot, platform);
  if (hazard) return { ok: false, error: hazard };

  // The workspace root must be compared in its CANONICAL form. On macOS the
  // temp directory is /var/folders/... which is a symlink to /private/var/...,
  // so a lexical comparison against a realpath-ed target would report a false
  // escape for every file. Same reasoning applies to any symlinked workspace.
  const canonicalRoot = canonicalizeExisting(options.workspaceRoot) ?? options.workspaceRoot;

  const absolute = path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.normalize(path.join(canonicalRoot, normalized));

  // Resolve symlinks before the containment check (spec 3.2).
  let realPath: string = absolute;
  try {
    realPath = fs.realpathSync(absolute);
  } catch {
    // Target does not exist yet: resolve the nearest existing ancestor, then
    // re-attach the remainder lexically so `..` cannot smuggle an escape.
    let ancestor = absolute;
    const remainder: string[] = [];
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      remainder.unshift(path.basename(ancestor));
      ancestor = parent;
    }
    try {
      const realAncestor = fs.realpathSync(ancestor);
      realPath = path.normalize(path.join(realAncestor, ...remainder));
    } catch {
      realPath = absolute;
    }
  }
  realPath = realPath.normalize('NFC');

  const sensitive = isSensitivePath(realPath, { platform, homeDir: options.homeDir });
  const caseInsensitive = platform !== 'linux';
  const inWorkspace = isPathWithinRoot(realPath, canonicalRoot, caseInsensitive);
  const inGrant = grantCovers(realPath, options.grants ?? [], options.needsWrite ?? false, now, platform);

  if (autonomy !== 'allow-all' && !inWorkspace && !inGrant) {
    return { ok: false, realPath, sensitive, needsGrant: true, error: 'outside granted folders' };
  }
  return { ok: true, realPath, sensitive };
}

/**
 * Re-verify just before execution: the link may have changed between the
 * check and the action (TOCTOU). Returns false when the path moved.
 */
export function reverifySafePath(
  previous: string,
  options: SafePathOptions & { input: string }
): boolean {
  const fresh = resolveSafePath(options.input, options);
  if (!fresh.ok || !fresh.realPath) return false;
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') return fresh.realPath === previous;
  return fresh.realPath.toLowerCase() === previous.toLowerCase();
}
