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
export interface ScheduleIpcContext {
  getScheduledTaskManager(): ScheduledTaskManager | null;
  getWorkspacePathUnsupportedReason(workspacePath?: string): string | null;
  resolveScheduledTaskTitle(prompt: string, cwd?: string, fallbackTitle?: string): Promise<string>;
}

export function registerScheduleIpcHandlers(context: ScheduleIpcContext): void {
  const { getWorkspacePathUnsupportedReason, resolveScheduledTaskTitle } = context;
  // Snapshot the mutable manager handle for the duration of one registration.
  const manager = context.getScheduledTaskManager();
  ipcMain.handle('schedule.list', () => {
    try {
      if (!manager) return [];
      return manager.list();
    } catch (error) {
      logError('[Schedule] Error listing tasks:', error);
      return [];
    }
  });

  ipcMain.handle('schedule.create', async (_event, payload: ScheduledTaskCreateInput) => {
    if (!manager) {
      throw new Error('Scheduled task manager not initialized');
    }
    const unsupportedReason = getWorkspacePathUnsupportedReason(payload.cwd);
    if (unsupportedReason) {
      throw new Error(unsupportedReason);
    }
    const normalizedPrompt = payload.prompt.trim();
    const title = await resolveScheduledTaskTitle(normalizedPrompt, payload.cwd, payload.title);
    return manager.create({
      ...payload,
      prompt: normalizedPrompt,
      title,
    });
  });

  ipcMain.handle(
    'schedule.update',
    async (_event, id: string, updates: ScheduledTaskUpdateInput) => {
      if (!manager) {
        throw new Error('Scheduled task manager not initialized');
      }
      const existing = manager.get(id);
      if (!existing) return null;
      const nextCwd = updates.cwd ?? existing.cwd;
      const unsupportedReason = getWorkspacePathUnsupportedReason(nextCwd);
      if (unsupportedReason) {
        throw new Error(unsupportedReason);
      }
      const normalizedPrompt =
        updates.prompt === undefined ? existing.prompt : updates.prompt.trim();
      const normalizedUpdates: ScheduledTaskUpdateInput = {
        ...updates,
        prompt: normalizedPrompt,
      };

      if (updates.prompt !== undefined) {
        normalizedUpdates.title = await resolveScheduledTaskTitle(
          normalizedPrompt,
          updates.cwd ?? existing.cwd,
          updates.title ?? existing.title
        );
      } else if (updates.title !== undefined) {
        normalizedUpdates.title = buildScheduledTaskTitle(updates.title);
      }

      return manager.update(id, normalizedUpdates);
    }
  );

  ipcMain.handle('schedule.delete', (_event, id: string) => {
    if (!manager) {
      throw new Error('Scheduled task manager not initialized');
    }
    return { success: manager.delete(id) };
  });

  ipcMain.handle('schedule.toggle', (_event, id: string, enabled: boolean) => {
    if (!manager) {
      throw new Error('Scheduled task manager not initialized');
    }
    return manager.toggle(id, enabled);
  });

  ipcMain.handle('schedule.runNow', async (_event, id: string) => {
    if (!manager) {
      throw new Error('Scheduled task manager not initialized');
    }
    return manager.runNow(id);
  });
}
