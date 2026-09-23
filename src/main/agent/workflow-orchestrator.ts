/**
 * @module main/agent/workflow-orchestrator
 *
 * Cowork 4.0 — Phase 1/2: the Plan -> Act -> Verify state machine. It is the
 * only object allowed to move a plan from "proposed" to "executing", and it
 * refuses to start until the contract, the plan and the permissions are all
 * explicit and the user has approved.
 */

import type { AtomicTask, TaskContract, WorkflowMode } from '../../shared/task-contract';
import { WORKFLOW_MODE_CAPABILITIES } from '../../shared/task-contract';
import type {
  ApprovalDecisionInput,
  ApprovalOutcome,
  ApprovalRequest,
  VerifyResult,
  WorkflowPhase,
  WorkflowState,
} from '../../shared/workflow-types';
import {
  buildApprovalRequest,
  describeApprovalRequest,
  evaluateApproval,
} from './approval-gate';

export type { VerifyResult, WorkflowPhase, WorkflowState } from '../../shared/workflow-types';
import type {
  CheckpointManager,
  NewCheckpointEvidence,
  TaskCheckpoint,
} from './checkpoint-manager';
import type { AuditLog } from './audit-log';
import type { PermissionPolicy } from './permission-policy';
import { assertExecutablePlan, computeExecutionGroups } from './task-planner';

export interface WorkflowOrchestratorOptions {
  policy: PermissionPolicy;
  checkpoints: CheckpointManager;
  audit?: AuditLog;
  now?: () => number;
  onStateChange?: (state: WorkflowState) => void;
}

export class WorkflowOrchestrator {
  private readonly policy: PermissionPolicy;
  private readonly checkpoints: CheckpointManager;
  private readonly audit: AuditLog | undefined;
  private readonly now: () => number;
  private readonly onStateChange: ((state: WorkflowState) => void) | undefined;

  private phase: WorkflowPhase = 'idle';
  private mode: WorkflowMode = 'explore';
  private contract: TaskContract | null = null;
  private tasks: AtomicTask[] = [];
  private completedTaskIds = new Set<string>();
  private approval: ApprovalRequest | null = null;
  private approvalOutcome: ApprovalOutcome | null = null;
  private blockers: string[] = [];

  constructor(options: WorkflowOrchestratorOptions) {
    this.policy = options.policy;
    this.checkpoints = options.checkpoints;
    this.audit = options.audit;
    this.now = options.now ?? (() => Date.now());
    this.onStateChange = options.onStateChange;
  }

  /** Switch workflow mode. Leaving 'execute' immediately disables writes. */
  public setMode(mode: WorkflowMode): WorkflowState {
    this.mode = mode;
    if (mode !== 'execute' && this.phase === 'executing') {
      this.phase = 'planning';
      this.blockers = ['Execution stopped: mode switched to "' + mode + '".'];
    }
    return this.emit();
  }

  /** Load the approved-in-principle contract and its atomic task plan. */
  public loadContract(contract: TaskContract, tasks: AtomicTask[]): WorkflowState {
    this.contract = contract;
    this.tasks = tasks;
    this.completedTaskIds = new Set();
    this.approval = null;
    this.approvalOutcome = null;

    const gate = assertExecutablePlan(contract, tasks);
    this.blockers = [...gate.blockers];
    this.mode = contract.mode;
    this.phase = contract.mode === 'explore' ? 'exploring' : 'planning';

    this.audit?.append({
      action: 'workflow.load',
      justification: 'Loaded contract "' + contract.id + '" with ' + tasks.length + ' task(s).',
      authorization: 'not-required',
      capability: 'read',
      taskId: undefined,
    });

    return this.emit();
  }

  /** Build the approval payload shown to the user (Phase 1.3). */
  public requestApproval(): ApprovalRequest {
    if (!this.contract) {
      throw new Error('Cannot request approval before a contract is loaded.');
    }
    this.approval = buildApprovalRequest(this.contract, this.tasks, this.policy, {
      now: this.now,
    });
    this.approvalOutcome = null;
    this.blockers = [...this.approval.blockers];
    this.phase = 'awaiting-approval';
    this.emit();
    return this.approval;
  }

