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
