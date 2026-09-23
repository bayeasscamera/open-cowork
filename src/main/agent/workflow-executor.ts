/**
 * @module main/agent/workflow-executor
 *
 * Cowork 4.0 — Phase 1.4/3.2/3.3/5.3: the piece that actually *runs* an
 * approved plan.
 *
 * For every ready task it:
 *   1. refuses the task when the permission policy forbids a requested capability;
 *   2. creates the pre-task checkpoint (rollback stays possible);
 *   3. materialises an ephemeral git worktree when the task is risky;
 *   4. runs the task through the injected agent runner, under a budget;
 *   5. refreshes the diff, attaches the proof and closes the task;
 *   6. verifies the whole plan before declaring success.
 *
 * The LLM call itself is injected as a WorkflowTaskRunner, which keeps this
 * module deterministic and unit-testable and lets the app plug in the real
 * agent loop.
 */

import type { AtomicTask, Capability, EvidenceKind, TaskContract } from '../../shared/task-contract';
import type {
  NewCheckpointEvidence,
  TaskRunProgress,
  TaskRunResult,
  TaskRunStatus,
  TaskVerification,
  VerificationReport,
  WorkflowExecutionReport,
} from '../../shared/workflow-types';
import type { AuditLog } from './audit-log';
import { BudgetGuard, budgetIsSatisfiable } from './budget-guard';
import type { IsolationManager } from './isolation-manager';
import {
  DEFAULT_ISOLATION_POLICY,
  shouldIsolateTask,
  type IsolationPolicy,
} from './isolation-planner';
import { evaluatePermission, type PermissionPolicy } from './permission-policy';
import {
  DEFAULT_PROOF_TIMEOUT_MS,
  createShellProofRunner,
  declaredCommands,
  type ProofCommandResult,
  type ProofRunner,
} from './proof-runner';
import { MIN_INSPECTION_CHARS } from './verification';
import type { WorkflowOrchestrator } from './workflow-orchestrator';

export const DEFAULT_MAX_TASKS_PER_RUN = 50;
export const DEFAULT_TASK_ATTEMPTS = 1;
/**
 * Extra attempts granted when the agent *claimed* success but the main process
 * re-ran a declared proof command and it failed. One is enough to be useful:
 * the agent gets the exact failing command and its raw output, so a second
 * identical failure means the plan needs a human, not another model call.
 */
export const DEFAULT_PROOF_RECOVERY_ATTEMPTS = 1;
/** How much of a failing proof's output is fed back to the agent. */
export const MAX_PROOF_FEEDBACK_CHARS = 2000;
/** Minimum delay between two live progress reports for one task. */
export const TASK_PROGRESS_THROTTLE_MS = 400;

export interface WorkflowTaskContext {
  task: AtomicTask;
  contract: TaskContract;
  /** Directory the task must run in (the worktree when it is isolated). */
  cwd: string;
  prompt: string;
  isolated: boolean;
  /** Aborted when the budget is exhausted. */
  signal: AbortSignal;
  /** The runner must call this for every tool call it performs. */
  onToolCall: (count?: number) => void;
  /** The runner calls this with the tokens each model turn consumed. */
  onTokens?: (count?: number) => void;
  /** Called when a guard refuses a tool call, i.e. a human must decide. */
  onToolBlocked?: () => void;
}

export interface WorkflowTaskOutcome {
  success: boolean;
  summary: string;
  /** Proof produced by the task, attached to its checkpoint. */
  evidence?: NewCheckpointEvidence[];
  error?: string;
  toolCalls?: number;
  costUsd?: number;
  /** Tokens the run consumed, summed across model turns. */
  tokens?: number;
  /** Evidence kinds actually observed during the run (tool-level facts). */
  evidenceKinds?: EvidenceKind[];
  /** Shell commands that exited non-zero, used as a regression signal. */
  failedCommands?: number;
}

/**
 * Why the previous attempt failed, handed back to the agent so a retry is a
 * *recovery* rather than a blind repeat of the same prompt.
 */
export interface TaskFailureContext {
  /** 1-based number of the attempt that failed. */
  attempt: number;
  /** Human-readable reason, already formatted. */
  reason: string;
  /** The declared proof command the main process re-ran, when proof failed. */
  proofCommand?: string;
  /** Raw output of that command, truncated. */
  proofOutput?: string;
}

