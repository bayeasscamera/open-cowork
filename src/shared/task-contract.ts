/**
 * @module shared/task-contract
 *
 * Cowork 4.0 — Phase 0: the `TaskContract` is the single source of truth every
 * workflow mode, planner, checkpoint and sub-agent agrees on *before* any work
 * starts. It is intentionally pure data + pure validation so it can be shared
 * by the main process, the preload bridge and the renderer.
 *
 * The contract answers five questions up front:
 *   1. What is the objective?            -> `objective`
 *   2. Which files may be touched?       -> `allowedFiles`
 *   3. How do we know it is done?        -> `acceptanceCriteria`
 *   4. What may we spend?                -> `budget`
 *   5. What must be proven, and who must approve? -> `expectedEvidence`, `approvalPolicy`
 */

import type { WriteScopeConflict } from './write-scope-conflicts';

// ---------------------------------------------------------------------------
// Workflow modes (Phase 1)
// ---------------------------------------------------------------------------

/** The three user-visible workflow modes. */
export type WorkflowMode = 'explore' | 'plan' | 'execute';

/** What a mode is allowed to do. Enforced by the approval gate, not by prompt text. */
export interface WorkflowModeCapabilities {
  /** Read files inside the workspace. */
  read: boolean;
  /** Search / grep / index the codebase. */
  search: boolean;
  /** Run read-only diagnostics (typecheck, tests, git status). */
  diagnose: boolean;
  /** Mutate files. */
  write: boolean;
  /** Run arbitrary shell commands. */
  shell: boolean;
  /** Whether the mode must be approved before it can act. */
  requiresApproval: boolean;
}

export const WORKFLOW_MODE_CAPABILITIES: Readonly<Record<WorkflowMode, WorkflowModeCapabilities>> =
  Object.freeze({
    explore: {
      read: true,
      search: true,
      diagnose: true,
      write: false,
      shell: false,
      requiresApproval: false,
    },
    plan: {
      read: true,
      search: true,
      diagnose: true,
      write: false,
      shell: false,
      requiresApproval: true,
    },
    execute: {
      read: true,
      search: true,
      diagnose: true,
      write: true,
      shell: true,
      requiresApproval: true,
    },
  });

export const WORKFLOW_MODES: readonly WorkflowMode[] = ['explore', 'plan', 'execute'] as const;

/** Human-readable purpose of each mode, used by the UI and prompts. */
export const WORKFLOW_MODE_DESCRIPTIONS: Readonly<Record<WorkflowMode, string>> = Object.freeze({
  explore: 'Read, search and diagnose only. No writes, no side effects.',
  plan: 'Propose a plan and a forecast diff. Still no writes.',
  execute: 'Apply approved changes, task by task, with checkpoints and evidence.',
});

export function isWorkflowMode(value: unknown): value is WorkflowMode {
  return value === 'explore' || value === 'plan' || value === 'execute';
}

// ---------------------------------------------------------------------------
// Capabilities & roles
// ---------------------------------------------------------------------------

/** Security-relevant capability a task may request (Phase 5). */
export type Capability =
  | 'read'
  | 'write'
  | 'shell'
  | 'network'
  | 'git'
  | 'browser'
  | 'mcp'
  | 'outside-workspace';

export const CAPABILITIES: readonly Capability[] = [
  'read',
  'write',
  'shell',
  'network',
  'git',
  'browser',
  'mcp',
  'outside-workspace',
] as const;

/** Specialised sub-agent roles (Phase 3). */
export type AgentRole =
  | 'scout'
  | 'web-researcher'
  | 'architect'
  | 'implementer'
  | 'tester'
  | 'reviewer'
  | 'security';

export const AGENT_ROLES: readonly AgentRole[] = [
  'scout',
  'web-researcher',
  'architect',
  'implementer',
  'tester',
  'reviewer',
  'security',
] as const;

export type RiskLevel = 'low' | 'medium' | 'high';

const RISK_ORDER: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2 };

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface TaskBudget {
  /** Soft cap on tokens spent by the task and its sub-agents. */
  maxTokens?: number;
  /** Wall-clock cap in milliseconds. */
  maxDurationMs?: number;
  /** Cap on tool calls. */
  maxToolCalls?: number;
  /** Monetary estimate in USD, filled by the approval gate when known. */
  estimatedCostUsd?: number;
}

// ---------------------------------------------------------------------------
// Acceptance criteria & evidence
// ---------------------------------------------------------------------------

export interface AcceptanceCriterion {
  id: string;
  description: string;
  /** Command or inspection that proves the criterion. Empty means non-verifiable. */
  verification: string;
  required: boolean;
}

