/**
 * @module main/agent/swarm-criticality
 *
 * Structural criticality detection for a swarm DAG. A task is "critical" when
 * at least one other task depends on its result — directly or transitively —
 * so its failure or degradation blocks downstream work. Terminal tasks (no
 * dependents) are non-critical and can run on the economical profile.
 *
 * Deliberately structural: no role names and no hardcoded task titles, so the
 * same signal works for any DAG (including a future topology router).
 */

/** Minimal shape needed to walk the DAG — `AgentTask` satisfies it. */
export interface CriticalityNode {
  id: string;
  dependsOn?: string[];
  criticalPath?: boolean;
}

/** Direct dependents per task id (edges pointing from a task to its consumers). */
function collectDependents(tasks: CriticalityNode[]): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const task of tasks) dependents.set(task.id, []);
  for (const task of tasks) {
    for (const depId of task.dependsOn ?? []) {
      const list = dependents.get(depId);
      if (list) list.push(task.id);
    }
  }
  return dependents;
}

/**
 * True when `taskId` has at least one transitive dependent. Bounded BFS: swarm
 * DAGs are tiny (tens of nodes at most), and the `seen` set also makes a
 * malformed cyclic graph terminate instead of looping forever.
 */
export function isTaskCritical(tasks: CriticalityNode[], taskId: string): boolean {
  const dependents = collectDependents(tasks);
  const seen = new Set<string>();
  const queue = [...(dependents.get(taskId) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(dependents.get(current) ?? []));
  }
  return seen.size > 0;
}

/**
 * Stamp `criticalPath` on every task in place. Called once when a plan is
 * created so the flag is part of the plan's public shape before execution and
 * the model selector can read it without recomputing the DAG.
 */
export function markTaskCriticality(tasks: CriticalityNode[]): void {
  for (const task of tasks) {
    task.criticalPath = isTaskCritical(tasks, task.id);
  }
}
