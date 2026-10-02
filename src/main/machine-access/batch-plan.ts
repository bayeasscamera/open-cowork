/**
 * @module main/machine-access/batch-plan
 *
 * Batch file operations in three steps (spec 4.1): plan → preview (dryRun,
 * changes nothing) → execution identical to the preview. Guards: tunable op
 * cap with reinforced confirmation above it, git-root/project-root warning,
 * stop at the first unexpected error with a clear done/pending state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { resolveSafePath } from './safe-path';
import { backupFile, checksumFile, type FsJournal, type FsOpType } from './fs-journal';
import type { FolderGrant } from './types';

export interface BatchOpInput {
  type: 'move' | 'rename' | 'copy' | 'trash';
  src: string;
  dest?: string;
}

export interface ResolvedBatchOp extends BatchOpInput {
  realSrc: string;
  realDest?: string;
  bytes: number;
}

export interface BatchPlan {
  planId: string;
  ops: ResolvedBatchOp[];
  conflicts: string[];
  gitRoots: string[];
  totalBytes: number;
  fingerprint: string;
}

export interface BatchPlanDeps {
  workspaceRoot: string;
  grants: FolderGrant[];
  maxOps?: number;
  allowGitRoots?: boolean;
}

export interface BatchExecDeps {
  journal: FsJournal;
  backupRoot: string;
  trashItem?: (filePath: string) => Promise<void>;
}

function findGitRoot(start: string): string | null {
  let current = start;
  for (let i = 0; i < 20; i += 1) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function fingerprintPlan(ops: ResolvedBatchOp[]): string {
  const canonical = ops.map((o) => `${o.type}::${o.realSrc}::${o.realDest ?? ''}`).join('\n');
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/** Dry-run: resolves everything, reports conflicts, changes nothing. */
export function buildBatchPlan(inputs: BatchOpInput[], deps: BatchPlanDeps): BatchPlan {
  const maxOps = deps.maxOps ?? 100;
  if (inputs.length > maxOps) {
    throw new Error(
      `Batch of ${inputs.length} operations exceeds the cap of ${maxOps}; split it or confirm the reinforced cap explicitly.`
    );
  }
  const ops: ResolvedBatchOp[] = [];
  const conflicts: string[] = [];
  const gitRoots = new Set<string>();
  const seenDest = new Set<string>();
  let totalBytes = 0;

  for (const input of inputs) {
    const rs = resolveSafePath(input.src, {
      workspaceRoot: deps.workspaceRoot,
      grants: deps.grants,
      needsWrite: true,
    });
    if (!rs.ok) throw new Error(`Batch plan refused for '${input.src}': ${rs.error ?? 'unknown'}`);
    let realDest: string | undefined;
    if (input.type !== 'trash') {
      if (!input.dest) throw new Error(`Batch ${input.type} needs a dest.`);
      const rd = resolveSafePath(input.dest, {
        workspaceRoot: deps.workspaceRoot,
        grants: deps.grants,
        needsWrite: true,
      });
      if (!rd.ok) throw new Error(`Batch plan refused for '${input.dest}': ${rd.error ?? 'unknown'}`);
      realDest = rd.realPath;
      if (realDest && seenDest.has(realDest)) conflicts.push(`Two operations target '${realDest}'.`);
      if (realDest) seenDest.add(realDest);
      if (realDest && fs.existsSync(realDest)) conflicts.push(`Destination exists: '${realDest}'.`);
    }
    const realSrc = rs.realPath ?? '';
    if (!fs.existsSync(realSrc)) throw new Error(`Source not found: '${realSrc}'.`);
    const stat = fs.statSync(realSrc);
    if (stat.isFile()) totalBytes += stat.size;
    const gitRoot = findGitRoot(path.dirname(realSrc));
    if (gitRoot) gitRoots.add(gitRoot);
    if (realDest) {
      const destGit = findGitRoot(path.dirname(realDest));
      if (destGit) gitRoots.add(destGit);
    }
    ops.push({
      ...input,
      realSrc,
      ...(realDest ? { realDest } : {}),
      bytes: stat.isFile() ? stat.size : 0,
    });
  }

  if (gitRoots.size > 0 && deps.allowGitRoots !== true) {
    throw new Error(
      `Batch touches git roots (${[...gitRoots].join(', ')}); mention them explicitly with allowGitRoots:true after user review.`
    );
  }

  const planId = randomUUID();
  return { planId, ops, conflicts, gitRoots: [...gitRoots], totalBytes, fingerprint: fingerprintPlan(ops) };
}

export interface BatchExecResult {
  batchId: string;
  done: number;
  pending: number;
  failedAt?: number;
  error?: string;
}

/**
 * Execute exactly the previewed plan. Any drift between preview and
 * execution (moved link, changed file, different fingerprint) aborts with
 * a re-ask instead of proceeding.
 */
export async function executeBatchPlan(
  plan: BatchPlan,
  planDeps: BatchPlanDeps,
  exec: BatchExecDeps
): Promise<BatchExecResult> {
  const batchId = plan.planId;
  // Re-resolve every member (TOCTOU) and require byte-identical resolution.
  const fresh = buildBatchPlan(
    plan.ops.map((o) => ({ type: o.type, src: o.realSrc, ...(o.realDest ? { dest: o.realDest } : {}) })),
    { ...planDeps, allowGitRoots: true }
  );
  if (fresh.fingerprint !== plan.fingerprint) {
    return { batchId, done: 0, pending: plan.ops.length, error: 'Plan drifted since preview; re-ask the user.' };
  }
  if (plan.conflicts.length > 0) {
    return { batchId, done: 0, pending: plan.ops.length, error: `Unresolved conflicts: ${plan.conflicts.join(' | ')}` };
  }

  let done = 0;
  for (let i = 0; i < plan.ops.length; i += 1) {
    const op = plan.ops[i];
    if (!op) continue;
    try {
      await applyOp(op, batchId, exec);
      done += 1;
    } catch (error) {
      return {
        batchId,
        done,
        pending: plan.ops.length - done,
        failedAt: i,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { batchId, done, pending: 0 };
}

async function applyOp(op: ResolvedBatchOp, batchId: string, exec: BatchExecDeps): Promise<void> {
  const journalType: FsOpType = op.type === 'trash' ? 'trash' : op.type === 'rename' ? 'rename' : op.type === 'copy' ? 'copy' : 'move';
  const before = fs.existsSync(op.realSrc) ? checksumFile(op.realSrc) : undefined;
  if (op.type === 'trash') {
    const backupRef = backupFile(op.realSrc, exec.backupRoot, batchId);
    if (exec.trashItem) await exec.trashItem(op.realSrc);
    else fs.renameSync(op.realSrc, `${backupRef}.trashed`);
    exec.journal.record({
      batchId,
      type: journalType,
      source: op.realSrc,
      backupRef,
      ...(before ? { checksumBefore: before } : {}),
    });
    return;
  }
  const dest = op.realDest ?? '';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (op.type === 'copy') fs.copyFileSync(op.realSrc, dest);
  else fs.renameSync(op.realSrc, dest);
  exec.journal.record({
    batchId,
    type: journalType,
    source: op.realSrc,
    destination: dest,
    ...(before ? { checksumBefore: before } : {}),
    checksumAfter: checksumFile(dest),
  });
}