export type EvidenceKind = 'test' | 'command' | 'diff' | 'artifact' | 'review' | 'note';

export interface ExpectedEvidence {
  kind: EvidenceKind;
  description: string;
  /** Command that produces the evidence, when applicable. */
  command?: string;
  required: boolean;
}

// ---------------------------------------------------------------------------
// Approval policy
// ---------------------------------------------------------------------------

/** What a capability requires before it may run. */
export type ApprovalDecision = 'auto' | 'confirm' | 'forbidden';

export interface ApprovalPolicy {
  /** Default decision for capabilities not listed in `overrides`. */
  defaultDecision: ApprovalDecision;
  /** Per-capability override. */
  overrides: Partial<Record<Capability, ApprovalDecision>>;
  /**
   * When true, the approval gate refuses to execute unless the contract lists
   * an explicit file scope and at least one required acceptance criterion.
   */
  requireExplicitScope: boolean;
}

export function createDefaultApprovalPolicy(): ApprovalPolicy {
  return {
    defaultDecision: 'confirm',
    overrides: {
      read: 'auto',
      write: 'confirm',
      shell: 'confirm',
      git: 'confirm',
      network: 'confirm',
      browser: 'confirm',
      mcp: 'confirm',
      'outside-workspace': 'forbidden',
    },
    requireExplicitScope: true,
  };
}

// ---------------------------------------------------------------------------
// TaskContract
// ---------------------------------------------------------------------------

export interface TaskContract {
  id: string;
  /** One-sentence, outcome-oriented objective. */
  objective: string;
  mode: WorkflowMode;
  /** Glob-ish paths the contract authorises. `['**']` means whole workspace. */
  allowedFiles: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  budget: TaskBudget;
  approvalPolicy: ApprovalPolicy;
  expectedEvidence: ExpectedEvidence[];
  /** Capabilities explicitly requested by the contract. */
  requestedCapabilities: Capability[];
  workspaceRoot?: string;
  createdAt: number;
}

export interface CreateTaskContractInput {
  objective: string;
  mode?: WorkflowMode;
  allowedFiles?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  budget?: TaskBudget;
  approvalPolicy?: ApprovalPolicy;
  expectedEvidence?: ExpectedEvidence[];
  requestedCapabilities?: Capability[];
  workspaceRoot?: string;
  id?: string;
  createdAt?: number;
}

