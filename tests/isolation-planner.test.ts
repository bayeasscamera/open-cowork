import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ISOLATION_POLICY,
  describeCleanup,
  joinWorktreePath,
  planIsolation,
  shouldIsolateTask,
} from '../src/main/agent/isolation-planner';
import { createAtomicTask } from '../src/shared/task-contract';

const risky = createAtomicTask({
  id: 'implementer',
  title: 'Implement',
  role: 'implementer',
  writeScope: ['src/a.ts'],
  riskLevel: 'medium',
  requestedCapabilities: ['read', 'write', 'shell'],
});

const readOnly = createAtomicTask({
  id: 'reviewer',
  title: 'Review',
  role: 'reviewer',
  riskLevel: 'low',
  requestedCapabilities: ['read'],
});

describe('isolation-planner', () => {
  it('isolates tasks at or above the risk threshold', () => {
    expect(shouldIsolateTask(risky)).toBe(true);
    expect(shouldIsolateTask(createAtomicTask({ id: 'high', title: 'H', riskLevel: 'high' }))).toBe(true);
  });

  it('isolates read-only tasks that still request shell access', () => {
    const task = createAtomicTask({
      id: 'tester',
      title: 'Test',
      riskLevel: 'low',
      requestedCapabilities: ['read', 'shell'],
    });
    expect(shouldIsolateTask(task)).toBe(true);
  });

  it('leaves a pure read-only task in the live workspace', () => {
    expect(shouldIsolateTask(readOnly)).toBe(false);
  });

  it('isolates tasks touching many files even without risky capabilities', () => {
    const wide = createAtomicTask({
      id: 'wide',
      title: 'Wide',
      riskLevel: 'low',
      requestedCapabilities: ['read'],
      writeScope: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(shouldIsolateTask(wide)).toBe(true);
  });

  it('honours a custom policy', () => {
    const permissive = { minRisk: 'high' as const, isolateOnRiskyCapability: false, maxFilesWithoutIsolation: 99 };
    expect(shouldIsolateTask(risky, permissive)).toBe(false);
    expect(shouldIsolateTask(risky, DEFAULT_ISOLATION_POLICY)).toBe(true);
  });

  it('plans worktrees only for the tasks that need them', () => {
    const plans = planIsolation([risky, readOnly], '/ws');
    expect(plans).toHaveLength(1);
    expect(plans[0].taskId).toBe('implementer');
    expect(plans[0].mode).toBe('worktree');
    expect(plans[0].ephemeral).toBe(true);
    expect(plans[0].worktreePath).toBe('/ws/.cowork-worktrees/implementer');
  });

  it('builds deterministic and safe worktree paths', () => {
    expect(joinWorktreePath('/ws/', 'task/one')).toBe('/ws/.cowork-worktrees/task-one');
    expect(joinWorktreePath('/ws', 'a b')).toBe('/ws/.cowork-worktrees/a-b');
  });

  it('describes cleanup for the plan', () => {
    const artifacts = describeCleanup(planIsolation([risky], '/ws'));
    expect(artifacts.cleanupPaths).toEqual(['/ws/.cowork-worktrees/implementer']);
    expect(artifacts.workspaceUntouched).toBe(true);
  });
});
