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
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
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
}

export type SubAgentRunnerFn = (
  task: AgentTask,
  context: string
) => Promise<SubAgentRunResult>;

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
    options?: { crossVerification?: boolean }
  ): MultiAgentPlan {
    const crossVerification = options?.crossVerification === true;
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

    const plan: MultiAgentPlan = {
      id: planId,
      goal,
      tasks,
      status: 'planning',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      crossVerification,
    };

    this.activePlans.set(planId, plan);
    this.emit('plan:created', plan);
    return plan;
  }

  /**
   * Execute all ready tasks in parallel adhering to dependency DAG
   */
  public async executePlan(planId: string): Promise<MultiAgentPlan> {
    const plan = this.activePlans.get(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    plan.status = 'executing';
    plan.updatedAt = Date.now();
    this.emit('plan:updated', plan);

    let hadFailure = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Find all pending tasks whose dependencies are satisfied
      const readyTasks = plan.tasks.filter((task) => {
        if (task.status !== 'pending') return false;
        if (!task.dependsOn || task.dependsOn.length === 0) return true;
        return task.dependsOn.every((depId) => {
          const depTask = plan.tasks.find((t) => t.id === depId);
          return depTask?.status === 'completed';
        });
      });

      // If no tasks ready, check if all tasks completed or if stuck
      if (readyTasks.length === 0) {
        const remaining = plan.tasks.filter((t) => t.status === 'pending' || t.status === 'in_progress');
        if (remaining.length === 0) {
          plan.status = hadFailure ? 'failed' : 'done';
          break;
        } else {
          // Deadlock or waiting
          break;
        }
      }

      // Execute ready tasks concurrently
      await Promise.all(
        readyTasks.map(async (task) => {
          task.status = 'in_progress';
          task.startedAt = Date.now();
          this.emit('task:started', { planId, task });

          try {
            // Aggregate results of previous dependencies as context. Each
            // dependent task receives the full aggregate — reviewer AND
            // security both get a copy — so an uncapped context multiplies
            // token cost for long upstream outputs (measured: an architect
            // run can produce a very large result).
            const depContext = capDependencyContext(
              (task.dependsOn || [])
                .map((depId) => {
                  const dep = plan.tasks.find((t) => t.id === depId);
                  return `### [${dep?.role.toUpperCase()}] ${dep?.title}\n${dep?.result || ''}`;
                })
                .join('\n\n')
            );

            let result = '';
            let modifiedFiles: string[] = [];
            let usedFallback: boolean | undefined;
            let modelUsed: string | undefined;
            let syntaxIssues: string[] | undefined;
            let tokenUsage: { input: number; output: number } | undefined;
            if (this.runnerFn) {
              const run = await this.runnerFn(task, depContext);
              result = run.output;
              modifiedFiles = run.modifiedFiles ?? [];
              usedFallback = run.usedFallback;
              modelUsed = run.modelUsed;
              syntaxIssues = run.syntaxIssues;
              tokenUsage = run.tokenUsage;
            } else {
              // Simulated execution for testing / fallback
              result = `Output for ${task.title} verified.`;
            }

            task.status = 'completed';
            task.result = result;
            task.completedAt = Date.now();
            task.modifiedFiles = modifiedFiles;
            task.modelUsed = modelUsed;
            task.usedFallback = usedFallback;
            task.syntaxIssues = syntaxIssues;
            task.tokenUsage = tokenUsage;
            if (modelUsed) {
              log(
                `[MultiAgentCoordinator] Task ${task.role} (${task.id}) completed on model "${modelUsed}"` +
                  (usedFallback ? ' — via fallback' : '')
              );
            }
            this.emit('task:completed', { planId, task, modifiedFiles, usedFallback, modelUsed, syntaxIssues });

            // Files a sub-agent changed are no longer fresh in the codegraph
            // index: invalidate exactly those entries instead of waiting for
            // the TTL or rescanning the whole workspace.
            for (const file of modifiedFiles) {
              try {
                getCodeGraphIndexer().invalidateFile(file);
              } catch (err) {
                logError('[MultiAgentCoordinator] Failed to invalidate codegraph file:', file, err);
              }
            }
          } catch (err) {
            hadFailure = true;
            task.status = 'failed';
            task.error = err instanceof Error ? err.message : String(err);
            this.emit('task:failed', { planId, task });
            logError(`[MultiAgentCoordinator] Task ${task.id} failed:`, err);
          }
        })
      );
    }

    // OPT-IN cross-verification phase — runs AFTER the DAG, so the reviewer
    // and security reports already exist and can be confronted. Never on the
    // default path: it costs extra model calls (see CROSS_VERIFICATION_COST).
    if (plan.crossVerification && this.runnerFn) {
      try {
        plan.crossVerificationResults = await this.runCrossVerification(plan);
      } catch (err) {
        // Cross-verification is an enhancement: a failure must not fail the
        // plan whose real work already completed.
        logError('[MultiAgentCoordinator] Cross-verification phase failed:', err);
      }
    }

    plan.updatedAt = Date.now();
    this.emit('plan:completed', plan);
    return plan;
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
          // Same freshness rule as the DAG path: files this re-run touched are
          // no longer fresh in the codegraph index.
          for (const file of run.modifiedFiles ?? []) {
            try {
              getCodeGraphIndexer().invalidateFile(file);
            } catch (err) {
              logError('[MultiAgentCoordinator] Failed to invalidate codegraph file:', file, err);
            }
          }
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
