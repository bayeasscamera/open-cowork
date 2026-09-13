/**
 * @module main/agent/background-autopilot
 * v3.6+: Autonomous Background Task Worker with State Checkpoints & macOS Notifications
 */

import { exec } from 'child_process';

export interface BackgroundTask {
  id: string;
  title: string;
  steps: string[];
  currentStepIndex: number;
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  error?: string;
  createdAt: number;
  completedAt?: number;
}

export class BackgroundAutopilotManager {
  private tasks: Map<string, BackgroundTask> = new Map();

  public createTask(title: string, steps: string[]): BackgroundTask {
    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const task: BackgroundTask = {
      id,
      title,
      steps,
      currentStepIndex: 0,
      status: 'idle',
      createdAt: Date.now(),
    };
    this.tasks.set(id, task);
    return task;
  }

  public async runTask(
    taskId: string,
    executeStepCallback: (step: string, index: number) => Promise<void>
  ): Promise<BackgroundTask> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Tâche introuvable: ${taskId}`);

    task.status = 'running';

    try {
      for (let i = task.currentStepIndex; i < task.steps.length; i++) {
        task.currentStepIndex = i;
        await executeStepCallback(task.steps[i], i);
      }

      task.status = 'completed';
      task.completedAt = Date.now();
      this.sendSystemNotification('Open Cowork Autopilot', `Tâche terminée avec succès: ${task.title}`);
    } catch (err: any) {
      task.status = 'failed';
      task.error = err?.message || String(err);
      this.sendSystemNotification('Open Cowork Autopilot - Erreur', `Échec de la tâche: ${task.title}`);
    }

    return task;
  }

  public getTask(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  public listTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  private sendSystemNotification(title: string, message: string) {
    if (process.platform === 'darwin') {
      const sanitizedTitle = title.replace(/"/g, '\\"');
      const sanitizedMsg = message.replace(/"/g, '\\"');
      const script = `display notification "${sanitizedMsg}" with title "${sanitizedTitle}"`;
      exec(`osascript -e '${script}'`, () => {});
    }
  }
}
