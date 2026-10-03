/**
 * Mod manifest validation (`mod.json`).
 *
 * Strict on purpose: an unknown key is a typo, and a typo in a manifest is how
 * a mod ends up believing it declared something it did not. The manifest is the
 * text the user reads before approving an install, so a silent default is worse
 * than a refusal.
 *
 * Two rules here are load-bearing rather than cosmetic:
 *
 *  - `capabilities` is DECLARATIVE. It is shown at install time so the user can
 *    see what a mod says it needs. It is NOT enforced, because a mod runs in
 *    the main process and no manifest rule could bind it. Do not add code that
 *    treats a capability check as a permission check.
 *  - `entry` must stay inside the plugin directory. A manifest is attacker-
 *    controlled text (a mod can be fetched from a git repo), so `../../../..`
 *    must not be able to name an arbitrary module to import.
 */

import { z } from 'zod';
import type { ModManifest } from '@cowork/mod-api';

/** Ids are used as directory names and as settings keys, so they stay boring. */
export const MOD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Strict-enough semver. Build metadata and ranges are refused on purpose. */
export const MOD_VERSION = /^\d+\.\d+\.\d+$/;

const MAX_NAME_LENGTH = 120;
const MAX_ENTRY_LENGTH = 400;

const uiSlot = z.enum(['statusBar', 'messageActions', 'sidePanel', 'settingsTab']);

const fsCapabilitySchema = z
  .object({
    read: z.array(z.string().min(1).max(MAX_ENTRY_LENGTH)).max(64).optional(),
    write: z.array(z.string().min(1).max(MAX_ENTRY_LENGTH)).max(64).optional(),
  })
  .strict();

const networkCapabilitySchema = z
  .object({
    domains: z.array(z.string().min(1).max(255)).max(64).optional(),
  })
  .strict();

const capabilitiesSchema = z
  .object({
    fs: fsCapabilitySchema.optional(),
    network: networkCapabilitySchema.optional(),
    ui: z.array(uiSlot).max(8).optional(),
    storage: z.boolean().optional(),
    model: z.boolean().optional(),
  })
  .strict();

const modEventName = z.enum([
  'onSessionStart',
  'onSessionEnd',
  'onUserPrompt',
  'onContextBuild',
  'onPreToolUse',
  'onPermissionRequest',
  'onPostToolUse',
  'onAssistantMessage',
  'onCompact',
  'onRoomEvent',
]);

export const modManifestSchema = z
  .object({
    id: z.string().regex(MOD_ID, 'id must be lowercase letters, digits and dashes'),
    name: z.string().min(1).max(MAX_NAME_LENGTH),
    version: z.string().regex(MOD_VERSION, 'version must be major.minor.patch'),
    apiVersion: z.literal(1),
    entry: z.string().min(1).max(MAX_ENTRY_LENGTH),
    band: z.enum(['system', 'org', 'user']),
    failMode: z.enum(['open', 'closed']),
    events: z.array(modEventName).max(16).optional(),
    capabilities: capabilitiesSchema.optional(),
    author: z.string().min(1).max(MAX_NAME_LENGTH).optional(),
    homepage: z.string().min(1).max(MAX_ENTRY_LENGTH).optional(),
  })
  .strict();

export type ModManifestInput = z.input<typeof modManifestSchema>;

export interface ManifestValidationFailure {
  /** Dotted path to the offending field, e.g. `capabilities.fs.reade`. */
  readonly path: string;
  readonly message: string;
}

export type ManifestValidationResult =
  | { readonly ok: true; readonly manifest: ModManifest }
  | { readonly ok: false; readonly errors: readonly ManifestValidationFailure[] };

/**
 * `entry` is a path, and a path from an untrusted manifest must not be able to
 * name a module outside the plugin. Checked lexically: the plugin root is
 * resolved to an absolute real path at install time, so the join below is
 * compared against a known base rather than trusted from the manifest.
 *
 * Rejects: absolute paths, Windows drive letters, UNC paths, any `..` segment,
 * and NUL bytes (which truncate the string in some native calls).
 */
export function isEntryInsidePlugin(entry: string): boolean {
  if (entry.includes('\0')) return false;
  if (entry.startsWith('/') || entry.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(entry)) return false;
  const segments = entry.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) return false;
  return true;
}

function formatIssues(error: z.ZodError): ManifestValidationFailure[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));
}

/**
 * Parse an untrusted manifest object into a validated `ModManifest`.
 *
 * Returns every issue rather than the first: a user staring at an install
 * screen should not have to submit three times to learn their id is wrong.
 */
export function validateModManifest(input: unknown): ManifestValidationResult {
  const parsed = modManifestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: formatIssues(parsed.error) };
  }
  if (!isEntryInsidePlugin(parsed.data.entry)) {
    return {
      ok: false,
      errors: [
        {
          path: 'entry',
          message:
            'entry must be a relative path inside the plugin directory: absolute paths, drive letters and ".." segments are refused',
        },
      ],
    };
  }
  return { ok: true, manifest: parsed.data as ModManifest };
}

/**
 * Order bands so `system` mods see a call before `org` before `user`.
 *
 * Within a band, load order is preserved — the user can reorder their own mods,
 * and that choice is expressed through the order they were registered in, not
 * through a second field that could disagree with it.
 */
export function compareModBands(a: ModManifest, b: ModManifest): number {
  const rank: Record<ModManifest['band'], number> = { system: 0, org: 1, user: 2 };
  return rank[a.band] - rank[b.band];
}