/** Deterministic, dependency-free id generator (no crypto import in shared). */
function defaultId(prefix: string): string {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function createTaskContract(input: CreateTaskContractInput): TaskContract {
  const mode = input.mode ?? 'execute';
  const capabilities = input.requestedCapabilities ?? capabilitiesForMode(mode);
  return {
    id: input.id ?? defaultId('contract'),
    objective: input.objective.trim(),
    mode,
    allowedFiles: input.allowedFiles ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    budget: input.budget ?? {},
    approvalPolicy: input.approvalPolicy ?? createDefaultApprovalPolicy(),
    expectedEvidence: input.expectedEvidence ?? [],
    requestedCapabilities: capabilities,
    workspaceRoot: input.workspaceRoot,
    createdAt: input.createdAt ?? Date.now(),
  };
}

/** Capabilities a mode implies before any explicit request. */
export function capabilitiesForMode(mode: WorkflowMode): Capability[] {
  switch (mode) {
    case 'explore':
      return ['read'];
    case 'plan':
      return ['read'];
    case 'execute':
      return ['read', 'write', 'shell'];
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ContractIssueCode =
  | 'missing-objective'
  | 'empty-allowed-files'
  | 'no-acceptance-criteria'
  | 'non-verifiable-criterion'
  | 'no-expected-evidence'
  | 'missing-budget'
  | 'scope-not-explicit'
  | 'capability-not-requested'
  | 'mode-cannot-write';

export interface ContractValidationIssue {
  code: ContractIssueCode;
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

/**
 * Validates a contract without executing anything. Errors block execution;
 * warnings are surfaced to the user but do not block.
 */
export function validateTaskContract(contract: TaskContract): ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];

  if (!contract.objective || contract.objective.trim().length === 0) {
    issues.push({
      code: 'missing-objective',
      severity: 'error',
      field: 'objective',
      message: 'Contract objective must be a non-empty sentence.',
    });
  }

  const writes = contract.requestedCapabilities.includes('write');
  if (writes && contract.allowedFiles.length === 0) {
    issues.push({
      code: 'empty-allowed-files',
      severity: 'error',
      field: 'allowedFiles',
      message: 'A contract that may write must declare an explicit file scope.',
    });
  }

  if (contract.acceptanceCriteria.length === 0) {
    issues.push({
      code: 'no-acceptance-criteria',
      severity: 'error',
      field: 'acceptanceCriteria',
      message: 'At least one acceptance criterion is required to verify the work.',
    });
  }

  for (const criterion of contract.acceptanceCriteria) {
    if (!criterion.verification || criterion.verification.trim().length === 0) {
      issues.push({
        code: 'non-verifiable-criterion',
        severity: 'error',
        field: 'acceptanceCriteria.' + criterion.id,
        message: 'Criterion "' + criterion.id + '" has no verification method.',
      });
    }
  }

  if (contract.expectedEvidence.length === 0) {
    issues.push({
      code: 'no-expected-evidence',
      severity: 'warning',
      field: 'expectedEvidence',
      message: 'No expected evidence declared: verification will be unproven.',
    });
  }

  const hasBudget =
    contract.budget.maxTokens !== undefined ||
    contract.budget.maxDurationMs !== undefined ||
    contract.budget.maxToolCalls !== undefined;
  if (!hasBudget) {
    issues.push({
      code: 'missing-budget',
      severity: 'warning',
      field: 'budget',
      message: 'No budget declared: the task may run unbounded.',
    });
  }

  if (writes && contract.approvalPolicy.requireExplicitScope && contract.allowedFiles.length === 0) {
    issues.push({
      code: 'scope-not-explicit',
      severity: 'error',
      field: 'approvalPolicy.requireExplicitScope',
      message: 'Approval policy requires an explicit scope but none is declared.',
    });
  }

  if (!WORKFLOW_MODE_CAPABILITIES[contract.mode].write && writes) {
    issues.push({
      code: 'mode-cannot-write',
      severity: 'error',
      field: 'mode',
      message: 'Mode "' + contract.mode + '" cannot request the write capability.',
    });
  }

  return issues;
}

export interface ContractExecutabilityResult {
  executable: boolean;
  issues: ContractValidationIssue[];
}

/** True when no error-severity issue remains. Warnings never block. */
export function isContractExecutable(contract: TaskContract): ContractExecutabilityResult {
  const issues = validateTaskContract(contract);
  return { executable: !issues.some((issue) => issue.severity === 'error'), issues };
}

/** Resolve the approval decision for a capability, honouring overrides. */
export function decisionForCapability(
  policy: ApprovalPolicy,
  capability: Capability
): ApprovalDecision {
  return policy.overrides[capability] ?? policy.defaultDecision;
}

// ---------------------------------------------------------------------------
// Atomic tasks & plan (Phase 1/3)
// ---------------------------------------------------------------------------

/**
 * The smallest unit the orchestrator can schedule, approve, checkpoint and
 * verify independently. A plan is an ordered DAG of atomic tasks.
 */
export interface AtomicTask {
  id: string;
  title: string;
  role: AgentRole;
  /** Ids of tasks that must complete first. Empty means ready immediately. */
  dependsOn: string[];
  /** Paths this task is allowed to write. Empty for read-only tasks. */
  writeScope: string[];
  exitCriteria: AcceptanceCriterion[];
  requiredEvidence: ExpectedEvidence[];
  budget: TaskBudget;
  riskLevel: RiskLevel;
  /** Whether the task may run concurrently with other ready tasks. */
  parallelizable: boolean;
  requestedCapabilities: Capability[];
}

/** Aggregate view of a plan, rendered by the approval page. */
export interface PlanSummary {
  taskCount: number;
  groupCount: number;
  filesTouched: string[];
  totalBudget: TaskBudget;
  highestRisk: RiskLevel;
  roles: AgentRole[];
  /**
   * Pairs of unordered tasks whose declared write scopes overlap. They are
   * reported here and serialised at run time; an empty list means the plan is
   * safe to run fully in parallel.
   */
  writeConflicts: WriteScopeConflict[];
}

export function createAtomicTask(
  input: Partial<AtomicTask> & Pick<AtomicTask, 'id' | 'title'>
): AtomicTask {
  return {
    id: input.id,
    title: input.title,
    role: input.role ?? 'implementer',
    dependsOn: input.dependsOn ?? [],
    writeScope: input.writeScope ?? [],
    exitCriteria: input.exitCriteria ?? [],
    requiredEvidence: input.requiredEvidence ?? [],
    budget: input.budget ?? {},
    riskLevel: input.riskLevel ?? 'low',
    parallelizable: input.parallelizable ?? true,
    requestedCapabilities: input.requestedCapabilities ?? ['read'],
  };
}
