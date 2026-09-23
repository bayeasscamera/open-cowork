import { describe, it, expect } from 'vitest';
import {
  assertExecutablePlan,
  collectPlannedCommands,
  collectRequestedCapabilities,
  computeExecutionGroups,
  summarizePlan,
  topologicalSort,
  validateTaskGraph,
} from '../src/main/agent/task-planner';
import { createAtomicTask, createTaskContract } from '../src/shared/task-contract';

const criterion = (id: string, verification = 'npm test') => ({
  id,
  description: 'criterion ' + id,
  verification,
  required: true,
});

const evidence = (command = 'npm test') => ({
  kind: 'test' as const,
  description: 'tests',
  command,
  required: true,
});

function contract(allowedFiles: string[] = ['src/**']) {
  return createTaskContract({
    objective: 'Objective',
    allowedFiles,
    acceptanceCriteria: [criterion('c1')],
    expectedEvidence: [evidence()],
    budget: { maxTokens: 100 },
  });
}

describe('task-planner', () => {
  it('topologically sorts a dependency chain', () => {
    const tasks = [
      createAtomicTask({ id: 'c', title: 'C', dependsOn: ['b'] }),
      createAtomicTask({ id: 'a', title: 'A' }),
      createAtomicTask({ id: 'b', title: 'B', dependsOn: ['a'] }),
    ];

    const { order, unresolved } = topologicalSort(tasks);
    expect(order.map((task) => task.id)).toEqual(['a', 'b', 'c']);
    expect(unresolved).toEqual([]);
  });

  it('reports a dependency cycle', () => {
    const tasks = [
      createAtomicTask({ id: 'a', title: 'A', dependsOn: ['b'] }),
      createAtomicTask({ id: 'b', title: 'B', dependsOn: ['a'] }),
    ];

    const { unresolved } = topologicalSort(tasks);
    expect(unresolved.sort()).toEqual(['a', 'b']);
  });

  it('computes parallel execution groups', () => {
    const tasks = [
      createAtomicTask({ id: 'a', title: 'A' }),
      createAtomicTask({ id: 'b', title: 'B' }),
      createAtomicTask({ id: 'c', title: 'C', dependsOn: ['a', 'b'] }),
    ];

    const groups = computeExecutionGroups(tasks);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((task) => task.id).sort()).toEqual(['a', 'b']);
    expect(groups[1].map((task) => task.id)).toEqual(['c']);
  });

  it('surfaces structural issues', () => {
    const tasks = [
      createAtomicTask({ id: 'a', title: 'A', dependsOn: ['ghost'] }),
      createAtomicTask({ id: 'a', title: 'A2', dependsOn: ['a'] }),
      createAtomicTask({ id: 'b', title: '' }),
    ];

    const issues = validateTaskGraph(tasks);
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('duplicate-id');
    expect(codes).toContain('unknown-dependency');
    expect(codes).toContain('self-dependency');
    expect(codes).toContain('empty-title');
    expect(codes).toContain('missing-exit-criteria');
  });

  it('flags task scope outside the contract', () => {
    const tasks = [
      createAtomicTask({
        id: 'a',
        title: 'A',
        writeScope: ['src/main/other.ts'],
        exitCriteria: [criterion('c1')],
        requiredEvidence: [evidence()],
      }),
    ];

    const issues = validateTaskGraph(tasks, contract(['src/renderer/**']));
    expect(issues.some((issue) => issue.code === 'scope-outside-contract')).toBe(true);
  });

  it('blocks an empty plan and a plan with errors', () => {
    const empty = assertExecutablePlan(contract(), []);
    expect(empty.executable).toBe(false);
    expect(empty.blockers).toContain('Plan contains no task.');

    const invalid = assertExecutablePlan(contract(), [
      createAtomicTask({ id: 'a', title: 'A' }),
    ]);
    expect(invalid.executable).toBe(false);
    expect(invalid.blockers.some((blocker) => blocker.includes('exit criteria'))).toBe(true);
  });

  it('passes a well-formed plan', () => {
    const tasks = [
      createAtomicTask({
        id: 'a',
        title: 'A',
        writeScope: ['src/a.ts'],
        exitCriteria: [criterion('c1')],
        requiredEvidence: [evidence()],
        budget: { maxTokens: 50, maxDurationMs: 1000, estimatedCostUsd: 0.01 },
        riskLevel: 'medium',
      }),
      createAtomicTask({
        id: 'b',
        title: 'B',
        role: 'reviewer',
        dependsOn: ['a'],
        exitCriteria: [criterion('c2', 'npm run lint')],
        requiredEvidence: [evidence('npm run lint')],
      }),
    ];

    const result = assertExecutablePlan(contract(), tasks);
    expect(result.executable).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('summarizes a plan', () => {
    const tasks = [
      createAtomicTask({
        id: 'a',
        title: 'A',
        role: 'implementer',
        writeScope: ['src/a.ts', 'src/b.ts'],
        exitCriteria: [criterion('c1')],
        requiredEvidence: [evidence()],
        budget: { maxTokens: 100, maxToolCalls: 3, estimatedCostUsd: 0.02 },
        riskLevel: 'low',
      }),
      createAtomicTask({
        id: 'b',
        title: 'B',
        role: 'security',
        writeScope: ['src/b.ts'],
        exitCriteria: [criterion('c2')],
        requiredEvidence: [evidence()],
        budget: { maxTokens: 50, maxToolCalls: 2, estimatedCostUsd: 0.03 },
        riskLevel: 'high',
      }),
    ];

    const summary = summarizePlan(tasks);
    expect(summary.taskCount).toBe(2);
    expect(summary.groupCount).toBe(1);
    expect(summary.filesTouched).toEqual(['src/a.ts', 'src/b.ts']);
    expect(summary.highestRisk).toBe('high');
    expect(summary.totalBudget.maxTokens).toBe(150);
    expect(summary.totalBudget.estimatedCostUsd).toBeCloseTo(0.05);
    expect(summary.roles.sort()).toEqual(['implementer', 'security']);
  });

  it('collects capabilities and planned commands without duplicates', () => {
    const tasks = [
      createAtomicTask({
        id: 'a',
        title: 'A',
        exitCriteria: [criterion('c1', 'npm test'), criterion('c2', 'npm test')],
        requiredEvidence: [evidence('npm run lint')],
        requestedCapabilities: ['read', 'shell'],
      }),
      createAtomicTask({
        id: 'b',
        title: 'B',
        requestedCapabilities: ['read', 'write'],
      }),
    ];

    expect(collectRequestedCapabilities(tasks).sort()).toEqual(['read', 'shell', 'write']);
    expect(collectPlannedCommands(tasks)).toEqual(['npm run lint', 'npm test']);
  });
});
