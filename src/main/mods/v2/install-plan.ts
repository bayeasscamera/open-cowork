/**
 * The install review payload.
 *
 * This module builds what the user READS before approving a mod. It is
 * deliberately the only way to get from "here is a plugin folder" to "a mod the
 * loader will load", and it never loads anything itself.
 *
 * The payload is not a nicety. A mod runs in the main process with full access,
 * so the user's decision is only meaningful if they can see, before approving:
 *  - what the manifest declares (and that declarations are NOT enforced),
 *  - the actual code, not just a name and a version,
 *  - a fingerprint that will silently un-approve itself if the bytes change,
 *  - a plain statement of what they are agreeing to.
 *
 * A mod with an unreadable entry file is reported, not installed: code the user
 * cannot read is code the user cannot consent to.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fingerprintPlugin } from './plugin-hash';
import { validateModManifest } from './manifest-schema';
import type { ModManifest } from '@cowork/mod-api';

/** Shown verbatim on the approval screen. Not paraphrasable, not localisable away. */
export const MOD_ACCESS_WARNING =
  'This mod runs inside Cowork with the same access Cowork itself has: your files, your network, your database. ' +
  'The capabilities listed below are what it DECLARES, not a limit — nothing restricts a mod from using more. ' +
  'Only install a mod whose code you have read.';

export interface ModFilePreview {
  /** POSIX-relative path inside the plugin. */
  readonly path: string;
  readonly bytes: number;
  /** Content for review. Absent for binary files, which are reported instead. */
  readonly text?: string;
  readonly binary?: boolean;
}

export interface InstallReview {
  readonly manifest: ModManifest;
  readonly rootDir: string;
  readonly fingerprint: string;
  readonly files: readonly ModFilePreview[];
  readonly totalBytes: number;
  readonly skipped: readonly { readonly path: string; readonly reason: string }[];
  readonly warning: string;
  /** Fields the manifest did not declare — the honest answer is "unknown". */
  readonly undeclaredCapabilities: readonly string[];
}

export type PlanResult =
  | { readonly ok: true; readonly review: InstallReview }
  | { readonly ok: false; readonly error: string; readonly detail?: readonly { readonly path: string; readonly message: string }[] };

const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_PREVIEW_FILES = 200;
const TEXT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.json', '.md', '.txt', '']);

function looksBinary(buffer: Buffer): boolean {
  // A NUL byte in the first 8 KiB is the standard cheap test.
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}

/**
 * Which capability slots the manifest leaves unsaid.
 *
 * A mod that declares nothing still runs with everything, so silence is the most
 * important thing to surface — not the least.
 */
export function undeclaredCapabilities(manifest: ModManifest): string[] {
  const declared = manifest.capabilities ?? {};
  const missing: string[] = [];
  if (!declared.fs) missing.push('fs (no paths declared)');
  if (!declared.network) missing.push('network (no domains declared)');
  if (!declared.storage) missing.push('storage (not declared)');
  if (!declared.model) missing.push('model calls (not declared)');
  if (!declared.ui || declared.ui.length === 0) missing.push('ui slots (none declared)');
  return missing;
}

/**
 * Build the review for a plugin directory. Reads code, executes nothing.
 */
export async function buildInstallReview(rootDir: string): Promise<PlanResult> {
  const manifestPath = path.join(rootDir, 'mod.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch (error) {
    return { ok: false, error: `Cannot read mod.json: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      error: `mod.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const validated = validateModManifest(parsed);
  if (!validated.ok) return { ok: false, error: 'The manifest is invalid.', detail: validated.errors };

  const fingerprint = await fingerprintPlugin(rootDir);
  if (fingerprint.fileCount === 0) {
    return { ok: false, error: 'The plugin directory has no readable file to fingerprint.' };
  }

  const files: ModFilePreview[] = [];
  const manifestDir = path.dirname(manifestPath);
  await collect(rootDir, '', files, 0);

  async function collect(base: string, relative: string, into: ModFilePreview[], depth: number): Promise<void> {
    if (into.length >= MAX_PREVIEW_FILES || depth > 8) return;
    const dir = path.join(base, relative);
    let entries: string[];
    try {
      entries = (await fs.readdir(dir)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (into.length >= MAX_PREVIEW_FILES) return;
      if (name === '.git') continue;
      const childRelative = relative ? path.join(relative, name) : name;
      const absolute = path.join(base, childRelative);
      let stats;
      try {
        stats = await fs.lstat(absolute);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        await collect(base, childRelative, into, depth + 1);
        continue;
      }
      if (!stats.isFile()) continue;

      const extension = path.extname(name).toLowerCase();
      if (stats.size > MAX_PREVIEW_BYTES) {
        into.push({ path: childRelative, bytes: stats.size, binary: true });
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(absolute);
      } catch {
        into.push({ path: childRelative, bytes: stats.size, binary: true });
        continue;
      }
      if (!TEXT_EXTENSIONS.has(extension) || looksBinary(buffer)) {
        into.push({ path: childRelative, bytes: stats.size, binary: true });
        continue;
      }
      into.push({ path: childRelative, bytes: stats.size, text: buffer.toString('utf-8') });
    }
  }

  // The entry file is what actually runs. If it is not in the preview the user
  // cannot read the thing they are approving.
  const entry = files.find((file) => file.path.replace(/\\/g, '/') === validated.manifest.entry.replace(/\\/g, '/'));
  if (!entry || entry.binary || entry.text === undefined) {
    return {
      ok: false,
      error: `The mod entry "${validated.manifest.entry}" could not be read as text. Refusing to ask for approval of code the user cannot see.`,
    };
  }

  void manifestDir;

  return {
    ok: true,
    review: {
      manifest: validated.manifest,
      rootDir,
      fingerprint: fingerprint.hash,
      files,
      totalBytes: fingerprint.totalBytes,
      skipped: fingerprint.skipped,
      warning: MOD_ACCESS_WARNING,
      undeclaredCapabilities: undeclaredCapabilities(validated.manifest),
    },
  };
}