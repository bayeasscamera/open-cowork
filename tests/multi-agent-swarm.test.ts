import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { MultiAgentCoordinator } from '../src/main/agent/multi-agent-coordinator';
import { getCodeGraphIndexer } from '../src/main/memory/codegraph-indexer';

describe('MultiAgentCoordinator Swarm', () => {
  it('creates and executes DAG plan with concurrent tasks', async () => {
    const executedTaskOrder: string[] = [];

    const coordinator = new MultiAgentCoordinator(async (task, context) => {
      executedTaskOrder.push(task.role);
      return { output: `Done: ${task.title}` };
    });

    const plan = coordinator.createCollaborativePlan('Implement OAuth2 SSO Flow');
    expect(plan.tasks.length).toBe(4);
    expect(plan.status).toBe('planning');

    const completedPlan = await coordinator.executePlan(plan.id);

    expect(completedPlan.status).toBe('done');
    expect(completedPlan.tasks.every((t) => t.status === 'completed')).toBe(true);

    // Architect must run first
    expect(executedTaskOrder[0]).toBe('architect');
    // Developer runs second
    expect(executedTaskOrder[1]).toBe('developer');
    // Reviewer and security can run concurrently after developer
    expect(executedTaskOrder.slice(2)).toContain('reviewer');
    expect(executedTaskOrder.slice(2)).toContain('security');
  });

  it('invalidates the shared codegraph index for files a sub-agent modified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-swarm-'));
    const fileA = join(dir, 'a.ts');
    const fileB = join(dir, 'b.ts');
    writeFileSync(fileA, 'export function alpha() {}\n');
    writeFileSync(fileB, 'export function beta() {}\n');

    const indexer = getCodeGraphIndexer();
    await indexer.scanDirectory(dir, ['.ts'], true);
    expect(indexer.searchSymbol('alpha').length).toBe(1);
    expect(indexer.searchSymbol('beta').length).toBe(1);

    const coordinator = new MultiAgentCoordinator(async (task) => {
      // The developer sub-agent modifies exactly one file.
      if (task.role === 'developer') {
        return { output: 'patched', modifiedFiles: [fileA] };
      }
      return { output: 'no changes' };
    });
    const plan = coordinator.createCollaborativePlan('Implement OAuth2 SSO Flow');
    await coordinator.executePlan(plan.id);

    // The modified file was invalidated; the untouched one stayed indexed.
    expect(indexer.searchSymbol('alpha').length).toBe(0);
    expect(indexer.searchSymbol('beta').length).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('MultiAgentCoordinator aggregation policy', () => {
  it('fails the plan and marks blocked dependents skipped under the default fail-all policy', async () => {
    const coordinator = new MultiAgentCoordinator(async (task) => {
      if (task.role === 'developer') throw new Error('boom');
      return { output: `done ${task.role}` };
    });
    const plan = coordinator.createCollaborativePlan('goal');
    const executed = await coordinator.executePlan(plan.id);

    expect(executed.aggregationPolicy).toBe('fail-all');
    expect(executed.status).toBe('failed');
    const byRole = Object.fromEntries(executed.tasks.map((t) => [t.role, t.status]));
    expect(byRole).toEqual({
      architect: 'completed',
      developer: 'failed',
      reviewer: 'skipped',
      security: 'skipped',
    });
    expect(executed.aggregation).toEqual({
      policy: 'fail-all',
      completed: 1,
      failed: 1,
      skipped: 2,
      retried: 0,
      recovered: 0,
    });
    // A blocked task is explicitly skipped with a reason — never left pending.
    expect(executed.tasks.find((t) => t.role === 'reviewer')?.error).toContain('upstream task');
  });

  it('aggregates as done under partial-ok while still reporting the failure', async () => {
    const coordinator = new MultiAgentCoordinator(async (task) => {
      if (task.role === 'developer') throw new Error('boom');
      return { output: `done ${task.role}` };
    });
    const plan = coordinator.createCollaborativePlan('goal', { aggregationPolicy: 'partial-ok' });
    const executed = await coordinator.executePlan(plan.id);

    expect(executed.status).toBe('done');
    expect(executed.aggregation).toMatchObject({
      policy: 'partial-ok',
      completed: 1,
      failed: 1,
      skipped: 2,
    });
  });

  it('reports total failure even under partial-ok when nothing completed', async () => {
    const coordinator = new MultiAgentCoordinator(async (task) => {
      if (task.role === 'architect') throw new Error('boom');
      return { output: 'unreachable' };
    });
    const plan = coordinator.createCollaborativePlan('goal', { aggregationPolicy: 'partial-ok' });
    const executed = await coordinator.executePlan(plan.id);

    expect(executed.status).toBe('failed');
    expect(executed.tasks.every((t) => t.status !== 'completed')).toBe(true);
    expect(executed.aggregation).toMatchObject({ completed: 0, failed: 1, skipped: 3 });
  });

  it('retries only the failed task and resumes its dependents under retry-failed-only', async () => {
    let developerCalls = 0;
    const coordinator = new MultiAgentCoordinator(async (task) => {
      if (task.role === 'developer') {
        developerCalls += 1;
        if (developerCalls === 1) throw new Error('transient');
      }
      return { output: `done ${task.role}` };
    });
    const plan = coordinator.createCollaborativePlan('goal', {
      aggregationPolicy: 'retry-failed-only',
    });
    const executed = await coordinator.executePlan(plan.id);

    expect(developerCalls).toBe(2); // exactly one retry, no loop
    expect(executed.status).toBe('done');
    expect(executed.tasks.every((t) => t.status === 'completed')).toBe(true);
    expect(executed.aggregation).toMatchObject({
      policy: 'retry-failed-only',
      completed: 4,
      failed: 0,
      skipped: 0,
      retried: 1,
      recovered: 1,
    });
  });

  it('stays failed when the single retry does not recover the task', async () => {
    let developerCalls = 0;
    const coordinator = new MultiAgentCoordinator(async (task) => {
      if (task.role === 'developer') {
        developerCalls += 1;
        throw new Error(`attempt ${developerCalls}`);
      }
      return { output: `done ${task.role}` };
    });
    const plan = coordinator.createCollaborativePlan('goal', {
      aggregationPolicy: 'retry-failed-only',
    });
    const executed = await coordinator.executePlan(plan.id);

    expect(developerCalls).toBe(2); // exactly one retry
    expect(executed.status).toBe('failed');
    const developer = executed.tasks.find((t) => t.role === 'developer');
    expect(developer?.retried).toBe(true);
    expect(developer?.recovered).toBeUndefined();
    expect(executed.aggregation).toMatchObject({
      retried: 1,
      recovered: 0,
      failed: 1,
      skipped: 2,
    });
  });

  it('does not run the cross-verification debate unless explicitly opted in', async () => {
    const coordinator = new MultiAgentCoordinator(async (task) => ({
      output: `done ${task.role}`,
    }));
    const plan = coordinator.createCollaborativePlan('goal');
    expect(plan.crossVerification).toBe(false);

    const executed = await coordinator.executePlan(plan.id);
    expect(executed.crossVerificationResults).toBeUndefined();
  });
});
