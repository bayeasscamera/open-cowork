/**
 * @module main/agent/multi-agent-coordinator
 * v4.0: Collaborative Local Multi-Agent Orchestrator (Cowork Swarm)
 *
 * Coordinates specialized sub-agents (Architect, Developer, Reviewer, Security)
 * across an asynchronous Directed Acyclic Graph (DAG).
 */

import { EventEmitter } from 'events';
import { logError } from '../utils/logger';
import { getCodeGraphIndexer } from '../memory/codegraph-indexer';

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
}

export interface MultiAgentPlan {
  id: string;
  goal: string;
  tasks: AgentTask[];
  status: 'planning' | 'executing' | 'done' | 'failed';
  createdAt: number;
  updatedAt: number;
}

export type SubAgentRunnerFn = (
  task: AgentTask,
  context: string
) => Promise<SubAgentRunResult>;

/** Result of a sub-agent run: free text plus the files the agent modified. */
export interface SubAgentRunResult {
  output: string;
  modifiedFiles?: string[];
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
   * Create an optimized DAG task plan for a user goal
   */
  public createCollaborativePlan(goal: string): MultiAgentPlan {
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
        prompt: `Lancer la suite de tests, inspecter les régressions et valider l'exécution`,
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
            // Aggregate results of previous dependencies as context
            const depContext = (task.dependsOn || [])
              .map((depId) => {
                const dep = plan.tasks.find((t) => t.id === depId);
                return `### [${dep?.role.toUpperCase()}] ${dep?.title}\n${dep?.result || ''}`;
              })
              .join('\n\n');

            let result = '';
            let modifiedFiles: string[] = [];
            if (this.runnerFn) {
              const run = await this.runnerFn(task, depContext);
              result = run.output;
              modifiedFiles = run.modifiedFiles ?? [];
            } else {
              // Simulated execution for testing / fallback
              result = `Output for ${task.title} verified.`;
            }

            task.status = 'completed';
            task.result = result;
            task.completedAt = Date.now();
            this.emit('task:completed', { planId, task, modifiedFiles });

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

    plan.updatedAt = Date.now();
    this.emit('plan:completed', plan);
    return plan;
  }

  public getPlan(planId: string): MultiAgentPlan | undefined {
    return this.activePlans.get(planId);
  }

  public getAllPlans(): MultiAgentPlan[] {
    return Array.from(this.activePlans.values());
  }
}
