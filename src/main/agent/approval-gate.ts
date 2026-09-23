/**
 * @module main/agent/approval-gate
 *
 * Cowork 4.0 — Phase 1.3/1.4: builds the approval page payload (plan, file
 * scope, planned commands, risk, estimated cost) and is the single place that
 * decides whether execution may start. Execution is blocked whenever the
 * contract or the plan leaves a criterion, scope or permission implicit.
 */

import type { AtomicTask, Capability, TaskContract } from '../../shared/task-contract';
import { isContractExecutable } from '../../shared/task-contract';
import {
  assertExecutablePlan,
  collectPlannedCommands,
  collectRequestedCapabilities,
  summarizePlan,
} from './task-planner';
import { evaluatePermission, type PermissionPolicy } from './permission-policy';
import { appendAdversarialReview, buildRoleTasks } from './role-planner';
import type {
  ApprovalDecisionInput,
  ApprovalOutcome,
  ApprovalRequest,
  PermissionEvaluation,
  RolePlanInput,
} from '../../shared/workflow-types';

export type { ApprovalDecisionInput, ApprovalOutcome, ApprovalRequest };

export interface BuildApprovalRequestOptions {
  now?: () => number;
}

/**
 * Compose the approval payload. Never mutates the contract or tasks, so it is
 * safe to call repeatedly from the UI while the user reviews the plan.
 */
export function buildApprovalRequest(
  contract: TaskContract,
  tasks: AtomicTask[],
  policy: PermissionPolicy,
  options: BuildApprovalRequestOptions = {}
): ApprovalRequest {
  const now = options.now ?? (() => Date.now());
  const contractResult = isContractExecutable(contract);
  const planResult = assertExecutablePlan(contract, tasks);
  const summary = summarizePlan(tasks);
  const capabilities = collectRequestedCapabilities(tasks);
  const plannedCommands = collectPlannedCommands(tasks);

  const permissionEvaluations: PermissionEvaluation[] = [];
  const blockers = [...planResult.blockers];

  if (!contractResult.executable) {
    for (const issue of contractResult.issues) {
      if (issue.severity === 'error') {
        blockers.push('contract: ' + issue.message);
      }
    }
  }

  const requiresConfirmation: Capability[] = [];

  for (const capability of capabilities) {
    const evaluation = evaluatePermission(policy, {
      capability,
      path: policy.workspaceRoot,
    });
    permissionEvaluations.push(evaluation);
    if (evaluation.decision === 'forbidden') {
      blockers.push('capability "' + capability + '" is forbidden by policy.');
    } else if (evaluation.decision === 'confirm') {
      requiresConfirmation.push(capability);
    }
  }

  for (const command of plannedCommands) {
    const evaluation = evaluatePermission(policy, { capability: 'shell', command });
    permissionEvaluations.push(evaluation);
    if (evaluation.decision === 'forbidden') {
      blockers.push('command "' + command + '" is forbidden by policy.');
    } else if (evaluation.decision === 'confirm' && !requiresConfirmation.includes('shell')) {
      requiresConfirmation.push('shell');
    }
  }

  return {
    contractId: contract.id,
    objective: contract.objective,
    mode: contract.mode,
    summary,
    fileScope: summary.filesTouched.length > 0 ? summary.filesTouched : [...contract.allowedFiles],
    plannedCommands,
    riskLevel: summary.highestRisk,
    // Task-level estimates win; fall back to the contract-level estimate so a
    // plan that has not been broken down yet still shows a cost on the page.
    estimatedCostUsd: summary.totalBudget.estimatedCostUsd ?? contract.budget.estimatedCostUsd ?? null,
    capabilities,
    permissionEvaluations,
    blockers,
    requiresConfirmation,
    createdAt: now(),
  };
}

/**
 * Apply a human decision to a request. A request with blockers can never be
 * approved: the user must fix the contract or the plan first.
 */
export function evaluateApproval(
  request: ApprovalRequest,
  decision: ApprovalDecisionInput
): ApprovalOutcome {
  if (request.blockers.length > 0) {
    return {
      approved: false,
      reasons: ['Execution blocked: ' + request.blockers.join(' | ')],
    };
  }
  if (!decision.approved) {
    return {
      approved: false,
      reasons: [decision.reason?.trim() || 'Rejected by user.'],
    };
  }
  return { approved: true, reasons: [] };
}

/**
 * Phase 3.1 — example tasks shown on the approval page before the agent commits
 * to a concrete plan. The page can therefore show the real scope, roles and
 * estimated cost even when the model has not produced its task list yet.
 */
export function buildForecastTasks(contract: TaskContract, input: RolePlanInput): AtomicTask[] {
  return appendAdversarialReview(buildRoleTasks(input, contract), contract);
}

/** One-line summary used in the audit log and notifications. */
export function describeApprovalRequest(request: ApprovalRequest): string {
  const cost =
    request.estimatedCostUsd === null ? 'n/a' : '$' + request.estimatedCostUsd.toFixed(4);
  return (
    request.summary.taskCount +
    ' task(s), risk ' +
    request.riskLevel +
    ', ' +
    request.fileScope.length +
    ' file(s), est. ' +
    cost
  );
}