  /** Apply the user's decision. Blocked requests can never be approved. */
  public approve(input: ApprovalDecisionInput): ApprovalOutcome {
    if (!this.approval) {
      throw new Error('Cannot approve before an approval request exists.');
    }
    const outcome = evaluateApproval(this.approval, input);
    this.approvalOutcome = outcome;
    if (!outcome.approved) {
      this.phase = 'planning';
    }
    this.audit?.append({
      action: 'workflow.approval',
      justification:
        (input.reason?.trim() || (outcome.approved ? 'Approved by user.' : 'Rejected by user.')) +
        ' (' +
        describeApprovalRequest(this.approval) +
        ')',
      authorization: outcome.approved ? 'approved' : 'rejected',
      capability: 'write',
      matchedRuleId: null,
    });
    this.emit();
    return outcome;
  }

  /**
   * Phase 1.4: the single choke point. Execution starts only when the contract
   * is executable, the plan has no blocker, the mode allows writes and the user
   * approved.
   */
  public startExecution(): { started: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (!this.contract) {
      reasons.push('No contract loaded.');
    } else if (!WORKFLOW_MODE_CAPABILITIES[this.contract.mode].write) {
      reasons.push('Mode "' + this.contract.mode + '" does not allow writes.');
    } else if (this.mode !== 'execute') {
      reasons.push('Current mode is "' + this.mode + '"; switch to "execute" to apply changes.');
    }

    if (!this.approvalOutcome?.approved) {
      reasons.push('Plan has not been approved yet.');
    }
    if (this.blockers.length > 0) {
      reasons.push('Unresolved blockers: ' + this.blockers.join(' | '));
    }

    if (reasons.length > 0) {
      this.phase = 'failed';
      this.blockers = reasons;
      this.audit?.append({
        action: 'workflow.execution-blocked',
        justification: reasons.join(' | '),
        authorization: 'forbidden',
        capability: 'write',
      });
      this.emit();
      return { started: false, reasons };
    }

    this.phase = 'executing';
    this.blockers = [];
    this.audit?.append({
      action: 'workflow.execution-start',
      justification: 'Execution started for contract "' + this.contract?.id + '".',
      authorization: 'approved',
      capability: 'write',
    });
    this.emit();
    return { started: true, reasons: [] };
  }

  /**
   * Phase 3.3 — start every task that has no unmet dependency in one call. Tasks
   * flagged `parallelizable: false` (writers) are started sequentially so two
   * agents never race on the same files.
   */
  public async startReadyTasks(): Promise<{
    started: TaskCheckpoint[];
    skipped: string[];
    reasons: string[];
  }> {
    if (this.phase !== 'executing') {
      return {
        started: [],
        skipped: [],
        reasons: ['Execution has not started (phase "' + this.phase + '").'],
      };
    }

    const ready = this.tasks.filter((task) => this.readyTaskIds().includes(task.id));
    const started: TaskCheckpoint[] = [];
    const skipped: string[] = [];
    const reasons: string[] = [];
    let startedWriter = false;

    for (const task of ready) {
      const writer = !task.parallelizable;
      if (writer && startedWriter) {
        skipped.push(task.id);
        reasons.push('Task "' + task.id + '" writes to the workspace; started one at a time.');
        continue;
      }
      started.push(await this.startTask(task.id));
      if (writer) {
        startedWriter = true;
      }
    }

    return { started, skipped, reasons };
  }

  /** Tasks whose dependencies are all completed and that are still pending. */
  public readyTaskIds(): string[] {
    return this.tasks
      .filter(
        (task) =>
          !this.completedTaskIds.has(task.id) &&
          task.dependsOn.every((dependency) => this.completedTaskIds.has(dependency))
      )
      .map((task) => task.id);
  }

