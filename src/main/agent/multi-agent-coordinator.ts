/**
 * @module main/agent/multi-agent-coordinator
 * v3.5: Collaborative Local Multi-Agent Orchestrator
 * (Architect, Developer, Reviewer)
 */

export type AgentRole = 'architect' | 'developer' | 'reviewer';

export interface AgentTask {
  id: string;
  role: AgentRole;
  title: string;
  prompt: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  result?: string;
  dependsOn?: string[];
}

export interface MultiAgentPlan {
  id: string;
  goal: string;
  tasks: AgentTask[];
  status: 'planning' | 'executing' | 'done' | 'failed';
}

export class MultiAgentCoordinator {
  private activePlans: Map<string, MultiAgentPlan> = new Map();

  public createCollaborativePlan(goal: string): MultiAgentPlan {
    const planId = `plan-${Date.now()}`;
    const tasks: AgentTask[] = [
      {
        id: `${planId}-task-1`,
        role: 'architect',
        title: 'Analyse et conception technique',
        prompt: `Analyser les contraintes et proposer le plan d'architecture pour l'objectif: ${goal}`,
        status: 'pending',
      },
      {
        id: `${planId}-task-2`,
        role: 'developer',
        title: 'Implémentation du code',
        prompt: `Appliquer les modifications de code selon la conception établie`,
        status: 'pending',
        dependsOn: [`${planId}-task-1`],
      },
      {
        id: `${planId}-task-3`,
        role: 'reviewer',
        title: 'Revue qualité, tests et vérification',
        prompt: `Vérifier la robustesse, tester les régressions et valider l'objectif`,
        status: 'pending',
        dependsOn: [`${planId}-task-2`],
      },
    ];

    const plan: MultiAgentPlan = {
      id: planId,
      goal,
      tasks,
      status: 'planning',
    };

    this.activePlans.set(planId, plan);
    return plan;
  }

  public updateTaskStatus(
    planId: string,
    taskId: string,
    status: AgentTask['status'],
    result?: string
  ): AgentTask | null {
    const plan = this.activePlans.get(planId);
    if (!plan) return null;

    const task = plan.tasks.find((t) => t.id === taskId);
    if (!task) return null;

    task.status = status;
    if (result) task.result = result;

    const allCompleted = plan.tasks.every((t) => t.status === 'completed');
    if (allCompleted) plan.status = 'done';

    return task;
  }

  public getPlan(planId: string): MultiAgentPlan | undefined {
    return this.activePlans.get(planId);
  }
}