/** A declared proof command that ran and exited non-zero. */
export interface ProofFailure {
  reason: string;
  command: string;
  output: string;
}

export type WorkflowTaskRunner = (context: WorkflowTaskContext) => Promise<WorkflowTaskOutcome>;

/**
 * Run-level control for one plan execution, shared by the IPC layer (which
 * asks for a pause or a cancel) and the executor (which obeys it between
 * tasks). Cancelling aborts the task that is in flight; pausing lets it
 * finish and stops the next one from starting, so a pause can never leave a
 * half-applied write behind.
 */
export interface WorkflowRunControl {
  readonly signal: AbortSignal;
  readonly cancelled: boolean;
  readonly paused: boolean;
}

/** The writable side of a run control, owned by the registry. */
export class MutableRunControl implements WorkflowRunControl {
  private readonly controller = new AbortController();
  private cancelRequested = false;
  private pauseRequested = false;

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get cancelled(): boolean {
    return this.cancelRequested;
  }

  public get paused(): boolean {
    return this.pauseRequested;
  }

  public requestPause(): void {
    this.pauseRequested = true;
  }

  public requestCancel(): void {
    this.cancelRequested = true;
    this.controller.abort();
  }
}

export interface WorkflowExecutorOptions {
  orchestrator: WorkflowOrchestrator;
  runTask: WorkflowTaskRunner;
  policy: PermissionPolicy;
  workspaceRoot: string;
  isolation?: IsolationManager;
  isolationPolicy?: IsolationPolicy;
  audit?: AuditLog;
  now?: () => number;
  /** Hard cap on how many tasks one call may run. */
  maxTasks?: number;
  /** Attempts per task; the first attempt is always made. */
  attempts?: number;
  /**
   * Extra attempts bought by a failing declared proof (see
   * DEFAULT_PROOF_RECOVERY_ATTEMPTS). Zero disables proof recovery entirely.
   */
  proofRecoveryAttempts?: number;
  /** Re-runs every command the task declared as proof; injected for tests. */
  runProof?: ProofRunner;
  proofTimeoutMs?: number;
  onTaskResult?: (result: TaskRunResult) => void;
  /** Throttled live budget updates while a task is still running. */
  onTaskProgress?: (progress: TaskRunProgress) => void;
  /** Pause/cancel handle for the run this executor is driving. */
  control?: WorkflowRunControl;
}

/** Evidence kinds the agent's own text can satisfy. */
export const TEXT_EVIDENCE_KINDS: readonly EvidenceKind[] = ['note', 'review', 'artifact'];

const ROLE_INSTRUCTIONS: Readonly<Record<AtomicTask['role'], string>> = Object.freeze({
  scout: 'Map the smallest set of files and symbols relevant to the task. Do not write.',
  'web-researcher': 'Gather external evidence and cite every source. Do not write.',
  architect: 'Propose the minimal design and the files it touches. Do not write.',
  implementer: 'Apply the smallest change that satisfies the exit criteria.',
  tester: 'Prove the change with automated tests and paste the raw output.',
  reviewer: 'Adversarially try to falsify the change; report findings with evidence.',
  security: 'Audit the change for security regressions; cite concrete exploits.',
});

