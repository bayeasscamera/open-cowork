/**
 * @module main/agent/role-planner
 *
 * Cowork 4.0 — Phase 3.1/3.2/3.4: replaces the fixed DAG with an adaptive role
 * planner. Roles are chosen from the shape of the request, and each role gets a
 * contract, a token/time budget and the minimal capability set it needs.
 */

import type {
  AgentRole,
  AtomicTask,
  Capability,
  TaskBudget,
  TaskContract,
} from '../../shared/task-contract';
import { createAtomicTask } from '../../shared/task-contract';
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
// ---------------------------------------------------------------------------
// Phase 3.2/3.4 — turn roles into atomic tasks (contract, budget, permissions)
// ---------------------------------------------------------------------------

const ROLE_RISK: Readonly<Record<AgentRole, 'low' | 'medium' | 'high'>> = Object.freeze({
  scout: 'low',
  'web-researcher': 'low',
  architect: 'low',
  implementer: 'medium',
  tester: 'low',
  reviewer: 'low',
  security: 'low',
});

function roleExitCriteria(
  role: AgentRole,
  contract: TaskContract
): TaskContract['acceptanceCriteria'] {
  switch (role) {
    case 'implementer':
      return contract.acceptanceCriteria.length > 0
        ? contract.acceptanceCriteria.map((criterion) => ({ ...criterion }))
        : [
            {
              id: 'impl-done',
              description: 'Change implemented within the contract scope.',
              verification: 'inspection: per-task diff',
              required: true,
            },
          ];
    case 'tester':
      return [
        {
          id: 'tests-pass',
          description: 'Automated tests pass for the change.',
          verification: 'npm test',
          required: true,
        },
      ];
    case 'reviewer':
      return [
        {
          id: 'adversarial-review',
          description: 'Adversarial review completed; findings cited with evidence.',
          verification: 'inspection: findings list',
          required: true,
        },
      ];
    case 'security':
      return [
        {
          id: 'security-audit',
          description: 'No security regression introduced.',
          verification: 'inspection: security note',
          required: true,
        },
      ];
    case 'scout':
      return [
        {
          id: 'scout-map',
          description: 'Relevant codebase surface mapped.',
          verification: 'inspection: module list',
          required: true,
        },
      ];
    case 'web-researcher':
      return [
        {
          id: 'web-evidence',
          description: 'External evidence gathered with citations.',
          verification: 'inspection: cited sources',
          required: true,
        },
      ];
    case 'architect':
      return [
        {
          id: 'design-proposal',
          description: 'Minimal design and forecast diff proposed.',
          verification: 'inspection: design note',
          required: true,
        },
      ];
  }
}

function roleEvidence(role: AgentRole, contract: TaskContract): TaskContract['expectedEvidence'] {
  switch (role) {
    case 'implementer':
      return contract.expectedEvidence.length > 0
        ? contract.expectedEvidence.map((evidence) => ({ ...evidence }))
        : [{ kind: 'diff', description: 'Per-task diff', required: true }];
    case 'tester':
      return [{ kind: 'test', description: 'Test run output', command: 'npm test', required: true }];
    case 'reviewer':
      return [{ kind: 'review', description: 'Adversarial findings', required: true }];
    case 'security':
      return [{ kind: 'review', description: 'Security findings', required: true }];
    case 'scout':
      return [{ kind: 'note', description: 'Surface map', required: true }];
    case 'web-researcher':
      return [{ kind: 'note', description: 'Cited sources', required: true }];
    case 'architect':
      return [{ kind: 'note', description: 'Design note', required: true }];
  }
}

/** Dependencies between roles: implementers wait for scouting/design, then verification. */
function roleDependencies(role: AgentRole, roles: AgentRole[]): string[] {
  const has = (candidate: AgentRole) => roles.includes(candidate);
  switch (role) {
    case 'scout':
    case 'web-researcher':
      return [];
    case 'architect':
      return has('scout') ? ['scout'] : [];
    case 'implementer': {
      const deps: string[] = [];
      if (has('scout')) {
        deps.push('scout');
      }
      if (has('architect')) {
        deps.push('architect');
      }
      return deps;
    }
    case 'tester':
    case 'reviewer':
    case 'security':
      return has('implementer') ? ['implementer'] : [];
  }
}

/**
 * Expand the adaptive role selection into a full atomic task DAG, each task
 * carrying its own budget, least-privilege capabilities and exit criteria.
 */
export function buildRoleTasks(input: RolePlanInput, contract: TaskContract): AtomicTask[] {
  const roles = selectRoles(input);
  return roles.map((role) =>
    createAtomicTask({
      id: role,
      title: objectiveForRole(role, contract.objective),
      role,
      dependsOn: roleDependencies(role, roles),
      writeScope: role === 'implementer' ? [...contract.allowedFiles] : [],
      exitCriteria: roleExitCriteria(role, contract),
      requiredEvidence: roleEvidence(role, contract),
      budget: { ...DEFAULT_ROLE_BUDGETS[role] },
      riskLevel: ROLE_RISK[role],
      parallelizable: !WRITE_ROLES.includes(role),
      requestedCapabilities: [...ROLE_CAPABILITIES[role]],
    })
  );
}

/**
 * Phase 3.4 — append a final adversarial review that depends on every other
 * task. Idempotent: a second call returns the same plan.
 */
export function appendAdversarialReview(
  tasks: AtomicTask[],
  contract: TaskContract
): AtomicTask[] {
  if (tasks.some((task) => task.id === ADVERSARIAL_REVIEW_TASK_ID)) {
    return tasks;
  }
  const dependsOn = tasks.map((task) => task.id);
  const review = createAtomicTask({
    id: ADVERSARIAL_REVIEW_TASK_ID,
    title: 'Adversarial review: ' + contract.objective,
    role: 'reviewer',
    dependsOn,
    writeScope: [],
    exitCriteria: [
      {
        id: 'adversarial-review',
        description: adversarialReviewDirective(),
        verification: 'inspection: falsification attempts and findings',
        required: true,
      },
    ],
    requiredEvidence: [
      { kind: 'review', description: 'Falsification attempts with evidence', required: true },
    ],
    budget: { ...DEFAULT_ROLE_BUDGETS.reviewer },
    riskLevel: 'low',
    parallelizable: false,
    requestedCapabilities: ['read'],
  });
  return [...tasks, review];
}

export const ADVERSARIAL_REVIEW_TASK_ID = 'adversarial-review';

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
