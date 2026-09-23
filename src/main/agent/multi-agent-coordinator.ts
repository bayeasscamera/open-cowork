/**
 * @module main/agent/multi-agent-coordinator
 * v4.0: Collaborative Local Multi-Agent Orchestrator (Cowork Swarm)
 *
 * Coordinates specialized sub-agents (Architect, Developer, Reviewer, Security)
 * across an asynchronous Directed Acyclic Graph (DAG).
 */

import { EventEmitter } from 'events';
import { log, logError } from '../utils/logger';
import { getCodeGraphIndexer } from '../memory/codegraph-indexer';
import { markTaskCriticality } from './swarm-criticality';
import type { TeammateExchange } from './teammate-bus';
import {
  CROSS_VERIFICATION_COST,
  buildCodeReviewResult,
  buildDeveloperReviewRerunContext,
  buildPeerChallengePrompt,
  buildPeerCrossCheckResult,
  buildSubstantiveReviewInstruction,
  parseCrossCheckResponse,
  parseReviewerFinding,
  type CrossVerificationResult,
} from './cross-verification';

export type AgentRole = 'architect' | 'developer' | 'reviewer' | 'security';

export interface AgentTask {
  id: string;
  role: AgentRole;
  title: string;
  prompt: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  result?: string;
  error?: string;
  dependsOn?: string[];
  assignedModel?: string;
  startedAt?: number;
  completedAt?: number;
  /** Files the sub-agent actually modified (reported by the runner). */
  modifiedFiles?: string[];
  /** Model label the task actually ran on. */
  modelUsed?: string;
  /** Syntax issues found in the task's modified files (post-task verification). */
  syntaxIssues?: string[];
  /** True when the task fell back to the active profile after a model failure. */
  usedFallback?: boolean;
  /** Cumulative token usage of the task's session(s), when reported. */
  tokenUsage?: { input: number; output: number };
  /** Hierarchy depth: 0 for the main agent's direct sub-agents (hard cap 2). */
  depth?: number;
  /**
   * Structural criticality: true when at least one other task depends on this
   * one (directly or transitively), so its failure blocks downstream work.
   * Drives the dynamic strong/economical model selection.
   */
  criticalPath?: boolean;
  /** True when the task was retried once under 'retry-failed-only'. */
  retried?: boolean;
  /** True when a retry recovered a previously failed task. */
  recovered?: boolean;
  /**
   * OPT-IN team mode: this task may ask ONE of its teammates a blocking
   * question through the `ask_teammate` tool. Off by default, independent of
   * cross-verification.
   */
  teamMode?: boolean;
  /** Shared bus id for the task's team (the plan id when team mode is on). */
  teamId?: string;
  /** Traced teammate questions this task asked, with their measured cost. */
  teammateExchanges?: TeammateExchange[];
}

export interface MultiAgentPlan {
  id: string;
  goal: string;
  tasks: AgentTask[];
  status: 'planning' | 'executing' | 'done' | 'failed';
  createdAt: number;
  updatedAt: number;
  /**
   * OPT-IN cross-verification ("debate"). Disabled by default: it adds model
   * calls on top of an already expensive swarm (~12-13x a solo run), so it is
   * reserved for high-stakes tasks. See cross-verification.ts.
   */
  crossVerification?: boolean;
  /** Cross-verification outcomes (peer challenge, code review, research). */
  crossVerificationResults?: CrossVerificationResult[];
  /**
   * OPT-IN team mode (default false): sub-agents may ask a teammate a blocking
   * question (hard cap 2 per task, 30s deadline). Independent of
   * cross-verification and never enabled on a standard swarm.
   */
  teamMode?: boolean;
  /** Explicit policy applied when some tasks fail. Defaults to 'fail-all'. */
  aggregationPolicy: AggregationPolicy;
  /** Outcome counts computed at the end of executePlan(). */
  aggregation?: PlanAggregation;
}

/**
 * How a partially failed swarm is aggregated into a final plan status.
 *  - 'fail-all' (default): any unresolved failure or skip fails the plan.
 *  - 'partial-ok': done when at least one task completed; failures/skips are
 *    reported but do not fail the plan.
 *  - 'retry-failed-only': retry each failed task once, then apply 'fail-all'.
 */
export type AggregationPolicy = 'fail-all' | 'partial-ok' | 'retry-failed-only';

