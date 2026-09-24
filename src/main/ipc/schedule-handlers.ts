/**
 * @module main/ipc/schedule-handlers
 *
 * Scheduled task IPC channels (schedule.*): CRUD, toggle and manual run.
 * Extracted from main/index.ts so task scheduling lives with the other IPC
 * domains; the manager handle and workspace/title helpers are injected.
 */

import { ipcMain } from 'electron';
import { buildScheduledTaskTitle } from '../../shared/schedule/task-title';
import type {
  ScheduledTaskManager,
  ScheduledTaskCreateInput,
  ScheduledTaskUpdateInput,
} from '../schedule/scheduled-task-manager';
import { logError } from '../utils/logger';

/** Accessors for app-level state owned by main/index.ts. */
interface ScheduleIpcContext {
  getScheduledTaskManager(): ScheduledTaskManager | null;
  getWorkspacePathUnsupportedReason(workspacePath?: string): string | null;
  resolveScheduledTaskTitle(prompt: string, cwd?: string, fallbackTitle?: string): Promise<string>;
  getProject(projectId: string): { id: string; workdir: string; archived?: boolean } | undefined;
}

export function registerScheduleIpcHandlers(context: ScheduleIpcContext): void {
  const { getWorkspacePathUnsupportedReason, resolveScheduledTaskTitle, getProject } = context;
  ipcMain.handle('schedule.list', () => {
    try {
      const manager = context.getScheduledTaskManager();
      if (!manager) return [];
      return manager.list();
    } catch (error) {
      logError('[Schedule] Error listing tasks:', error);
      return [];
    }
  });

  ipcMain.handle('schedule.create', async (_event, payload: ScheduledTaskCreateInput) => {
    const manager = context.getScheduledTaskManager();
    if (!manager) {
      throw new Error('Scheduled task manager not initialized');
    }
    let cwd = payload.cwd;
    if (payload.projectId) {
      const project = getProject(payload.projectId);
      if (!project || project.archived) throw new Error('Scheduled task project is unavailable');
      cwd = project.workdir;
    }
    const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
    if (unsupportedReason) {
      throw new Error(unsupportedReason);
    }
    const normalizedPrompt = payload.prompt.trim();
    const title = await resolveScheduledTaskTitle(normalizedPrompt, cwd, payload.title);
    return manager.create({
      ...payload,
      cwd,
      prompt: normalizedPrompt,
      title,
    });
  });

  ipcMain.handle(
    'schedule.update',
    async (_event, id: string, updates: ScheduledTaskUpdateInput) => {
      const manager = context.getScheduledTaskManager();
      if (!manager) {
        throw new Error('Scheduled task manager not initialized');
      }
      const existing = manager.get(id);
      if (!existing) return null;
      const nextCwd = updates.cwd ?? existing.cwd;
      const projectId = updates.projectId === undefined ? existing.projectId : updates.projectId;
      let resolvedCwd = nextCwd;
      if (projectId) {
        const project = getProject(projectId);
        if (!project || project.archived) throw new Error('Scheduled task project is unavailable');
        resolvedCwd = project.workdir;
      }
      const unsupportedReason = getWorkspacePathUnsupportedReason(resolvedCwd);
      if (unsupportedReason) {
        throw new Error(unsupportedReason);
      }
      const normalizedPrompt =
        updates.prompt === undefined ? existing.prompt : updates.prompt.trim();
      const normalizedUpdates: ScheduledTaskUpdateInput = {
        ...updates,
        ...(updates.projectId !== undefined ? { projectId, cwd: resolvedCwd } : {}),
        prompt: normalizedPrompt,
      };

      if (updates.prompt !== undefined) {
        normalizedUpdates.title = await resolveScheduledTaskTitle(
          normalizedPrompt,
          resolvedCwd,
          updates.title ?? existing.title
        );
      } else if (updates.title !== undefined) {
        normalizedUpdates.title = buildScheduledTaskTitle(updates.title);
      }

      return manager.update(id, normalizedUpdates);
    }
  );

  ipcMain.handle('schedule.delete', (_event, id: string) => {
    const manager = context.getScheduledTaskManager();
    if (!manager) {
      throw new Error('Scheduled task manager not initialized');
    }
    return { success: manager.delete(id) };
  });

  ipcMain.handle('schedule.toggle', (_event, id: string, enabled: boolean) => {
    const manager = context.getScheduledTaskManager();
    if (!manager) {
      throw new Error('Scheduled task manager not initialized');
    }
    return manager.toggle(id, enabled);
  });

  ipcMain.handle('schedule.runNow', async (_event, id: string) => {
    const manager = context.getScheduledTaskManager();
    if (!manager) {
      throw new Error('Scheduled task manager not initialized');
    }
    return manager.runNow(id);
  });
}
