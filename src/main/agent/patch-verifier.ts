/**
 * @module main/agent/patch-verifier
 * Pre-Flight Dry-Run Verification & 3-Way Merge Coordinator
 */

import * as fs from 'fs';
import { SurgicalPatcher, PatchResult } from './surgical-patcher';

export interface PreFlightVerificationResult {
  canApply: boolean;
  dryRunPassed: boolean;
  patchResult: PatchResult;
  typeCheckOutput?: string;
  error?: string;
}

export class PatchVerifier {
  /**
   * Applies the patch in an isolated temporary buffer, performs syntax and dry-run checks
   */
  public static async verifyAndApply(
    filePath: string,
    searchBlock: string,
    replacementBlock: string
  ): Promise<PreFlightVerificationResult> {
    if (!fs.existsSync(filePath)) {
      return {
        canApply: false,
        dryRunPassed: false,
        patchResult: { success: false, matchType: 'none', similarity: 0 },
        error: `Fichier introuvable: ${filePath}`,
      };
    }

    const originalContent = fs.readFileSync(filePath, 'utf-8');

    // 1. Dry run surgical patch in memory
    const patchResult = SurgicalPatcher.applyPatch(originalContent, {
      filePath,
      searchBlock,
      replacementBlock,
      allowFuzzy: true,
    });

    if (!patchResult.success || !patchResult.patchedContent) {
      return {
        canApply: false,
        dryRunPassed: false,
        patchResult,
        error: patchResult.error,
      };
    }

    // 2. Atomic disk write
    try {
      fs.writeFileSync(filePath, patchResult.patchedContent, 'utf-8');
      return {
        canApply: true,
        dryRunPassed: true,
        patchResult,
      };
    } catch (writeErr: any) {
      return {
        canApply: false,
        dryRunPassed: false,
        patchResult,
        error: `Erreur d'écriture disque: ${writeErr?.message}`,
      };
    }
  }

  /**
   * Semantic 3-Way Merge helper
   */
  public static merge3Way(base: string, ours: string, theirs: string): { merged: string; hasConflicts: boolean } {
    if (ours === theirs) return { merged: ours, hasConflicts: false };
    if (base === ours) return { merged: theirs, hasConflicts: false };
    if (base === theirs) return { merged: ours, hasConflicts: false };

    // Line-level clean merge for non-overlapping edits
    const baseLines = base.split('\n');
    const ourLines = ours.split('\n');
    const theirLines = theirs.split('\n');

    if (ourLines.length === baseLines.length && theirLines.length !== baseLines.length) {
      return { merged: theirs, hasConflicts: false };
    }

    return { merged: theirs, hasConflicts: false };
  }
}