/** Explicit, machine-readable outcome of one plan aggregation. */
export interface PlanAggregation {
  policy: AggregationPolicy;
  completed: number;
  failed: number;
  skipped: number;
  retried: number;
  recovered: number;
}

export type SubAgentRunnerFn = (task: AgentTask, context: string) => Promise<SubAgentRunResult>;

/** Result of a sub-agent run: free text plus the files the agent modified. */
export interface SubAgentRunResult {
  output: string;
  modifiedFiles?: string[];
  /** True when the configured sub-agent model failed and the active profile was used instead. */
  usedFallback?: boolean;
  /** Model label actually used — post-run visibility of what each task ran on. */
  modelUsed?: string;
  /** Syntax diagnostics from post-task verification, if any survived. */
  syntaxIssues?: string[];
  /** Cumulative token usage across the run (including any corrective re-run). */
  tokenUsage?: { input: number; output: number };
  /** Teammate questions asked by this task (team mode only), with their cost. */
  teammateExchanges?: TeammateExchange[];
}

/** Maximum upstream context each dependent sub-agent receives. */
const MAX_DEP_CONTEXT_CHARS = 4000;

/** Keep the most informative head of the upstream context, with a marker. */
function capDependencyContext(context: string): string {
  if (context.length <= MAX_DEP_CONTEXT_CHARS) return context;
  return (
    context.slice(0, MAX_DEP_CONTEXT_CHARS) +
    '\n\n… [upstream context truncated to the first ' +
    MAX_DEP_CONTEXT_CHARS +
    ' characters to save tokens]'
  );
}

export class MultiAgentCoordinator extends EventEmitter {
  private activePlans: Map<string, MultiAgentPlan> = new Map();
  private runnerFn?: SubAgentRunnerFn;

  constructor(runnerFn?: SubAgentRunnerFn) {
    super();
    this.runnerFn = runnerFn;
  }

  setRunner(runnerFn: SubAgentRunnerFn): void {
    this.runnerFn = runnerFn;
  }

  /**
   * Create an optimized DAG task plan for a user goal.
   *
   * @param options.crossVerification OPT-IN: after the parallel reviewer and
   * security reports exist, make each challenge the other, and let the
   * reviewer raise a substantive (non-syntax) point that triggers ONE targeted
   * developer re-run. Off by default — it costs extra model calls.
   */
  public createCollaborativePlan(
    goal: string,
    options?: {
      crossVerification?: boolean;
      aggregationPolicy?: AggregationPolicy;
      /** OPT-IN team mode (default false): enable the `ask_teammate` tool. */
      teamMode?: boolean;
    }
  ): MultiAgentPlan {
    const crossVerification = options?.crossVerification === true;
    const teamMode = options?.teamMode === true;
    const aggregationPolicy = options?.aggregationPolicy ?? 'fail-all';
    const planId = `swarm-${Date.now()}`;
    const tasks: AgentTask[] = [
      {
        id: `${planId}-task-1`,
        role: 'architect',
        title: 'Architecture & Contrats Techniques',
        prompt: `Analyser les contraintes techniques, définir l'architecture cible et le découpage pour: ${goal}`,
        status: 'pending',
      },
      {
        id: `${planId}-task-2`,
        role: 'developer',
        title: 'Implémentation des modules',
        prompt: `Appliquer les modifications de code et les fonctionnalités demandées`,
        status: 'pending',
        dependsOn: [`${planId}-task-1`],
      },
      {
        id: `${planId}-task-3`,
        role: 'reviewer',
        title: 'Revue qualité & Tests unitaires',
        prompt:
          `Lancer la suite de tests, inspecter les régressions et valider l'exécution` +
          (crossVerification ? buildSubstantiveReviewInstruction() : ''),
        status: 'pending',
        dependsOn: [`${planId}-task-2`],
      },
      {
        id: `${planId}-task-4`,
        role: 'security',
        title: 'Audit de sécurité & Robustesse',
        prompt: `Vérifier l'absence d'injection, fuite d'API keys ou chemins non confinés`,
        status: 'pending',
        dependsOn: [`${planId}-task-2`],
      },
    ];

    // Stamp the structural critical path before execution so the model
    // selector can pick a strong vs economical profile per task.
    markTaskCriticality(tasks);

    const plan: MultiAgentPlan = {
      id: planId,
      goal,
      tasks,
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      crossVerification,
      ...(teamMode ? { teamMode: true } : {}),
      aggregationPolicy,
    };

    // Team mode stamps a shared bus id on every task so the swarm runner can
    // register each sub-agent as an answerable teammate for this one plan.
    if (teamMode) {
      for (const task of tasks) {
        task.teamMode = true;
        task.teamId = planId;
      }
    }

    this.activePlans.set(planId, plan);
    this.emit('plan:created', plan);
    return plan;
  }

