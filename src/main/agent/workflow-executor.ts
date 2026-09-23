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

export type WorkflowTaskRunner = (context: WorkflowTaskContext) => Promise<WorkflowTaskOutcome>;

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
  /** Re-runs every command the task declared as proof; injected for tests. */
  runProof?: ProofRunner;
  proofTimeoutMs?: number;
  onTaskResult?: (result: TaskRunResult) => void;
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
export function buildTaskPrompt(task: AtomicTask, contract: TaskContract): string {
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

  return lines.join('\n');
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
    const prompt = buildTaskPrompt(task, contract);
    const budget = new BudgetGuard(task.budget, { now: this.now });
    const controller = new AbortController();
    const onToolCall = (count = 1): void => {
      budget.recordToolCall(count);
      if (budget.exceeded && !controller.signal.aborted) {
        controller.abort();
      }
    };
    const onTokens = (count = 1): void => {
      budget.recordTokens(count);
      if (budget.exceeded && !controller.signal.aborted) {
        controller.abort();
      }
    };

    const maxAttempts = Math.max(1, this.options.attempts ?? DEFAULT_TASK_ATTEMPTS);
    let outcome: WorkflowTaskOutcome | null = null;
    let lastError = isolationError ?? '';
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      if (controller.signal.aborted || budget.exceeded) {
        break;
      }
      try {
        outcome = await this.options.runTask({
          task,
          contract,
          cwd,
          prompt,
          isolated: effectiveIsolated,
          signal: controller.signal,
          onToolCall,
          onTokens,
        });
        lastError = outcome.error ?? '';
        if (outcome.success) {
          break;
        }
      } catch (error: unknown) {
        outcome = null;
        lastError = error instanceof Error ? error.message : String(error);
      }
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

    // Independent proof: the main process re-runs every declared command and
    // records the real exit code. A failing proof fails the task, whatever the
    // agent claimed in its summary.
    let proofFailure: string | undefined;
    if (outcome?.success && !budget.exceeded) {
      proofFailure = await this.runDeclaredProofs(task, cwd);
    }

    const isolatedNote = effectiveIsolated
      ? 'Ran in ephemeral worktree ' + String(worktreePath) + '.'
      : '';

    let status: TaskRunStatus;
    let summary: string;
    let error: string | undefined;
    let verification: TaskVerification | undefined;

    const budgetReason = budget.reason();
    if (budgetReason) {
      status = 'budget-exceeded';
      summary = budgetReason;
      error = budgetReason;
      this.options.orchestrator.failTask(task.id, budgetReason);
    } else if (proofFailure) {
      status = 'failed';
      summary = proofFailure;
      error = proofFailure;
      this.options.orchestrator.failTask(task.id, proofFailure);
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

  /** Re-run every declared proof command; returns the first failure reason. */
  private async runDeclaredProofs(task: AtomicTask, cwd: string): Promise<string | undefined> {
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
        return (
          'Proof command "' +
          command +
          '" exited with code ' +
          result.exitCode +
          (result.timedOut ? ' (timed out)' : '') +
          '.'
        );
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
    return results;
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

    while (ran < maxTasks && this.options.orchestrator.getPhase() === 'executing') {
      const ready = this.options.orchestrator.readyTaskIds();
      if (ready.length === 0) {
        break;
      }
      let progressed = false;
      for (const taskId of ready) {
        if (ran >= maxTasks) {
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

    const verification: VerificationReport | null = this.options.orchestrator.verify().report ?? null;
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
            .filter((result) => result.status === 'forbidden' || result.status === 'skipped')
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
