/**
 * Shared contract for the mods v2 IPC surface (main <-> preload <-> renderer).
 *
 * Same shape as machine-access-contract.ts: the renderer must never trust a mod
 * payload, and the main process must never trust the renderer. Every field a mod
 * can influence is typed here so both sides agree on what "reviewable" means.
 */

import type { ModUiContribution } from '@cowork/mod-api';

export interface ModFilePreviewDto {
  path: string;
  bytes: number;
  /** Present for reviewable text. Absent for binary files. */
  text?: string;
  binary?: boolean;
}

export interface ModManifestDto {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  entry: string;
  band: 'system' | 'org' | 'user';
  failMode: 'open' | 'closed';
  events?: readonly string[];
  author?: string;
  homepage?: string;
}

export interface ModReviewDto {
  manifest: ModManifestDto;
  rootDir: string;
  fingerprint: string;
  files: readonly ModFilePreviewDto[];
  totalBytes: number;
  warning: string;
  undeclaredCapabilities: readonly string[];
}

export interface ModHealthDto {
  disabled: boolean;
  failures: number;
  lastError?: string;
}

export interface InstalledModDto {
  id: string;
  version: string;
  band: 'system' | 'org' | 'user';
  source: string;
  installedAt: number;
  fingerprint: string;
  /** Declared capabilities, shown again at every load. Never enforced. */
  declaredCapabilities?: unknown;
  enabled: boolean;
  health?: ModHealthDto;
}

export interface SafeModeDto {
  active: boolean;
  reason: 'flag' | 'setting' | 'auto' | 'none';
  crashedMods: readonly string[];
  consecutiveBootFailures: number;
}

export type ModsV2Reply<T> = { success: true; data: T } | { success: false; error: string };

/**
 * A UI contribution as shipped to the renderer. The mod id is attached by main
 * at contribution time — a mod cannot impersonate another mod's slot, and the
 * renderer always knows whose data it is drawing. The contribution itself was
 * validated by main (`validateContribution`) before it ever reached the wire.
 */
export interface ContributedUiDto {
  modId: string;
  contribution: ModUiContribution;
}

/**
 * Validate a form-value report coming from the renderer.
 *
 * `value` is deliberately `unknown`: it is user-typed data addressed to a mod,
 * never executed, and the host stores it as-is. Only the addressing fields are
 * checked — a report aimed at another mod's node is the attack shape here.
 */
export function isUiValueReport(
  input: unknown
): input is { modId: string; nodeId: string; value: unknown } {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.modId === 'string' &&
    candidate.modId.length > 0 &&
    typeof candidate.nodeId === 'string' &&
    candidate.nodeId.length > 0
  );
}

/**
 * Validate an install request coming from the renderer.
 *
 * The renderer is not trusted to have computed the fingerprint: it echoes back
 * what main showed it, and main recomputes it before committing. A mismatch means
 * the bytes moved under the user's eyes, which is the one thing an install
 * approval must never survive.
 */
export function isInstallRequest(input: unknown): input is { rootDir: string; approvedHash: string } {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.rootDir === 'string' &&
    candidate.rootDir.length > 0 &&
    typeof candidate.approvedHash === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.approvedHash)
  );
}