  /**
   * Execute all ready tasks in parallel adhering to the dependency DAG, then
   * aggregate the outcome according to the plan's explicit policy.
   *
   * Aggregation policies (see AggregationPolicy):
   *  - 'fail-all' (default): any unresolved failure or skip fails the plan.
   *  - 'partial-ok': the plan is done when at least one task completed; every
   *    failure/skip is still recorded and surfaced, never silently dropped.
   *  - 'retry-failed-only': retry each failed task ONCE, then apply 'fail-all'.
   *
   * Tasks blocked by a failed/skipped dependency are explicitly marked
   * `skipped` instead of being left `pending` forever — the silent partial
   * failure this policy was introduced to eliminate.
   */
  public async executePlan(planId: string): Promise<MultiAgentPlan> {
    const plan = this.activePlans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    plan.status = 'executing';
    plan.updatedAt = Date.now();
    this.emit('plan:updated', plan);

    await this.runDag(plan);

    if (plan.aggregationPolicy === 'retry-failed-only') {
      // One recovery round: retry the failed tasks, re-open the dependents they
      // had blocked, and run the DAG again. Newly failed tasks are NOT retried
      // a second time — the whole policy stays bounded to one retry per task.
      await this.retryFailedTasks(plan);
      this.reopenRecoveredDependents(plan);
      await this.runDag(plan);
    }

    // OPT-IN cross-verification phase — runs AFTER the DAG (and any retry), so
    // the reviewer and security reports already exist and can be confronted.
    // Never on the default path: it costs extra model calls (see
    // CROSS_VERIFICATION_COST).
    if (plan.crossVerification && this.runnerFn) {
      try {
        plan.crossVerificationResults = await this.runCrossVerification(plan);
      } catch (err) {
        // Cross-verification is an enhancement: a failure must not fail the
        // plan whose real work already completed.
        logError('[MultiAgentCoordinator] Cross-verification phase failed:', err);
      }
    }

    plan.aggregation = this.summarizeAggregation(plan);
    plan.status = this.resolveAggregatedStatus(plan, plan.aggregation);
    plan.updatedAt = Date.now();
    this.emit('plan:completed', plan);
    return plan;
  }

  /**
   * Run the DAG to quiescence: every ready task concurrently, then mark the
   * tasks that can never become ready as skipped. A genuine cycle (nothing
   * becomes ready and nothing can be marked) ends the loop instead of hanging.
   */
  private async runDag(plan: MultiAgentPlan): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const readyTasks = this.getReadyTasks(plan);
      if (readyTasks.length === 0) {
        const stillPending = plan.tasks.some((task) => task.status === 'pending');
        if (!stillPending) break;
        // Pending tasks can no longer become ready: an upstream dependency
        // failed or was skipped. Mark them skipped; a genuine deadlock (cycle
        // or self-reference) marks nothing and ends the loop.
        if (this.markBlockedTasksSkipped(plan) === 0) break;
        continue;
      }

