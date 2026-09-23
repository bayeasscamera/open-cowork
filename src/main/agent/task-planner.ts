/**
 * @module main/agent/task-planner
 *
 * Cowork 4.0 — Phase 1: turns a plan into atomic tasks with explicit
 * dependencies, exit criteria and mandatory evidence, then validates the DAG
 * and derives the execution groups that may run in parallel (Phase 3.3).
 *
 * Everything here is pure: no filesystem, no git, no model calls. The approval
 * gate and the orchestrator consume these results.
 */

import type {
  AtomicTask,
  Capability,
  PlanSummary,
  RiskLevel,
  TaskContract,
} from '../../shared/task-contract';
import { maxRisk } from '../../shared/task-contract';
import {
  findWriteScopeConflicts,
  serializeConflictingGroups,
  type WriteScopeConflict,
} from '../../shared/write-scope-conflicts';
import { matchGlob } from './permission-policy';

export type TaskGraphIssueCode =
  | 'duplicate-id'
  | 'empty-title'
  | 'unknown-dependency'
  | 'self-dependency'
  | 'cycle'
  | 'missing-exit-criteria'
  | 'missing-evidence'
  | 'scope-outside-contract'
  | 'missing-budget';

export interface TaskGraphIssue {
  code: TaskGraphIssueCode;
  severity: 'error' | 'warning';
  taskId: string | null;
  message: string;
}

/** Validate a DAG of atomic tasks, optionally against the authorising contract. */
export function validateTaskGraph(
  tasks: AtomicTask[],
  contract?: TaskContract
): TaskGraphIssue[] {
  const issues: TaskGraphIssue[] = [];
  const seen = new Set<string>();

  for (const task of tasks) {
    if (seen.has(task.id)) {
      issues.push({
        code: 'duplicate-id',
        severity: 'error',
        taskId: task.id,
        message: 'Duplicate task id "' + task.id + '".',
      });
    }
    seen.add(task.id);

    if (!task.title || task.title.trim().length === 0) {
      issues.push({
        code: 'empty-title',
        severity: 'error',
        taskId: task.id,
        message: 'Task "' + task.id + '" has no title.',
      });
    }

    if (task.exitCriteria.length === 0) {
      issues.push({
        code: 'missing-exit-criteria',
        severity: 'error',
        taskId: task.id,
        message: 'Task "' + task.id + '" declares no exit criteria.',
      });
    }

    if (task.requiredEvidence.length === 0) {
      issues.push({
        code: 'missing-evidence',
        severity: 'warning',
        taskId: task.id,
        message: 'Task "' + task.id + '" declares no required evidence.',
      });
    }

    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        issues.push({
          code: 'self-dependency',
          severity: 'error',
          taskId: task.id,
          message: 'Task "' + task.id + '" depends on itself.',
        });
      } else if (!tasks.some((candidate) => candidate.id === dependency)) {
        issues.push({
          code: 'unknown-dependency',
          severity: 'error',
          taskId: task.id,
          message: 'Task "' + task.id + '" depends on unknown task "' + dependency + '".',
        });
      }
    }

    if (contract && contract.allowedFiles.length > 0 && !contract.allowedFiles.includes('**')) {
      for (const scope of task.writeScope) {
        const allowed = contract.allowedFiles.some((pattern) => matchGlob(pattern, scope));
        if (!allowed) {
          issues.push({
            code: 'scope-outside-contract',
            severity: 'error',
            taskId: task.id,
            message:
              'Task "' + task.id + '" writes "' + scope + '" outside the contract scope.',
          });
        }
      }
    }
  }

  const { unresolved } = topologicalSort(tasks);
  if (unresolved.length > 0) {
    issues.push({
      code: 'cycle',
      severity: 'error',
      taskId: null,
      message: 'Dependency cycle involving: ' + unresolved.join(', ') + '.',
    });
  }

  return issues;
}

export interface TopologicalSortResult {
  order: AtomicTask[];
  /** Tasks that could not be ordered, i.e. part of a cycle or dangling deps. */
  unresolved: string[];
}

/** Kahn topological sort. Deterministic: ties keep the original input order. */
export function topologicalSort(tasks: AtomicTask[]): TopologicalSortResult {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    indegree.set(task.id, 0);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        continue;
      }
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      dependents.get(dependency)?.push(task.id);
    }
  }

  const ready = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((t) => t.id);
  const order: AtomicTask[] = [];
  const visited = new Set<string>();

  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) {
      break;
    }
    visited.add(id);
    const task = byId.get(id);
    if (task) {
      order.push(task);
    }
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
      }
    }
  }

  const unresolved = tasks.filter((task) => !visited.has(task.id)).map((task) => task.id);
  return { order, unresolved };
}

/**
 * Groups of tasks that share no dependency and may therefore run concurrently.
 * Group N may start only once every group before it completed.
 */
export function computeExecutionGroups(tasks: AtomicTask[]): AtomicTask[][] {
  const remaining = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set<string>();
  const groups: AtomicTask[][] = [];

  while (remaining.size > 0) {
    const ready = tasks.filter(
      (task) =>
        remaining.has(task.id) &&
        task.dependsOn.every((dependency) => completed.has(dependency) || !remaining.has(dependency))
    );
    if (ready.length === 0) {
      // Cycle or dangling dependency: surface the rest as one final group so the
      // gate can report it instead of looping forever.
      groups.push(Array.from(remaining.values()));
      break;
    }
    groups.push(ready);
    for (const task of ready) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
  }

  return groups;
}