/** The prompt handed to the agent loop for one atomic task. */
export function buildTaskPrompt(
  task: AtomicTask,
  contract: TaskContract,
  failure?: TaskFailureContext
): string {
  const lines: string[] = [
    'You are the "' + task.role + '" sub-agent of an approved Cowork plan.',
    '',
    '## Plan objective',
    contract.objective,
    '',
    '## Your task',
    task.title,
    '',
    '## Role',
    ROLE_INSTRUCTIONS[task.role],
    '',
  ];

  if (task.writeScope.length > 0) {
    lines.push('## Write scope (nothing outside it)', ...task.writeScope.map((f) => '- ' + f), '');
  } else {
    lines.push('## Write scope', 'Read-only task: do not modify any file.', '');
  }

  lines.push('## Exit criteria — each one must be provable');
  if (task.exitCriteria.length === 0) {
    lines.push('- (none declared)');
  }
  for (const criterion of task.exitCriteria) {
    lines.push(
      '- [' + criterion.id + '] ' + criterion.description + ' — proof: ' + criterion.verification
    );
  }
  lines.push('');

  lines.push('## Required evidence');
  if (task.requiredEvidence.length === 0) {
    lines.push('- (none declared)');
  }
  for (const evidence of task.requiredEvidence) {
    lines.push(
      '- ' +
        evidence.kind +
        ': ' +
        evidence.description +
        (evidence.command ? ' (command: ' + evidence.command + ')' : '')
    );
  }
  lines.push('');

  const budget = task.budget;
  const budgetParts: string[] = [];
  if (budget.maxToolCalls !== undefined) {
    budgetParts.push('at most ' + budget.maxToolCalls + ' tool calls');
  }
  if (budget.maxTokens !== undefined) {
    budgetParts.push('at most ' + budget.maxTokens + ' tokens');
  }
  if (budget.maxDurationMs !== undefined) {
    budgetParts.push('at most ' + Math.round(budget.maxDurationMs / 1000) + 's');
  }
  if (budgetParts.length > 0) {
    lines.push('## Budget', budgetParts.join(', ') + '.', '');
  }

  lines.push(
    'Finish by pasting the raw output of every command you ran as proof. If a criterion',
    'cannot be proven, say so explicitly instead of claiming success.'
  );

  if (failure) {
    lines.push('', '## Previous attempt failed', failure.reason);
    if (failure.proofCommand) {
      lines.push(
        '',
        'The main process re-ran your declared proof command "' +
          failure.proofCommand +
          '" and it exited non-zero. Its raw output was:',
        '',
        truncateProofOutput(failure.proofOutput ?? ''),
        '',
        'Fix the cause of that failure. Do not repeat the same change, and do not claim',
        'success until that exact command exits 0.'
      );
    } else {
      lines.push(
        '',
        'Correct the cause of that failure instead of repeating the same approach unchanged.'
      );
    }
  }

  return lines.join('\n');
}

/** Keep the tail of a proof output: the error is almost always at the end. */
function truncateProofOutput(output: string): string {
  if (output.length <= MAX_PROOF_FEEDBACK_CHARS) {
    return output;
  }
  return '… ' + output.slice(output.length - MAX_PROOF_FEEDBACK_CHARS);
}

function baseResult(task: AtomicTask, startedAt: number): TaskRunResult {
  return {
    taskId: task.id,
    role: task.role,
    status: 'pending',
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    attempts: 0,
    toolCalls: 0,
    summary: '',
    isolated: false,
    evidenceKinds: [],
  };
}

export class WorkflowExecutor {
  private readonly options: WorkflowExecutorOptions;
  private readonly now: () => number;

