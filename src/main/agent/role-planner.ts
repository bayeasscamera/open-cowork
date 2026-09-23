/**
 * @module main/agent/role-planner
 *
 * Cowork 4.0 — Phase 3.1/3.2/3.4: replaces the fixed DAG with an adaptive role
 * planner. Roles are chosen from the shape of the request, and each role gets a
 * contract, a token/time budget and the minimal capability set it needs.
 */

import type { AgentRole, Capability, TaskBudget, TaskContract } from '../../shared/task-contract';
import type { RoleAssignment, RolePlanInput } from '../../shared/workflow-types';

export type { RoleAssignment, RolePlanInput } from '../../shared/workflow-types';

const DEFAULT_ROLE_BUDGETS: Readonly<Record<AgentRole, TaskBudget>> = Object.freeze({
  scout: { maxTokens: 6000, maxDurationMs: 120_000, maxToolCalls: 12 },
  'web-researcher': { maxTokens: 8000, maxDurationMs: 180_000, maxToolCalls: 15 },
  architect: { maxTokens: 10000, maxDurationMs: 180_000, maxToolCalls: 10 },
  implementer: { maxTokens: 24000, maxDurationMs: 900_000, maxToolCalls: 60 },
  tester: { maxTokens: 8000, maxDurationMs: 300_000, maxToolCalls: 25 },
  reviewer: { maxTokens: 8000, maxDurationMs: 240_000, maxToolCalls: 20 },
  security: { maxTokens: 8000, maxDurationMs: 240_000, maxToolCalls: 20 },
});

const ROLE_CAPABILITIES: Readonly<Record<AgentRole, Capability[]>> = Object.freeze({
  scout: ['read'],
  'web-researcher': ['read', 'network', 'browser'],
  architect: ['read'],
  implementer: ['read', 'write', 'shell'],
  tester: ['read', 'shell'],
  reviewer: ['read'],
  security: ['read', 'shell'],
});

const WRITE_ROLES: readonly AgentRole[] = ['implementer'];

/**
 * Choose the roles the request actually needs. Deterministic and cheap so it can
 * run on every turn without a model call.
 */
export function selectRoles(input: RolePlanInput): AgentRole[] {
  const roles: AgentRole[] = [];
  const push = (role: AgentRole) => {
    if (!roles.includes(role)) {
      roles.push(role);
    }
  };

  if (input.hasCodebase !== false) {
    push('scout');
  }
  if (input.needsWeb) {
    push('web-researcher');
  }
  if (input.multiFile) {
    push('architect');
  }
  if (input.willWrite !== false) {
    push('implementer');
  }
  if (input.willWrite !== false || input.riskSensitive) {
    push('tester');
  }
  push('reviewer');
  if (input.riskSensitive) {
    push('security');
  }

  return roles;
}

/** Expand selected roles into fully budgeted, least-privilege assignments. */
export function planRoles(input: RolePlanInput, contract: TaskContract): RoleAssignment[] {
  return selectRoles(input).map((role) => ({
    role,
    objective: objectiveForRole(role, contract.objective),
    budget: { ...DEFAULT_ROLE_BUDGETS[role] },
    capabilities: [...ROLE_CAPABILITIES[role]],
    parallelizable: !WRITE_ROLES.includes(role),
  }));
}

function objectiveForRole(role: AgentRole, objective: string): string {
  switch (role) {
    case 'scout':
      return 'Map the codebase surface relevant to: ' + objective;
    case 'web-researcher':
      return 'Gather external evidence needed for: ' + objective;
    case 'architect':
      return 'Propose the minimal design and forecast diff for: ' + objective;
    case 'implementer':
      return 'Implement the approved change for: ' + objective;
    case 'tester':
      return 'Prove the change with automated tests for: ' + objective;
    case 'reviewer':
      return 'Adversarially review the change for: ' + objective;
    case 'security':
      return 'Audit the change for security regressions for: ' + objective;
  }
}

/**
 * Phase 3.4 — the adversarial reviewer is instructed to actively falsify the
 * work rather than approve it. Returns a system-prompt fragment.
 */
export function adversarialReviewDirective(): string {
  return [
    'You are an adversarial reviewer. Your job is to REJECT, not to approve.',
    'Actively hunt for:',
    '- false assumptions the implementer made about the codebase or the API;',
    '- regressions in untouched behaviour, edge cases and error paths;',
    '- acceptance criteria that were declared but never actually verified;',
    '- missing or fabricated evidence (tests not run, output not shown);',
    '- scope creep beyond the contract file scope.',
    'For every finding, cite the file, the concrete failure scenario, and the',
    'evidence that would prove or disprove it. If you cannot falsify the change,',
    'say so explicitly and list the checks you ran.',
  ].join('\n');
}
