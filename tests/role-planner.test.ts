import { describe, it, expect } from 'vitest';
import {
  adversarialReviewDirective,
  planRoles,
  selectRoles,
} from '../src/main/agent/role-planner';
import { createTaskContract } from '../src/shared/task-contract';

const contract = createTaskContract({
  objective: 'Refactor the parser',
  allowedFiles: ['src/**'],
});

describe('role-planner', () => {
  it('selects the baseline roles for a writing task', () => {
    expect(selectRoles({ request: 'fix bug' })).toEqual([
      'scout',
      'implementer',
      'tester',
      'reviewer',
    ]);
  });

  it('adds specialised roles based on the request shape', () => {
    const roles = selectRoles({
      request: 'add auth with docs',
      needsWeb: true,
      multiFile: true,
      riskSensitive: true,
    });
    expect(roles).toContain('web-researcher');
    expect(roles).toContain('architect');
    expect(roles).toContain('security');
  });

  it('drops implementer and tester for read-only work', () => {
    const roles = selectRoles({ request: 'explain', willWrite: false });
    expect(roles).not.toContain('implementer');
    expect(roles).not.toContain('tester');
    expect(roles).toContain('reviewer');
  });

  it('gives each role a budget and least-privilege capabilities', () => {
    const assignments = planRoles({ request: 'fix bug' }, contract);
    const implementer = assignments.find((assignment) => assignment.role === 'implementer');
    const reviewer = assignments.find((assignment) => assignment.role === 'reviewer');

    expect(implementer?.capabilities).toContain('write');
    expect(implementer?.budget.maxTokens).toBeGreaterThan(0);
    expect(reviewer?.capabilities).toEqual(['read']);
    expect(reviewer?.parallelizable).toBe(true);
    expect(implementer?.parallelizable).toBe(false);
  });

  it('frames the reviewer adversarially', () => {
    const directive = adversarialReviewDirective();
    expect(directive).toContain('REJECT');
    expect(directive).toContain('false assumptions');
  });
});