export interface ConflictFreeGrouping {
  /** Dependency groups with conflicting writers pushed into a later group. */
  groups: AtomicTask[][];
  /** Every unordered pair of tasks whose write scopes overlap. */
  conflicts: WriteScopeConflict[];
  /** Ordering edges added to remove a conflict: `before` runs first. */
  serialized: Array<{ before: string; after: string }>;
}

/**
 * Phase 3.3 + Lot D: the groups a plan may *actually* run in parallel.
 *
 * `computeExecutionGroups` only knows about dependencies, so two implementers
 * that both declare `src/a.ts` end up in the same group and race. This splits
 * each dependency group until no group holds two conflicting writers, and
 * reports the conflicts so the UI can explain the extra sequencing instead of
 * silently showing a parallelism that would lose a write.
 */
export function planConflictFreeGroups(tasks: AtomicTask[]): ConflictFreeGrouping {
  const conflicts = findWriteScopeConflicts(tasks);
  const dependencyGroups = computeExecutionGroups(tasks).map((group) =>
    group.map((task) => task.id)
  );
  const { groups, serialized } = serializeConflictingGroups(dependencyGroups, conflicts);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return {
    groups: groups.map((group) =>
      group
        .map((id) => byId.get(id))
        .filter((task): task is AtomicTask => task !== undefined)
    ),
    conflicts,
    serialized,
  };
}

export interface PlanGateResult {
  executable: boolean;
  issues: TaskGraphIssue[];
  /** User-facing reasons execution is blocked. */
  blockers: string[];
}

/**
 * Phase 1.4: refuse to execute unless the contract and every task are explicit.
 * This is the single choke point the orchestrator calls before any write.
 */
export function assertExecutablePlan(
  contract: TaskContract,
  tasks: AtomicTask[]
): PlanGateResult {
  const issues = validateTaskGraph(tasks, contract);
  const blockers = issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => (issue.taskId ? issue.taskId + ': ' + issue.message : issue.message));

  if (tasks.length === 0) {
    blockers.push('Plan contains no task.');
  }

  return { executable: blockers.length === 0, issues, blockers };
}

/** Aggregate a plan for the approval page: scope, cost, risk, roles. */
export function summarizePlan(tasks: AtomicTask[]): PlanSummary {
  const filesTouched = new Set<string>();
  const roles = new Set<AtomicTask['role']>();
  let highestRisk: RiskLevel = 'low';
  let maxTokens = 0;
  let maxDurationMs = 0;
  let maxToolCalls = 0;
  let estimatedCostUsd = 0;
  let hasTokens = false;
  let hasDuration = false;
  let hasToolCalls = false;
  let hasCost = false;

  for (const task of tasks) {
    roles.add(task.role);
    highestRisk = maxRisk(highestRisk, task.riskLevel);
    for (const file of task.writeScope) {
      filesTouched.add(file);
    }
    if (task.budget.maxTokens !== undefined) {
      hasTokens = true;
      maxTokens += task.budget.maxTokens;
    }
    if (task.budget.maxDurationMs !== undefined) {
      hasDuration = true;
      maxDurationMs += task.budget.maxDurationMs;
    }
    if (task.budget.maxToolCalls !== undefined) {
      hasToolCalls = true;
      maxToolCalls += task.budget.maxToolCalls;
    }
    if (task.budget.estimatedCostUsd !== undefined) {
      hasCost = true;
      estimatedCostUsd += task.budget.estimatedCostUsd;
    }
  }

  const grouping = planConflictFreeGroups(tasks);

  return {
    taskCount: tasks.length,
    // Conflict-free: a group is only counted as parallel when its writers do
    // not overlap, which is what the run will actually do.
    groupCount: grouping.groups.length,
    filesTouched: Array.from(filesTouched).sort(),
    totalBudget: {
      maxTokens: hasTokens ? maxTokens : undefined,
      maxDurationMs: hasDuration ? maxDurationMs : undefined,
      maxToolCalls: hasToolCalls ? maxToolCalls : undefined,
      estimatedCostUsd: hasCost ? Number(estimatedCostUsd.toFixed(4)) : undefined,
    },
    highestRisk,
    roles: Array.from(roles),
    writeConflicts: grouping.conflicts,
  };
}

/** Union of capabilities every task asks for, used by the approval gate. */
export function collectRequestedCapabilities(tasks: AtomicTask[]): Capability[] {
  const capabilities = new Set<Capability>();
  for (const task of tasks) {
    for (const capability of task.requestedCapabilities) {
      capabilities.add(capability);
    }
  }
  return Array.from(capabilities);
}

/** Commands the plan intends to run, for the approval page. */
export function collectPlannedCommands(tasks: AtomicTask[]): string[] {
  const commands = new Set<string>();
  for (const task of tasks) {
    for (const criterion of task.exitCriteria) {
      if (criterion.verification) {
        commands.add(criterion.verification);
      }
    }
    for (const evidence of task.requiredEvidence) {
      if (evidence.command) {
        commands.add(evidence.command);
      }
    }
  }
  return Array.from(commands).sort();
}
