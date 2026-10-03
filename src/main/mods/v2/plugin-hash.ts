/**
 * Content fingerprint of a plugin directory.
 *
 * Why the whole directory and not just the entry file: a mod's entry can import
 * a sibling module, and that sibling is exactly where a payload would hide. A
 * hash that only covers `dist/index.js` would let anything change under the
 * entry while the pinned hash still matches — the pin would be theatre.
 *
 * Deterministic by construction: entries are sorted by their POSIX-relative path
 * before hashing, so filesystem enumeration order (which differs between APFS,
 * ext4 and Windows) cannot change the result on the same content.
 *
 * `.git` is excluded because it is plugin metadata, not plugin code. Everything
 * else is included, `node_modules` included — a vendored dependency is code the
 * mod can run.
 */

import { createHash } from 'crypto';
import { promises as fs, type Dirent } from 'fs';
import path from 'path';

const EXCLUDED_DIRECTORIES = new Set(['.git']);
/** Symlinks are refused rather than followed: a link out of the plugin would let
 *  a hash cover bytes the plugin does not actually control. */
const MAX_FILES = 5000;

export interface PluginFingerprint {
  /** sha256 over the canonical listing. Empty string when the root is unreadable. */
  readonly hash: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Files refused for a reason the user must be told about. */
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
}

async function walk(root: string, relative: string, out: string[], skipped: { path: string; reason: string }[]): Promise<void> {
  if (out.length > MAX_FILES) return;
  const dir = path.join(root, relative);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    skipped.push({ path: relative || '.', reason: error instanceof Error ? error.message : String(error) });
    return;
  }
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      skipped.push({ path: childRelative, reason: 'symbolic links are not fingerprinted' });
      continue;
    }
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      await walk(root, childRelative, out, skipped);
      continue;
    }
    if (entry.isFile()) out.push(childRelative);
  }
}

/**
 * Fingerprint a plugin directory.
 *
 * Reads every byte. That is the point: the user is approving code that will run
 * with full access, and the hash they pin is the only thing that will tell them
 * it changed afterwards.
 */
export async function fingerprintPlugin(root: string): Promise<PluginFingerprint> {
  const files: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  await walk(root, '', files, skipped);

  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const hash = createHash('sha256');
  let totalBytes = 0;
  for (const relative of files) {
    let data: Buffer;
    try {
      data = await fs.readFile(path.join(root, relative));
    } catch (error) {
      skipped.push({ path: relative, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    totalBytes += data.byteLength;
    // Path AND content, length-prefixed, so neither a rename nor a byte move can
    // collide into the same digest.
    const name = Buffer.from(relative.split(path.sep).join('/'), 'utf-8');
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(data.byteLength));
    hash.update(name);
    hash.update(size);
    hash.update(data);
  }

  // A digest over ZERO files is the hash of the empty byte string — the SAME
  // value for every unreadable plugin on the machine. Returning it would let an
  // unreadable plugin pin a fingerprint that another unreadable plugin also
  // matches, which is precisely the case where the pin must not be trusted. No
  // readable file means no fingerprint, and the loader refuses on `fileCount`.
  const digest = files.length === 0 ? '' : hash.digest('hex');
  return { hash: digest, fileCount: files.length, totalBytes, skipped };
}

/** Fingerprint a single file's contents — used for the reviewable code blob. */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}