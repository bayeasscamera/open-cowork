/**
 * @module shared/workflow-types
 *
 * Cowork 4.0 — IPC-facing workflow types. These are the shapes that cross the
 * main <-> preload <-> renderer boundary, kept in `shared` so the preload
 * bridge never has to import main-process modules.
 */

import type {
  AgentRole,
  AtomicTask,
  Capability,
  EvidenceKind,
  PlanSummary,
  RiskLevel,
  TaskBudget,
  TaskContract,
  WorkflowMode,
} from './task-contract';
import type { ApprovalDecision } from './task-contract';

export type {
  AgentRole,
  AtomicTask,
  Capability,
  EvidenceKind,
  PlanSummary,
  RiskLevel,
  TaskBudget,
  TaskContract,
  WorkflowMode,
};

// ---------------------------------------------------------------------------
// Permissions (Phase 5)
// ---------------------------------------------------------------------------

export interface PermissionEvaluation {
  capability: Capability;
  decision: ApprovalDecision;
  matchedRuleId: string | null;
  reason: string;
}

// ---------------------------------------------------------------------------
// Approval gate (Phase 1.3/1.4)
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  contractId: string;
  objective: string;
  mode: WorkflowMode;
  summary: PlanSummary;
  fileScope: string[];
  plannedCommands: string[];
  riskLevel: RiskLevel;
  estimatedCostUsd: number | null;
  capabilities: Capability[];
  permissionEvaluations: PermissionEvaluation[];
  blockers: string[];
  requiresConfirmation: Capability[];
  createdAt: number;
}

export interface ApprovalDecisionInput {
  approved: boolean;
  reason?: string;
  approver?: string;
}

export interface ApprovalOutcome {
  approved: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Checkpoints (Phase 2)
// ---------------------------------------------------------------------------

export interface CheckpointEvidence {
  id: string;
  kind: EvidenceKind;
  description: string;
  command?: string;
  exitCode?: number;
  output?: string;
  /**
   * Unified diff an isolated task produced. It is carried on the evidence
   * because an ephemeral worktree is removed once the task finishes, which
   * would otherwise leave the proof unverifiable.
   */
  diff?: string;
  recordedAt: number;
}

export type NewCheckpointEvidence = Omit<CheckpointEvidence, 'id' | 'recordedAt'> & {
  recordedAt?: number;
};

export type CheckpointStatus = 'pending' | 'accepted' | 'rejected' | 'restored';

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  title: string;
  createdAt: number;
  status: CheckpointStatus;
  files: string[];
  baseRevision: string | null;
  diff: string;
  additions: number;
  deletions: number;
  evidence: CheckpointEvidence[];
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Workflow state machine (Phase 1/2)
// ---------------------------------------------------------------------------

export type WorkflowPhase =
  | 'idle'
  | 'exploring'
  | 'planning'
  | 'awaiting-approval'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkflowState {
  phase: WorkflowPhase;
  mode: WorkflowMode;
  contractId: string | null;
  objective: string;
  tasks: AtomicTask[];
  groups: AtomicTask[][];
  completedTaskIds: string[];
  readyTaskIds: string[];
  approval: ApprovalRequest | null;
  approvalOutcome: ApprovalOutcome | null;
  checkpoints: TaskCheckpoint[];
  blockers: string[];
  updatedAt: number;
}

export interface VerifyResult {
  ok: boolean;
  missing: string[];
  /** Structured detail (Phase 1.5): which criterion was proven by what. */
  report?: VerificationReport;
}

// ---------------------------------------------------------------------------
// Verification (Phase 1.5 / 2.4) — evidence must be *proof*, not presence
// ---------------------------------------------------------------------------

export type CriterionOutcome = 'verified' | 'failed' | 'missing-evidence' | 'not-verifiable';

export interface CriterionVerification {
  taskId: string;
  criterionId: string;
  description: string;
  /** Command or 'inspection: ...' declared on the criterion. */
  verification: string;
  required: boolean;
  outcome: CriterionOutcome;
  reason: string;
  evidenceId?: string;
}

export interface TaskVerification {
  taskId: string;
  ok: boolean;
  criteria: CriterionVerification[];
  /** Blocking reasons, already formatted for the user. */
  issues: string[];
}

export interface VerificationReport {
  ok: boolean;
  tasks: TaskVerification[];
  missing: string[];
  checkedAt: number;
}

// ---------------------------------------------------------------------------
// Execution (Phase 1.4 / 3.3) — one entry per task the executor ran
// ---------------------------------------------------------------------------

export type TaskRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'budget-exceeded'
  | 'forbidden';

export interface TaskRunResult {
  taskId: string;
  role: AgentRole;
  status: TaskRunStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  attempts: number;
  toolCalls: number;
  summary: string;
  error?: string;
  /** True when the task ran inside an ephemeral worktree. */
  isolated: boolean;
  worktreePath?: string;
  evidenceKinds: EvidenceKind[];
  /** Outcome of verifying this task's own exit criteria against its proof. */
  verification?: TaskVerification;
  costUsd?: number;
  /** Tokens the task consumed, when the runner reported usage. */
  tokens?: number;
}

export interface WorkflowExecutionReport {
  contractId: string | null;
  /** False when the execution choke point refused to start. */
  started: boolean;
  startReasons: string[];
  results: TaskRunResult[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  skippedTaskIds: string[];
  phase: WorkflowPhase;
  verification: VerificationReport | null;
}

/** Budget ceilings enforced around one task run (Phase 3.2). */
export interface TaskBudgetStatus {
  exceeded: boolean;
  reason: string | null;
  toolCalls: number;
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Adaptive roles (Phase 3)
// ---------------------------------------------------------------------------

export interface RolePlanInput {
  request: string;
  hasCodebase?: boolean;
  needsWeb?: boolean;
  multiFile?: boolean;
  riskSensitive?: boolean;
  willWrite?: boolean;
}

export interface RoleAssignment {
  role: AgentRole;
  objective: string;
  budget: TaskBudget;
  capabilities: Capability[];
  parallelizable: boolean;
}

// ---------------------------------------------------------------------------
// Project memory (Phase 4)
// ---------------------------------------------------------------------------

export type {
  MemoryInjection,
  MemoryLayer,
  MemoryProvenance,
  MemoryQuery,
  MemorySource,
  ProjectMemoryItem,
  ProjectMemoryOverview,
  ScoredMemoryItem,
  UpsertMemoryInput,
} from './project-memory-types';
export { MEMORY_LAYERS } from './project-memory-types';

// ---------------------------------------------------------------------------
// Isolation (Phase 5.3)
// ---------------------------------------------------------------------------

export interface IsolationPlan {
  taskId: string;
  mode: 'worktree' | 'sandbox' | 'none';
  workspaceRoot: string;
  worktreePath: string;
  files: string[];
  /** Ephemeral worktrees are removed once the task is settled. */
  ephemeral: boolean;
}

// ---------------------------------------------------------------------------
// Audit log (Phase 5)
// ---------------------------------------------------------------------------

export type AuditAuthorization = 'auto' | 'approved' | 'rejected' | 'forbidden' | 'not-required';

export interface AuditEntry {
  id: string;
  at: number;
  action: string;
  justification: string;
  authorization: AuditAuthorization;
  capability?: Capability;
  matchedRuleId?: string | null;
  files?: string[];
  diff?: string;
  verification?: string;
  evidenceIds?: string[];
  taskId?: string;
}

export type NewAuditEntry = Omit<AuditEntry, 'id' | 'at'> & { at?: number };
