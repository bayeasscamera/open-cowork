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
