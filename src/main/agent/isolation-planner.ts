/**
 * @module main/agent/isolation-planner
 *
 * Cowork 4.0 — Phase 5.3: risky tasks run in an ephemeral worktree instead of
 * the live workspace, so a bad patch can be discarded by deleting a directory
 * rather than by rolling back real files.
 *
 * All decisions are pure data, computed before anything is created.
 */

import type { AtomicTask, RiskLevel } from '../../shared/task-contract';
import type { IsolationPlan } from '../../shared/workflow-types';

/** Capabilities that make a task unsafe to run in the live workspace. */
const RISKY_CAPABILITIES = new Set(['write', 'shell', 'outside-workspace', 'git']);

export interface IsolationPolicy {
  /** Risk level at (or above) which isolation is mandatory. */
  minRisk: RiskLevel;
  /** Isolate any task holding a mutating capability, regardless of risk. */
  isolateOnRiskyCapability: boolean;
  /** Isolate tasks that touch more than this many files. */
  maxFilesWithoutIsolation: number;
}

export const DEFAULT_ISOLATION_POLICY: IsolationPolicy = Object.freeze({
  minRisk: 'medium',
  isolateOnRiskyCapability: true,
  maxFilesWithoutIsolation: 5,
});

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function shouldIsolateTask(
  task: AtomicTask,
  policy: IsolationPolicy = DEFAULT_ISOLATION_POLICY
): boolean {
  if (RISK_ORDER[task.riskLevel] >= RISK_ORDER[policy.minRisk]) {
    return true;
  }
  if (
    policy.isolateOnRiskyCapability &&
    task.requestedCapabilities.some((capability) => RISKY_CAPABILITIES.has(capability))
  ) {
    return true;
  }
  return task.writeScope.length > policy.maxFilesWithoutIsolation;
}

/**
 * Build the isolation plan for a set of tasks. Tasks that do not need isolation
 * share the live workspace (no placeholders in the result).
 */
export function planIsolation(
  tasks: AtomicTask[],
  workspaceRoot: string,
  policy: IsolationPolicy = DEFAULT_ISOLATION_POLICY
): IsolationPlan[] {
  return tasks
    .filter((task) => shouldIsolateTask(task, policy))
    .map((task) => ({
      taskId: task.id,
      mode: 'worktree' as const,
      workspaceRoot,
      worktreePath: joinWorktreePath(workspaceRoot, task.id),
      files: [...task.writeScope],
      ephemeral: true as const,
    }));
}

/** Deterministic path for a task worktree, kept next to the workspace. */
export function joinWorktreePath(workspaceRoot: string, taskId: string): string {
  const normalized = workspaceRoot.replace(/[\\/]+$/, '');
  const safeId = taskId.replace(/[^a-zA-Z0-9._-]/g, '-');
  return normalized + '/.cowork-worktrees/' + safeId;
}

export interface IsolationArtifacts {
  /** Paths the caller must delete to reclaim disk space. */
  cleanupPaths: string[];
  /** Whether the live workspace was left untouched. */
  workspaceUntouched: boolean;
}

/** Describe how a completed isolated batch should be cleaned up. */
export function describeCleanup(plans: IsolationPlan[]): IsolationArtifacts {
  return {
    cleanupPaths: plans.filter((plan) => plan.ephemeral).map((plan) => plan.worktreePath),
    workspaceUntouched: plans.every((plan) => plan.ephemeral),
  };
}
