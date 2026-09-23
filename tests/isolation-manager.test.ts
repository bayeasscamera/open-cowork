import { describe, it, expect, vi } from 'vitest';
import { IsolationManager, branchFor } from '../src/main/agent/isolation-manager';
import { AuditLog } from '../src/main/agent/audit-log';
import { planIsolation } from '../src/main/agent/isolation-planner';
import { createAtomicTask } from '../src/shared/task-contract';
import type { GitRunner } from '../src/main/agent/checkpoint-manager';

const task = createAtomicTask({
  id: 'implementer',
  title: 'Implement',
  role: 'implementer',
  writeScope: ['src/a.ts'],
  riskLevel: 'medium',
  requestedCapabilities: ['read', 'write'],
});

function makeManager(results: Array<{ exitCode: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  let index = 0;
  const git: GitRunner = {
    run: async (args) => {
      calls.push(args);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return { exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  };
  const audit = new AuditLog();
  return { manager: new IsolationManager({ git, audit }), calls, audit };
}

describe('isolation-manager', () => {
  it('builds a cowork branch name', () => {
    expect(branchFor('task/one')).toBe('cowork/task-one');
  });

  it('creates a worktree for a plan', async () => {
    const { manager, calls } = makeManager([{ exitCode: 0 }]);
    const plan = planIsolation([task], '/tmp/ws')[0];
    const created = await manager.create(plan);

    expect(created.created).toBe(true);
    expect(created.branch).toBe('cowork/implementer');
    expect(calls[0][0]).toBe('worktree');
    expect(calls[0]).toContain(plan.worktreePath);
    expect(manager.isActive('implementer')).toBe(true);
  });

  it('never throws when git refuses to create the worktree', async () => {
    const { manager } = makeManager([{ exitCode: 128, stderr: 'fatal: not a git repository' }]);
    const created = await manager.create(planIsolation([task], '/tmp/ws')[0]);

    expect(created.created).toBe(false);
    expect(created.error).toContain('not a git repository');
    expect(manager.isActive('implementer')).toBe(false);
  });

  it('records isolation in the audit log', async () => {
    const { manager, audit } = makeManager([{ exitCode: 0 }]);
    await manager.create(planIsolation([task], '/tmp/ws')[0]);
    expect(audit.list()[0].action).toBe('isolation.create');
    expect(audit.list()[0].authorization).toBe('approved');
  });

  it('captures the worktree diff as evidence', async () => {
    const { manager } = makeManager([{ exitCode: 0 }, { exitCode: 0, stdout: 'src/a.ts | 2 +-' }]);
    await manager.create(planIsolation([task], '/tmp/ws')[0]);
    await expect(manager.diff('implementer')).resolves.toContain('src/a.ts');
    await expect(manager.diff('ghost')).resolves.toBe('');
  });

  it('cleans up a worktree and its branch', async () => {
    const { manager, calls } = makeManager([{ exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 }]);
    await manager.create(planIsolation([task], '/tmp/ws')[0]);
    const result = await manager.cleanup('implementer');

    expect(result.removed).toBe(true);
    expect(manager.isActive('implementer')).toBe(false);
    expect(calls.some((args) => args[0] === 'branch' && args[1] === '-D')).toBe(true);
  });

  it('reports a missing worktree instead of throwing', async () => {
    const { manager } = makeManager([{ exitCode: 0 }]);
    await expect(manager.cleanup('ghost')).resolves.toEqual({
      removed: false,
      reason: 'no active worktree for task ghost',
    });
  });

  it('cleans up every worktree at once', async () => {
    const second = createAtomicTask({
      id: 'tester',
      title: 'Test',
      riskLevel: 'high',
      requestedCapabilities: ['read', 'shell'],
    });
    const { manager } = makeManager([{ exitCode: 0 }]);
    const plans = planIsolation([task, second], '/tmp/ws');
    for (const plan of plans) {
      await manager.create({ ...plan, worktreePath: plan.worktreePath + '-x' });
    }
    expect(manager.activeTaskIds().sort()).toEqual(['implementer', 'tester']);
    await manager.cleanupAll();
    expect(manager.activeTaskIds()).toEqual([]);
  });

  it('is silent about a failing branch deletion', async () => {
    const git: GitRunner = { run: vi.fn(async (args: string[]) => ({ exitCode: args[0] === 'worktree' ? 0 : 1, stdout: '', stderr: 'no branch' })) };
    const manager = new IsolationManager({ git });
    await manager.create(planIsolation([task], '/tmp/ws')[0]);
    await expect(manager.cleanup('implementer')).resolves.toEqual({ removed: true });
  });
});
