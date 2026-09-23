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
  TaskVerification,
  VerificationReport,
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
import { assertExecutablePlan, planConflictFreeGroups } from './task-planner';
import { overlappingScopePaths, writeScopesOverlap } from '../../shared/write-scope-conflicts';
import { verifyContractCriteria, verifyPlan, verifyTask } from './verification';

/** Everything the orchestrator needs to survive a restart (Phase 1.6). */
export interface WorkflowOrchestratorSnapshot {
  phase: WorkflowPhase;
  mode: WorkflowMode;
  contract: TaskContract | null;
  tasks: AtomicTask[];
  completedTaskIds: string[];
  approval: ApprovalRequest | null;
  approvalOutcome: ApprovalOutcome | null;
  blockers: string[];
}

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
   * Phase 3.3 — start every task that has no unmet dependency in one call.
   *
   * A task is deferred when it is flagged `parallelizable: false` and a writer
   * already started, or when its write scope provably overlaps an already
   * started task (Lot D). The scope check is the real guarantee: the boolean
   * alone ignored the paths, so two tasks that both declared `src/a.ts` could
   * be started together and the last writer would silently win.
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
    const startedTasks: AtomicTask[] = [];
    let startedWriter = false;

    for (const task of ready) {
      // Two writers must never race on the same file. The boolean flag below
      // only knows "this task writes"; it cannot tell whether the paths
      // collide, so an explicit scope comparison runs first.
      const overlap =
        task.writeScope.length > 0
          ? startedTasks.find(
              (candidate) =>
                candidate.writeScope.length > 0 &&
                writeScopesOverlap(task.writeScope, candidate.writeScope)
            )
          : undefined;
      if (overlap) {
        skipped.push(task.id);
        reasons.push(
          'Task "' +
            task.id +
            '" overlaps task "' +
            overlap.id +
            '" on ' +
            overlappingScopePaths(task.writeScope, overlap.writeScope).join(', ') +
            '; started one at a time.'
        );
        continue;
      }

      const writer = !task.parallelizable;
      if (writer && startedWriter) {
        skipped.push(task.id);
        reasons.push('Task "' + task.id + '" writes to the workspace; started one at a time.');
        continue;
      }
      started.push(await this.startTask(task.id));
      startedTasks.push(task);
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

  /** Recompute a task checkpoint diff after the task ran (Phase 2.2). */
  public async refreshTaskCheckpoint(taskId: string): Promise<TaskCheckpoint | null> {
    const checkpoint = this.checkpoints.forTask(taskId);
    if (!checkpoint) {
      return null;
    }
    return this.checkpoints.refreshDiff(checkpoint.id);
  }

  /**
   * Attach one piece of proof to a task checkpoint. The executor uses this to
   * record the real exit code of a re-run proof command, which must be visible
   * even when the task ultimately fails.
   */
  public recordEvidence(taskId: string, evidence: NewCheckpointEvidence): void {
    const checkpoint = this.checkpoints.forTask(taskId);
    if (!checkpoint) {
      return;
    }
    this.checkpoints.attachEvidence(checkpoint.id, evidence);
    this.emit();
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

  /**
   * Stop starting new tasks. The task currently running is allowed to finish,
   * so a pause never leaves a half-applied write behind. Resume with
   * `startExecution()`: completed tasks are remembered, so the run continues
   * where it stopped instead of replaying work.
   */
  public pause(reason = 'Execution paused by the user.'): WorkflowState {
    if (this.phase !== 'executing' && this.phase !== 'verifying') {
      return this.getState();
    }
    this.phase = 'paused';
    this.audit?.append({
      action: 'workflow.execution-paused',
      justification: reason,
      authorization: 'approved',
      capability: 'write',
    });
    return this.emit();
  }

  /**
   * Stop the run for good. The reason is recorded as a blocker so the UI and
   * the audit trail show why nothing else ran; a new approval is required
   * before any further write.
   */
  public cancel(reason = 'Execution cancelled by the user.'): WorkflowState {
    if (this.phase === 'completed' || this.phase === 'failed' || this.phase === 'cancelled') {
      return this.getState();
    }
    this.phase = 'cancelled';
    this.blockers = [reason];
    this.audit?.append({
      action: 'workflow.execution-cancelled',
      justification: reason,
      authorization: 'rejected',
      capability: 'write',
    });
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
   * Phase 1.5/2.4 verification: every completed task must have *proven* its
   * required exit criteria. Evidence that merely exists (a command that failed,
   * an inspection with no body) does not pass.
   */
  public verify(): VerifyResult {
    const report = this.buildVerificationReport();
    const { ok, missing } = report;
    this.phase = ok ? 'completed' : 'failed';
    if (!ok) {
      this.blockers = [...missing];
    }
    this.audit?.append({
      action: 'workflow.verify',
      justification: ok ? 'All tasks verified with proof.' : missing.join(' | '),
      authorization: ok ? 'approved' : 'rejected',
      capability: 'read',
    });
    this.emit();
    return { ok, missing, report };
  }

  /** Verify one task without changing the workflow phase. */
  public verifyTask(taskId: string): TaskVerification {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error('Unknown task: ' + taskId);
    }
    return verifyTask({
      task,
      completed: this.completedTaskIds.has(taskId),
      checkpoint: this.checkpoints.forTask(taskId),
    });
  }

  /** Full verification report, used by the executor before it declares success. */
  public buildVerificationReport(): VerificationReport {
    const inputs = this.tasks.map((task) => ({
      task,
      completed: this.completedTaskIds.has(task.id),
      checkpoint: this.checkpoints.forTask(task.id),
    }));
    const report = verifyPlan(inputs, this.now());
    // Independent, plan-level verification: the contract's own acceptance
    // criteria must be proven by some task, not only each task's private ones.
    const contract = verifyContractCriteria(this.contract, inputs);
    const missing = Array.from(new Set([...report.missing, ...contract.missing]));
    return {
      ...report,
      ok: missing.length === 0,
      missing,
      contractCriteria: contract.criteria,
    };
  }

  /** Record a task that ran but did not succeed; the checkpoint is kept. */
  public failTask(taskId: string, reason: string): WorkflowState {
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new Error('Unknown task: ' + taskId);
    }
    this.completedTaskIds.delete(taskId);
    this.phase = 'failed';
    this.blockers = ['Task "' + taskId + '" failed: ' + reason];
    this.audit?.append({
      action: 'task.failed',
      justification: reason,
      authorization: 'rejected',
      capability: 'write',
      taskId,
    });
    return this.emit();
  }

  /** The contract currently loaded, if any. */
  public getContract(): TaskContract | null {
    return this.contract;
  }

  /** A copy of the loaded plan. */
  public getTasks(): AtomicTask[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  public getPhase(): WorkflowPhase {
    return this.phase;
  }

  /** Snapshot the state machine for persistence. */
  public serialize(): WorkflowOrchestratorSnapshot {
    return {
      phase: this.phase,
      mode: this.mode,
      contract: this.contract ? { ...this.contract } : null,
      tasks: this.tasks.map((task) => ({ ...task })),
      completedTaskIds: Array.from(this.completedTaskIds),
      approval: this.approval ? { ...this.approval } : null,
      approvalOutcome: this.approvalOutcome ? { ...this.approvalOutcome } : null,
      blockers: [...this.blockers],
    };
  }

  /**
   * Restore a snapshot after a restart. A plan that was mid-execution comes back
   * as 'planning' so the human re-confirms before any write resumes.
   */
  public restore(snapshot: WorkflowOrchestratorSnapshot | null): boolean {
    if (!snapshot || !Array.isArray(snapshot.tasks)) {
      return false;
    }
    this.contract = snapshot.contract ?? null;
    this.tasks = snapshot.tasks.map((task) => ({ ...task }));
    this.completedTaskIds = new Set(
      Array.isArray(snapshot.completedTaskIds) ? snapshot.completedTaskIds : []
    );
    this.approval = snapshot.approval ?? null;
    this.approvalOutcome = snapshot.approvalOutcome ?? null;
    this.mode = snapshot.mode ?? this.mode;
    const restoredPhase = snapshot.phase ?? 'idle';
    this.phase = restoredPhase === 'executing' || restoredPhase === 'verifying' ? 'planning' : restoredPhase;
    this.blockers = Array.isArray(snapshot.blockers) ? [...snapshot.blockers] : [];
    if (restoredPhase === 'executing' || restoredPhase === 'verifying') {
      this.blockers.push(
        'Execution was interrupted by a restart; re-approve the plan to resume.'
      );
    }
    this.emit();
    return true;
  }

  public getMode(): WorkflowMode {
    return this.mode;
  }

  public getState(): WorkflowState {
    const grouping = planConflictFreeGroups(this.tasks);
    return {
      phase: this.phase,
      mode: this.mode,
      contractId: this.contract?.id ?? null,
      objective: this.contract?.objective ?? '',
      tasks: this.tasks,
      groups: grouping.groups,
      writeConflicts: grouping.conflicts,
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