  /** Snapshot before the task runs, then return the checkpoint (Phase 2.1). */
  public async startTask(taskId: string): Promise<TaskCheckpoint> {
    if (this.phase !== 'executing') {
      throw new Error('Cannot start a task while workflow phase is "' + this.phase + '".');
    }
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error('Unknown task: ' + taskId);
    }
    if (!this.readyTaskIds().includes(taskId)) {
      throw new Error('Task "' + taskId + '" has unmet dependencies.');
    }
    const checkpoint = await this.checkpoints.createCheckpoint(task);
    this.emit();
    return checkpoint;
  }

  /** Mark a task done and attach its evidence to the checkpoint (Phase 2.4). */
  public async completeTask(
    taskId: string,
    evidence?: NewCheckpointEvidence[]
  ): Promise<WorkflowState> {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error('Unknown task: ' + taskId);
    }
    const checkpoint = this.checkpoints.forTask(taskId);
    if (checkpoint && evidence) {
      for (const entry of evidence) {
        this.checkpoints.attachEvidence(checkpoint.id, entry);
      }
    }
    this.completedTaskIds.add(taskId);

    if (this.completedTaskIds.size >= this.tasks.length && this.tasks.length > 0) {
      this.phase = 'verifying';
    }

    this.audit?.append({
      action: 'task.complete',
      justification: 'Task "' + taskId + '" completed.',
      authorization: 'approved',
      capability: 'write',
      evidenceIds: checkpoint?.evidence.map((entry) => entry.id),
      taskId,
    });

    return this.emit();
  }

  /** Keep the changes produced by a task (Phase 2.3). */
  public async acceptTask(taskId: string): Promise<WorkflowState> {
    const checkpoint = await this.checkpoints.acceptTask(taskId);
    this.audit?.append({
      action: 'task.accept',
      justification: 'Task "' + taskId + '" accepted; ' + checkpoint.additions + ' addition(s).',
      authorization: 'approved',
      capability: 'write',
      files: checkpoint.files,
      taskId,
    });
    return this.emit();
  }

  /** Restore a task to its checkpoint without rejecting the plan. */
  public async restoreTask(taskId: string): Promise<WorkflowState> {
    await this.checkpoints.restoreTask(taskId);
    return this.emit();
  }

  /** Reject a task: its files are restored and the workflow stops. */
  public async rejectTask(taskId: string, reason?: string): Promise<WorkflowState> {
    const checkpoint = await this.checkpoints.rejectTask(taskId, reason);
    this.completedTaskIds.delete(taskId);
    this.phase = 'failed';
    this.blockers = ['Task "' + taskId + '" rejected: ' + (checkpoint.rejectionReason ?? '')];
    return this.emit();
  }

  /** Roll the whole plan back to its checkpoints. */
  public async restorePlan(): Promise<WorkflowState> {
    const result = await this.checkpoints.restorePlan();
    this.completedTaskIds = new Set();
    this.phase = 'cancelled';
    this.blockers = ['Plan restored (' + result.restored.length + ' task(s) rolled back).'];
    return this.emit();
  }

  /**
   * Phase 1/2 verification: every completed task must have produced all of its
   * required evidence kinds. Missing proof fails verification.
   */
  public verify(): VerifyResult {
    const missing: string[] = [];
    for (const task of this.tasks) {
      if (!this.completedTaskIds.has(task.id)) {
        missing.push(task.id + ': not completed');
        continue;
      }
      const checkpoint = this.checkpoints.forTask(task.id);
      const evidence = checkpoint?.evidence ?? [];
      for (const requirement of task.requiredEvidence) {
        if (!requirement.required) {
          continue;
        }
        if (!evidence.some((entry) => entry.kind === requirement.kind)) {
          missing.push(task.id + ': missing ' + requirement.kind + ' evidence');
        }
      }
    }

    const ok = missing.length === 0;
    this.phase = ok ? 'completed' : 'failed';
    if (!ok) {
      this.blockers = missing;
    }
    this.audit?.append({
      action: 'workflow.verify',
      justification: ok ? 'All tasks verified with evidence.' : missing.join(' | '),
      authorization: ok ? 'approved' : 'rejected',
      capability: 'read',
    });
    this.emit();
    return { ok, missing };
  }

  /** The contract currently loaded, if any. */
  public getContract(): TaskContract | null {
    return this.contract;
  }

  public getState(): WorkflowState {
    return {
      phase: this.phase,
      mode: this.mode,
      contractId: this.contract?.id ?? null,
      objective: this.contract?.objective ?? '',
      tasks: this.tasks,
      groups: computeExecutionGroups(this.tasks),
      completedTaskIds: Array.from(this.completedTaskIds),
      readyTaskIds: this.readyTaskIds(),
      approval: this.approval,
      approvalOutcome: this.approvalOutcome,
      checkpoints: this.checkpoints.list(),
      blockers: [...this.blockers],
      updatedAt: this.now(),
    };
  }

  private emit(): WorkflowState {
    const state = this.getState();
    this.onStateChange?.(state);
    return state;
  }
}