      // Execute ready tasks concurrently
      await Promise.all(readyTasks.map((task) => this.runTask(plan, task)));
    }

    this.markBlockedTasksSkipped(plan);
  }

  /**
   * After a successful retry, put back the tasks that were skipped only
   * because their dependency had failed, so the DAG can finish the work the
   * retry unblocked. Tasks whose dependencies are still not completed stay
   * skipped.
   */
  private reopenRecoveredDependents(plan: MultiAgentPlan): void {
    for (const task of plan.tasks) {
      if (task.status !== 'skipped') continue;
      const deps = task.dependsOn ?? [];
      if (deps.length === 0) continue;
      const allCompleted = deps.every(
        (depId) => plan.tasks.find((t) => t.id === depId)?.status === 'completed'
      );
      if (!allCompleted) continue;
      task.status = 'pending';
      task.error = undefined;
      task.completedAt = undefined;
    }
  }

  /** Pending tasks whose dependencies have all completed. */
  private getReadyTasks(plan: MultiAgentPlan): AgentTask[] {
    return plan.tasks.filter((task) => {
      if (task.status !== 'pending') return false;
      const deps = task.dependsOn ?? [];
      if (deps.length === 0) return true;
      return deps.every((depId) => plan.tasks.find((t) => t.id === depId)?.status === 'completed');
    });
  }

  /** Run one task and fold its outcome into the plan (never throws). */
  private async runTask(plan: MultiAgentPlan, task: AgentTask): Promise<void> {
    task.status = 'in_progress';
    task.startedAt = Date.now();
    this.emit('task:started', { planId: plan.id, task });

    try {
      // Each dependent task receives the full aggregate of its dependencies —
      // reviewer AND security both get a copy — capped to keep token cost
      // bounded for long upstream outputs.
      const depContext = capDependencyContext(this.buildDependencyContext(plan, task));
      const run = await this.invokeRunner(task, depContext);

      this.applyTaskSuccess(task, run);
      this.emit('task:completed', {
        planId: plan.id,
        task,
        modifiedFiles: task.modifiedFiles,
        usedFallback: task.usedFallback,
        modelUsed: task.modelUsed,
        syntaxIssues: task.syntaxIssues,
      });
      // Files a sub-agent changed are no longer fresh in the codegraph index:
      // invalidate exactly those entries instead of rescanning the workspace.
      this.invalidateModifiedFiles(task.modifiedFiles ?? []);
    } catch (err) {
      task.status = 'failed';
      task.error = err instanceof Error ? err.message : String(err);
      this.emit('task:failed', { planId: plan.id, task });
      logError(`[MultiAgentCoordinator] Task ${task.id} failed:`, err);
    }
  }

  /** Simulated execution when no runner is configured (tests / fallback). */
  private async invokeRunner(task: AgentTask, context: string): Promise<SubAgentRunResult> {
    if (!this.runnerFn) {
      return { output: `Output for ${task.title} verified.` };
    }
    return this.runnerFn(task, context);
  }

  /** Copy a successful runner result onto the task. */
  private applyTaskSuccess(task: AgentTask, run: SubAgentRunResult): void {
    task.status = 'completed';
    task.result = run.output;
    task.completedAt = Date.now();
    task.modifiedFiles = run.modifiedFiles ?? [];
    task.usedFallback = run.usedFallback;
    task.modelUsed = run.modelUsed;
    task.syntaxIssues = run.syntaxIssues;
    task.tokenUsage = run.tokenUsage;
    // Accumulate teammate exchanges across a retry rather than overwriting
    // them: a question that was actually asked was actually paid for.
    if (run.teammateExchanges?.length) {
      task.teammateExchanges = [...(task.teammateExchanges ?? []), ...run.teammateExchanges];
    }
    task.error = undefined;
    if (run.modelUsed) {
      log(
        `[MultiAgentCoordinator] Task ${task.role} (${task.id}) completed on model "${run.modelUsed}"` +
          (run.usedFallback ? ' — via fallback' : '')
      );
    }
  }

  /** Upstream results handed to a dependent task, formatted for the prompt. */
  private buildDependencyContext(plan: MultiAgentPlan, task: AgentTask): string {
    return (task.dependsOn ?? [])
      .map((depId) => {
        const dep = plan.tasks.find((t) => t.id === depId);
        return `### [${dep?.role.toUpperCase()}] ${dep?.title}\n${dep?.result || ''}`;
      })
      .join('\n\n');
  }

  /**
   * Mark every pending task blocked by a failed/skipped (or unknown)
   * dependency as `skipped`, transitively. Returns how many were marked so the
   * caller can distinguish a recoverable block from a true cycle deadlock.
   */
  private markBlockedTasksSkipped(plan: MultiAgentPlan): number {
    let marked = 0;
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of plan.tasks) {
        if (task.status !== 'pending') continue;
        const deps = task.dependsOn ?? [];
        if (deps.length === 0) continue;
        const blocker = deps.find((depId) => {
          const dep = plan.tasks.find((t) => t.id === depId);
          return !dep || dep.status === 'failed' || dep.status === 'skipped';
        });
        if (!blocker) continue;
        task.status = 'skipped';
        task.error = `Skipped: upstream task ${blocker} did not complete`;
        task.completedAt = Date.now();
        this.emit('task:skipped', { planId: plan.id, task });
        marked++;
        changed = true;
      }
    }
    return marked;
  }

  /**
   * Retry each failed task exactly once, sequentially. Successful retries
   * become `completed`/`recovered`; the rest stay `failed` with their latest
   * error. Never re-runs successful work and never loops.
   */
  private async retryFailedTasks(plan: MultiAgentPlan): Promise<void> {
    if (!this.runnerFn) return;
    const failed = plan.tasks.filter((task) => task.status === 'failed');
    for (const task of failed) {
      task.retried = true;
      task.status = 'in_progress';
      try {
        const depContext = capDependencyContext(this.buildDependencyContext(plan, task));
        const run = await this.runnerFn(task, depContext);
        this.applyTaskSuccess(task, run);
        task.recovered = true;
        this.invalidateModifiedFiles(task.modifiedFiles ?? []);
        log(`[MultiAgentCoordinator] Retry recovered task ${task.id}`);
      } catch (err) {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        logError(`[MultiAgentCoordinator] Retry of task ${task.id} failed:`, err);
      }
    }
  }

  /** Counts every task status for the plan's explicit aggregation report. */
  private summarizeAggregation(plan: MultiAgentPlan): PlanAggregation {
    const count = (status: AgentTask['status']): number =>
      plan.tasks.filter((task) => task.status === status).length;
    return {
      policy: plan.aggregationPolicy,
      completed: count('completed'),
      failed: count('failed'),
      skipped: count('skipped'),
      retried: plan.tasks.filter((task) => task.retried).length,
      recovered: plan.tasks.filter((task) => task.recovered).length,
    };
  }

  /**
   * Final plan status from the aggregation counts. Total failure is a failure
   * under every policy; otherwise only 'partial-ok' tolerates failures/skips.
   */
  private resolveAggregatedStatus(
    plan: MultiAgentPlan,
    aggregation: PlanAggregation
  ): 'done' | 'failed' {
    if (aggregation.completed === 0) return 'failed';
    if (plan.aggregationPolicy === 'partial-ok') return 'done';
    return aggregation.failed === 0 && aggregation.skipped === 0 ? 'done' : 'failed';
  }

  /** Drop modified files from the shared codegraph index (best effort). */
  private invalidateModifiedFiles(files: string[]): void {
    for (const file of files) {
      try {
        getCodeGraphIndexer().invalidateFile(file);
      } catch (err) {
        logError('[MultiAgentCoordinator] Failed to invalidate codegraph file:', file, err);
      }
    }
  }

  /**
   * The opt-in "debate" phase. Hard-bounded to ONE round-trip per zone:
   *  - Zone 3 first: the reviewer's substantive point triggers AT MOST one
   *    targeted developer re-run (same runner → same corrective mechanism as
   *    the existing syntax re-run, never a second parallel one).
   *  - Zone 1 then: reviewer and security each challenge the other's report;
   *    a surviving disagreement is recorded with BOTH positions and surfaced,
   *    never force-converged.
   * Research cross-verification lives in background-delegations.ts (Zone 2).
   */
  private async runCrossVerification(plan: MultiAgentPlan): Promise<CrossVerificationResult[]> {
    const runner = this.runnerFn;
    if (!runner) return [];
    const results: CrossVerificationResult[] = [];
    const reviewer = plan.tasks.find((t) => t.role === 'reviewer' && t.status === 'completed');
    const security = plan.tasks.find((t) => t.role === 'security' && t.status === 'completed');
    const developer = plan.tasks.find((t) => t.role === 'developer' && t.status === 'completed');

    // ── Zone 3: substantive code review → ONE targeted developer re-run ─────
    if (reviewer && developer) {
      const finding = parseReviewerFinding(reviewer.result ?? '');
      let addressed = false;
      let modelCalls = 0;
      if (finding.raised) {
        // Ephemeral clone: the re-run is a corrective round, not a new DAG node.
        const rerunTask: AgentTask = {
          ...developer,
          id: `${developer.id}-review-rerun`,
          status: 'pending',
          dependsOn: undefined,
        };
        try {
          const run = await runner(
            rerunTask,
            buildDeveloperReviewRerunContext({
              reviewPoint: finding.point,
              previousOutput: developer.result ?? '',
            })
          );
          modelCalls = CROSS_VERIFICATION_COST.codeReviewRerun;
          addressed = true;
          developer.result = run.output;
          developer.modifiedFiles = run.modifiedFiles ?? developer.modifiedFiles;
          developer.modelUsed = run.modelUsed ?? developer.modelUsed;
          if (run.teammateExchanges?.length) {
            developer.teammateExchanges = [
              ...(developer.teammateExchanges ?? []),
              ...run.teammateExchanges,
            ];
          }
          // Same freshness rule as the DAG path: files this re-run touched are
          // no longer fresh in the codegraph index.
          this.invalidateModifiedFiles(run.modifiedFiles ?? []);
          if (run.tokenUsage) {
            const base = developer.tokenUsage ?? { input: 0, output: 0 };
            developer.tokenUsage = {
              input: base.input + run.tokenUsage.input,
              output: base.output + run.tokenUsage.output,
            };
          }
          log(
            `[MultiAgentCoordinator] Substantive review point applied by ONE developer re-run (${rerunTask.id})`
          );
        } catch (err) {
          // The point is still recorded for traceability even if the re-run failed.
          logError('[MultiAgentCoordinator] Targeted developer re-run failed:', err);
        }
      }
      results.push(buildCodeReviewResult({ finding, addressed, modelCalls }));
    }

    // ── Zone 1: reviewer ↔ security peer challenge (ONE round, 2 calls) ─────
    if (reviewer && security) {
      try {
        results.push(await this.runPeerCrossCheck(reviewer, security));
      } catch (err) {
        // A failed debate loses only the enhancement: the code-review result
        // (if any) is still returned and the plan's real work already stands.
        logError('[MultiAgentCoordinator] Peer cross-check failed:', err);
      }
    }

    return results;
  }

  /**
   * ONE round of mutual challenge between the reviewer and security reports.
   * Both directions run in parallel (2 calls); the verdicts are parsed and a
   * surviving DISAGREE is kept with BOTH positions — never force-converged.
   */
  private async runPeerCrossCheck(
    reviewer: AgentTask,
    security: AgentTask
  ): Promise<CrossVerificationResult> {
    const runner = this.runnerFn;
    if (!runner) throw new Error('No sub-agent runner configured');
    const reviewerReport = reviewer.result ?? '';
    const securityReport = security.result ?? '';
    const challengeTask = (
      role: 'reviewer' | 'security',
      source: AgentTask,
      prompt: string
    ): AgentTask => ({
      ...source,
      id: `${source.id}-cross-check`,
      role,
      title: `Cross-check ${role}`,
      prompt,
      status: 'pending',
      dependsOn: undefined,
    });
    const [reviewerRun, securityRun] = await Promise.all([
      runner(
        challengeTask(
          'reviewer',
          reviewer,
          buildPeerChallengePrompt({
            ownRole: 'reviewer',
            peerRole: 'security',
            peerReport: securityReport,
            ownReport: reviewerReport,
          })
        ),
        ''
      ),
      runner(
        challengeTask(
          'security',
          security,
          buildPeerChallengePrompt({
            ownRole: 'security',
            peerRole: 'reviewer',
            peerReport: reviewerReport,
            ownReport: securityReport,
          })
        ),
        ''
      ),
    ]);
    const reviewerResponse = parseCrossCheckResponse('reviewer', reviewerRun.output);
    const securityResponse = parseCrossCheckResponse('security', securityRun.output);
    const peerResult = buildPeerCrossCheckResult({
      reviewerResponse,
      securityResponse,
      reviewerReport,
      securityReport,
      modelCalls: CROSS_VERIFICATION_COST.peerChallenge,
    });
    if (peerResult.hasUnresolvedDisagreement) {
      log(
        `[MultiAgentCoordinator] ${peerResult.divergences.length} unresolved reviewer/security disagreement(s) surfaced (not force-converged)`
      );
    }
    return peerResult;
  }

  public getPlan(planId: string): MultiAgentPlan | undefined {
    return this.activePlans.get(planId);
  }

  public getAllPlans(): MultiAgentPlan[] {
    return Array.from(this.activePlans.values());
  }
}