  constructor(options: WorkflowExecutorOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  private taskById(taskId: string): AtomicTask | null {
    return this.options.orchestrator.getTasks().find((task) => task.id === taskId) ?? null;
  }

  /**
   * Capabilities the policy refuses outright; the task must not run at all.
   *
   * The task's own write scope gives the evaluation its subject: without a
   * path, a rule can only match on an empty subject and every capability looks
   * allowed. The workspace root is always evaluated as the task's home.
   */
  public forbiddenCapabilities(task: AtomicTask): Capability[] {
    const subjects =
      task.writeScope.length > 0 ? [...task.writeScope] : [this.options.workspaceRoot];
    const forbidden: Capability[] = [];
    for (const capability of task.requestedCapabilities) {
      for (const subject of subjects) {
        const evaluation = evaluatePermission(this.options.policy, {
          capability,
          path: subject,
          // A shell rule matches on the subject of the request, not on a title.
          command: capability === 'shell' ? subject : undefined,
        });
        if (evaluation.decision === 'forbidden') {
          forbidden.push(capability);
          break;
        }
      }
    }
    return forbidden;
  }

  private finish(
    result: TaskRunResult,
    status: TaskRunStatus,
    summary: string,
    error?: string
  ): TaskRunResult {
    const finishedAt = this.now();
    return {
      ...result,
      status,
      summary,
      finishedAt,
      durationMs: Math.max(0, finishedAt - result.startedAt),
      ...(error ? { error } : {}),
    };
  }

  /** Run one task: guard, checkpoint, isolation, agent loop, evidence, close. */
  public async runTask(task: AtomicTask): Promise<TaskRunResult> {
    const contract = this.options.orchestrator.getContract();
    const startedAt = this.now();
    const base = baseResult(task, startedAt);
    if (!contract) {
      return this.finish(base, 'failed', 'No contract loaded.', 'No contract loaded.');
    }

    const forbidden = this.forbiddenCapabilities(task);
    if (forbidden.length > 0) {
      const reason = 'Capability forbidden by policy: ' + forbidden.join(', ') + '.';
      this.options.audit?.append({
        action: 'task.forbidden',
        justification: reason,
        authorization: 'forbidden',
        capability: forbidden[0],
        taskId: task.id,
      });
      return this.finish(base, 'forbidden', reason, reason);
    }

    if (!budgetIsSatisfiable(task.budget)) {
      const reason = 'Task budget is not satisfiable.';
      return this.finish(base, 'budget-exceeded', reason, reason);
    }

    await this.options.orchestrator.startTask(task.id);

    const isolated = Boolean(
      this.options.isolation && shouldIsolateTask(task, this.isolationPolicy())
    );
    let worktreePath: string | undefined;
    let isolationError: string | undefined;
    if (isolated && this.options.isolation) {
      const plan = this.buildIsolationPlan(task);
      const created = await this.options.isolation.create(plan);
      if (created.created) {
        worktreePath = created.plan.worktreePath;
      } else {
        isolationError = created.error ?? 'worktree creation failed';
      }
    }

    const effectiveIsolated = Boolean(worktreePath);
    const cwd = worktreePath ?? this.options.workspaceRoot;
    const budget = new BudgetGuard(task.budget, { now: this.now });
    const controller = new AbortController();
    // A run-level cancel must interrupt the task that is in flight, not only
    // stop the next one from starting.
    const runControl = this.options.control;
    if (runControl) {
      if (runControl.cancelled) {
        controller.abort();
      } else {
        runControl.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }
    let progressReportedAt = 0;
    // Live visibility: the UI must see tokens and cost accrue while a long
    // task runs, not only once it ends. Throttled so a chatty runner cannot
    // flood the renderer.
    const reportProgress = (): void => {
      const at = this.now();
      if (at - progressReportedAt < TASK_PROGRESS_THROTTLE_MS) {
        return;
      }
      progressReportedAt = at;
      this.options.onTaskProgress?.({
        taskId: task.id,
        tokens: budget.tokens,
        toolCalls: budget.toolCalls,
        costUsd: budget.usage().costUsd,
        ...(typeof task.budget.maxTokens === 'number'
          ? { maxTokens: task.budget.maxTokens }
          : {}),
        updatedAt: at,
      });
    };
    const onToolCall = (count = 1): void => {
      budget.recordToolCall(count);
      reportProgress();
      if (budget.exceeded && !controller.signal.aborted) {
        controller.abort();
      }
    };
    const onTokens = (count = 1): void => {
      budget.recordTokens(count);
      reportProgress();
      if (budget.exceeded && !controller.signal.aborted) {
        controller.abort();
      }
    };

    const generalLimit = Math.max(1, this.options.attempts ?? DEFAULT_TASK_ATTEMPTS);
    const recoveryLimit = Math.max(
      0,
      this.options.proofRecoveryAttempts ?? DEFAULT_PROOF_RECOVERY_ATTEMPTS
    );
    let outcome: WorkflowTaskOutcome | null = null;
    let lastError = isolationError ?? '';
    let attempts = 0;
    let recoveries = 0;
    let failure: TaskFailureContext | undefined;
    let proofFailure: ProofFailure | undefined;
    // Ordinary failures are bounded by `generalLimit`. A failing declared proof
    // buys exactly one more attempt per recovery slot, because it is the only
    // failure that carries a concrete, actionable artefact back to the agent.
    let allowedAttempts = generalLimit;

    while (attempts < allowedAttempts) {
      if (controller.signal.aborted || budget.exceeded) {
        break;
      }
      attempts += 1;
      proofFailure = undefined;
      try {
        outcome = await this.options.runTask({
          task,
          contract,
          cwd,
          prompt: buildTaskPrompt(task, contract, failure),
          isolated: effectiveIsolated,
          signal: controller.signal,
          onToolCall,
          onTokens,
        });
        lastError = outcome.error ?? '';
      } catch (error: unknown) {
        outcome = null;
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (!outcome?.success) {
        // Nothing to prove yet: hand the failure back to the next attempt.
        failure = {
          attempt: attempts,
          reason: lastError || 'The task did not succeed.',
        };
        continue;
      }
      if (budget.exceeded) {
        break;
      }

      // The agent claims success. Prove it: the main process re-runs every
      // declared command and records the real exit code. A failing proof fails
      // the task, whatever the summary said.
      const proof = await this.runDeclaredProofs(task, cwd);
      if (!proof) {
        break;
      }
      proofFailure = proof;
      if (recoveries >= recoveryLimit) {
        break;
      }
      recoveries += 1;
      allowedAttempts += 1;
      failure = {
        attempt: attempts,
        reason: proof.reason,
        proofCommand: proof.command,
        proofOutput: proof.output,
      };
    }

    if (outcome?.toolCalls !== undefined && outcome.toolCalls > budget.toolCalls) {
      budget.recordToolCall(outcome.toolCalls - budget.toolCalls);
    }
    if (outcome?.costUsd !== undefined) {
      budget.recordCost(outcome.costUsd);
    }
    // Reconcile in case the runner reported a total without streaming it.
    if (outcome?.tokens !== undefined && outcome.tokens > budget.tokens) {
      budget.recordTokens(outcome.tokens - budget.tokens);
    }

    const evidence = await this.collectEvidence(task, outcome, effectiveIsolated, worktreePath);

    // A retry that turned a failing proof into a passing one is a recovery:
    // the plan succeeded without the user having to intervene.
    const recovered = proofFailure === undefined && outcome?.success === true && attempts > 1;

    const isolatedNote = effectiveIsolated
      ? 'Ran in ephemeral worktree ' + String(worktreePath) + '.'
      : '';

    let status: TaskRunStatus;
    let summary: string;
    let error: string | undefined;
    let verification: TaskVerification | undefined;

    // A cancelled run is not a failure of the task: it was interrupted before
    // it could prove itself, so it must not fail the plan either.
    const interrupted = runControl?.cancelled === true && outcome?.success !== true;

    const budgetReason = budget.reason();
    if (interrupted) {
      status = 'cancelled';
      summary = 'Cancelled by the user before the task could prove itself.';
      error = undefined;
    } else if (budgetReason) {
      status = 'budget-exceeded';
      summary = budgetReason;
      error = budgetReason;
      this.options.orchestrator.failTask(task.id, budgetReason);
    } else if (proofFailure) {
      status = 'failed';
      summary = proofFailure.reason;
      error = proofFailure.reason;
      this.options.orchestrator.failTask(task.id, proofFailure.reason);
    } else if (outcome?.success) {
      // Recording the evidence is not enough: the task is only accepted once
      // its own criteria verify against the collected proof.
      await this.options.orchestrator.completeTask(task.id, evidence);
      verification = this.options.orchestrator.verifyTask(task.id);
      if (verification.ok) {
        status = 'succeeded';
        summary = outcome.summary || 'Task completed.';
      } else {
        const reason = 'Unproven: ' + verification.issues.join(' | ');
        status = 'failed';
        summary = reason;
        error = reason;
        this.options.orchestrator.failTask(task.id, reason);
      }
    } else {
      status = 'failed';
      summary = lastError || 'Task did not succeed.';
      error = summary;
      this.options.orchestrator.failTask(task.id, summary);
    }

    if (effectiveIsolated && this.options.isolation) {
      await this.options.isolation.cleanup(task.id);
    }

    const result: TaskRunResult = {
      ...base,
      status,
      summary: isolatedNote ? summary + ' ' + isolatedNote : summary,
      finishedAt: this.now(),
      durationMs: Math.max(0, this.now() - startedAt),
      attempts,
      toolCalls: budget.toolCalls,
      isolated: effectiveIsolated,
      ...(recovered ? { recovered: true } : {}),
      evidenceKinds: evidence.map((entry) => entry.kind),
      ...(verification ? { verification } : {}),
      ...(error ? { error } : {}),
      ...(worktreePath ? { worktreePath } : {}),
      ...(budget.usage().costUsd > 0 ? { costUsd: budget.usage().costUsd } : {}),
      ...(budget.usage().tokens > 0 ? { tokens: budget.usage().tokens } : {}),
    };

    this.options.audit?.append({
      action: 'task.run',
      justification: result.summary,
      authorization: status === 'succeeded' ? 'approved' : 'rejected',
      capability: task.requestedCapabilities[0] ?? 'read',
      taskId: task.id,
    });

    this.options.onTaskResult?.(result);
    return result;
  }

  private isolationPolicy(): IsolationPolicy {
    return this.options.isolationPolicy ?? DEFAULT_ISOLATION_POLICY;
  }

  private buildIsolationPlan(task: AtomicTask) {
    const normalized = this.options.workspaceRoot.replace(/[\\/]+$/, '');
    const safeId = task.id.replace(/[^a-zA-Z0-9._-]/g, '-');
    return {
      taskId: task.id,
      mode: 'worktree' as const,
      workspaceRoot: this.options.workspaceRoot,
      worktreePath: normalized + '/.cowork-worktrees/' + safeId,
      files: [...task.writeScope],
      ephemeral: true as const,
    };
  }

  /**
   * Proof attached to the checkpoint: the task diff for writing tasks, plus
   * whatever the runner produced. A worktree diff is captured before cleanup.
   */
  private async collectEvidence(
    task: AtomicTask,
    outcome: WorkflowTaskOutcome | null,
    isolated: boolean,
    worktreePath: string | undefined
  ): Promise<NewCheckpointEvidence[]> {
    const evidence: NewCheckpointEvidence[] = [...(outcome?.evidence ?? [])];

    if (task.writeScope.length > 0) {
      let diff = '';
      let description = '';
      if (isolated && worktreePath && this.options.isolation) {
        // Captured before cleanup: the worktree is removed right after.
        diff = await this.options.isolation.diff(task.id);
        description = 'Diff produced inside the task worktree.';
      } else {
        const checkpoint = await this.options.orchestrator.refreshTaskCheckpoint(task.id);
        diff = checkpoint?.diff ?? '';
        description = 'Diff produced by task "' + task.id + '".';
      }
      if (diff.trim().length > 0) {
        // The diff rides on the evidence itself so verification can still see
        // it once an ephemeral worktree has been cleaned up.
        evidence.push({ kind: 'diff', description, output: diff, diff });
      }
    }

    // The agent's own output is the proof for note/review/artifact tasks
    // (scout, architect, reviewer, security). Attach it once, with content.
    const summary = outcome?.summary?.trim() ?? '';
    if (summary.length >= MIN_INSPECTION_CHARS) {
      for (const requirement of task.requiredEvidence) {
        if (!requirement.required || !TEXT_EVIDENCE_KINDS.includes(requirement.kind)) {
          continue;
        }
        if (evidence.some((entry) => entry.kind === requirement.kind)) {
          continue;
        }
        evidence.push({
          kind: requirement.kind,
          description: 'Agent output for task "' + task.id + '".',
          output: summary,
        });
      }
    }

    return evidence;
  }

  /** Re-run every declared proof command; returns the first failure, if any. */
  private async runDeclaredProofs(
    task: AtomicTask,
    cwd: string
  ): Promise<ProofFailure | undefined> {
    const commands = declaredCommands(task);
    if (commands.length === 0) {
      return undefined;
    }
    const runner = this.options.runProof ?? createShellProofRunner();
    const timeoutMs = this.options.proofTimeoutMs ?? DEFAULT_PROOF_TIMEOUT_MS;

    for (const command of commands) {
      let result: ProofCommandResult;
      try {
        result = await runner(command, cwd, timeoutMs);
      } catch (error: unknown) {
        result = {
          exitCode: 1,
          output: error instanceof Error ? error.message : String(error),
          timedOut: false,
        };
      }
      this.options.orchestrator.recordEvidence(task.id, {
        kind: result.exitCode === 0 ? 'test' : 'command',
        description: 'Ran "' + command + '" (exit ' + result.exitCode + ').',
        command,
        exitCode: result.exitCode,
        output: result.output,
      });
      if (result.exitCode !== 0) {
        return {
          reason:
            'Proof command "' +
            command +
            '" exited with code ' +
            result.exitCode +
            (result.timedOut ? ' (timed out)' : '') +
            '.',
          command,
          output: result.output,
        };
      }
    }
    return undefined;
  }

  /**
   * Run every task that is ready right now. One pass, dependencies respected.
   *
   * A freshly approved plan is still in "planning": the UI's "run ready tasks"
   * action is the first execution step, so start the plan here rather than
   * silently returning an empty list.
   */
  public async executeReadyTasks(): Promise<TaskRunResult[]> {
    if (this.options.orchestrator.getPhase() !== 'executing') {
      const start = this.options.orchestrator.startExecution();
      if (!start.started) {
        return [];
      }
    }
    const results: TaskRunResult[] = [];
    for (const taskId of this.options.orchestrator.readyTaskIds()) {
      if (this.options.control?.cancelled || this.options.control?.paused) {
        break;
      }
      const task = this.taskById(taskId);
      if (!task) {
        continue;
      }
      const result = await this.runTask(task);
      results.push(result);
      if (result.status !== 'succeeded') {
        break;
      }
    }
    this.applyRunControl();
    return results;
  }

  /**
   * Translate a pending pause/cancel into a final phase once the loop stopped.
   * Cancel wins over pause, and neither may be overwritten by verification.
   */
  private applyRunControl(): void {
    const control = this.options.control;
    if (control?.cancelled) {
      this.options.orchestrator.cancel();
    } else if (control?.paused) {
      this.options.orchestrator.pause();
    }
  }

  /**
   * Start execution, run the plan to completion in dependency order, then
   * verify. Stops at the first failing task so a broken plan never cascades.
   */
  public async executePlan(): Promise<WorkflowExecutionReport> {
    const start = this.options.orchestrator.startExecution();
    if (!start.started) {
      return this.buildReport(false, start.reasons, [], null);
    }
    const maxTasks = Math.max(1, this.options.maxTasks ?? DEFAULT_MAX_TASKS_PER_RUN);
    const results: TaskRunResult[] = [];
    let ran = 0;

    while (
      ran < maxTasks &&
      this.options.orchestrator.getPhase() === 'executing' &&
      !this.options.control?.cancelled &&
      !this.options.control?.paused
    ) {
      const ready = this.options.orchestrator.readyTaskIds();
      if (ready.length === 0) {
        break;
      }
      let progressed = false;
      for (const taskId of ready) {
        if (ran >= maxTasks) {
          break;
        }
        if (this.options.control?.cancelled || this.options.control?.paused) {
          break;
        }
        const task = this.taskById(taskId);
        if (!task) {
          continue;
        }
        const result = await this.runTask(task);
        results.push(result);
        ran += 1;
        progressed = true;
        if (result.status !== 'succeeded') {
          break;
        }
      }
      if (!progressed) {
        break;
      }
    }

    this.applyRunControl();
    // A paused or cancelled run must not be verified: verification would
    // overwrite the phase and claim the plan completed.
    const stopped =
      this.options.control?.cancelled === true || this.options.control?.paused === true;
    const verification = stopped
      ? null
      : (this.options.orchestrator.verify().report ?? null);
    return this.buildReport(true, [], results, verification);
  }

  private buildReport(
    started: boolean,
    startReasons: string[],
    results: TaskRunResult[],
    verification: VerificationReport | null
  ): WorkflowExecutionReport {
    const state = this.options.orchestrator.getState();
    return {
      contractId: state.contractId,
      started,
      startReasons,
      results,
      completedTaskIds: state.completedTaskIds,
      failedTaskIds: Array.from(
        new Set(
          results
            .filter((result) => result.status === 'failed' || result.status === 'budget-exceeded')
            .map((result) => result.taskId)
        )
      ),
      skippedTaskIds: Array.from(
        new Set(
          results
            .filter(
              (result) =>
                result.status === 'forbidden' ||
                result.status === 'skipped' ||
                result.status === 'cancelled'
            )
            .map((result) => result.taskId)
        )
      ),
      phase: state.phase,
      verification,
    };
  }
}

/** Evidence kinds a runner is allowed to attach, exported for validation. */
export const RUNNER_EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'test',
  'command',
  'diff',
  'artifact',
  'review',
  'note',
];
