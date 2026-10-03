/**
 * Install-time approval for mods, with a PINNED content hash.
 *
 * The invariant: a mod runs only while its current content fingerprint equals
 * the hash the user approved. Change one byte — a new helper module, an edited
 * string, a swapped dependency — and the pin no longer matches, so the mod is
 * refused until the user is shown the new code and approves again.
 *
 * This is the only thing standing between "approve a mod" and "any code can run
 * in the main process with full access". A mod's capabilities field is
 * declarative and unenforced, so the hash is the actual control. Treat it as
 * such: never load a mod through a path that skips this store.
 */

import { createHash } from 'crypto';
import { log, logWarn } from '../../utils/logger';
import type { ModManifest } from '@cowork/mod-api';

export interface ApprovedMod {
  readonly id: string;
  /** The fingerprint the user actually saw and approved. */
  readonly approvedHash: string;
  readonly approvedVersion: string;
  readonly approvedAt: number;
  /** Absolute plugin directory at approval time, for diagnostics. */
  readonly sourcePath: string;
  /** What the manifest declared at approval time — shown again on the next load. */
  readonly declaredCapabilities?: unknown;
}

export interface ApprovalDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  /** True when the mod was never approved, false when it was approved then changed. */
  readonly firstApproval: boolean;
  readonly approved?: ApprovedMod;
}

/** Interface over the persistence layer, so tests do not need electron-store. */
export interface ApprovalStoreLike {
  load(): Record<string, ApprovedMod>;
  save(data: Record<string, ApprovedMod>): void;
}

export interface ApprovalCheck {
  readonly modId: string;
  readonly currentHash: string;
  readonly sourcePath: string;
}

/** Stable id for a proposed approval, so the UI can correlate a prompt later. */
export function approvalId(check: ApprovalCheck): string {
  return createHash('sha256')
    .update(`${check.modId}::${check.currentHash}::${check.sourcePath}`)
    .digest('hex')
    .slice(0, 32);
}

export class ModApprovalStore {
  constructor(private readonly store: ApprovalStoreLike) {}

  list(): ApprovedMod[] {
    return Object.values(this.store.load());
  }

  get(modId: string): ApprovedMod | undefined {
    return this.store.load()[modId];
  }

  /**
   * May this exact content load?
   *
   * Three outcomes, and the distinction matters to the caller: never approved
   * (needs a first approval), approved before but changed (needs a NEW
   * approval — and the UI must show a diff, not a re-confirm), approved and
   * unchanged (silent pass).
   */
  check(check: ApprovalCheck): ApprovalDecision {
    const existing = this.get(check.modId);
    if (!existing) {
      return {
        allowed: false,
        firstApproval: true,
        reason: 'Not installed and approved yet.',
      };
    }
    if (existing.approvedHash !== check.currentHash) {
      logWarn(
        `[Mods] "${check.modId}" content changed since approval (pinned ${existing.approvedHash.slice(0, 12)}, found ${check.currentHash.slice(0, 12)})`
      );
      return {
        allowed: false,
        firstApproval: false,
        reason: 'The code changed after you approved it. Review the new code before it runs again.',
        approved: existing,
      };
    }
    return { allowed: true, firstApproval: false, approved: existing };
  }

  /**
   * Record the user's approval. Overwrites an older pin deliberately: approving
   * new code replaces the old approval rather than keeping both, so there is
   * exactly one hash a later load can match.
   */
  approve(input: {
    modId: string;
    currentHash: string;
    version: string;
    sourcePath: string;
    declaredCapabilities?: unknown;
    now?: number;
  }): ApprovedMod {
    const data = this.store.load();
    const record: ApprovedMod = {
      id: input.modId,
      approvedHash: input.currentHash,
      approvedVersion: input.version,
      approvedAt: input.now ?? Date.now(),
      sourcePath: input.sourcePath,
      ...(input.declaredCapabilities !== undefined ? { declaredCapabilities: input.declaredCapabilities } : {}),
    };
    data[input.modId] = record;
    this.store.save(data);
    log(`[Mods] Approved "${input.modId}" v${input.version} (${input.currentHash.slice(0, 12)})`);
    return record;
  }

  /** Remove an approval. The next load will need a fresh one. */
  revoke(modId: string): boolean {
    const data = this.store.load();
    if (!(modId in data)) return false;
    delete data[modId];
    this.store.save(data);
    log(`[Mods] Approval revoked for "${modId}"`);
    return true;
  }

  /** Snapshot for the Mods settings page: what is approved, at which hash. */
  describe(manifest: ModManifest): {
    approved: boolean;
    firstApproval: boolean;
    pinnedHash?: string;
    approvedVersion?: string;
  } {
    const existing = this.get(manifest.id);
    return {
      approved: Boolean(existing),
      firstApproval: !existing,
      ...(existing ? { pinnedHash: existing.approvedHash, approvedVersion: existing.approvedVersion } : {}),
    };
  }
}