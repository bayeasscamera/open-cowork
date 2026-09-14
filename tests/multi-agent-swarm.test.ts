import { describe, it, expect, vi } from 'vitest';
import { MultiAgentCoordinator } from '../src/main/agent/multi-agent-coordinator';

describe('MultiAgentCoordinator Swarm', () => {
  it('creates and executes DAG plan with concurrent tasks', async () => {
    const executedTaskOrder: string[] = [];

    const coordinator = new MultiAgentCoordinator(async (task, context) => {
      executedTaskOrder.push(task.role);
      return `Done: ${task.title}`;
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
});
