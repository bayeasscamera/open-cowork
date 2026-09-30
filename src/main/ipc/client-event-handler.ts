/**
 * @module main/ipc/client-event-handler
 *
 * Dispatch table for the renderer `client-invoke` / `client-event` channels.
 * Extracted from main/index.ts so the ~50 client event types live in a cohesive
 * module and the app entry point stays focused on bootstrap and lifecycle.
 *
 * Everything the dispatcher needs from the app entry point is injected through
 * ClientEventHandlerContext, which keeps the dependency surface explicit.
 */

import { isAbsolute } from 'path';
import { dialog, type BrowserWindow } from 'electron';
import type { AppMenuState, ClientEvent, PermissionRule } from '../../shared/types';
import { configStore, type AppConfig, type AppTheme } from '../config/config-store';
import { setAutoApproveAll, setPermissionRules } from '../config/permission-rules-store';
import { eventRequiresSessionManager } from '../client-event-utils';
import { logError, logWarn } from '../utils/logger';
import {
  applyNativeThemePreference,
  DARK_BG,
  LIGHT_BG,
  resolveEffectiveTheme,
} from '../utils/window-theme';
import { ProjectValidationError, type ProjectStore } from '../projects/project-store';
import { computeProjectContextUsage } from '../projects/project-context';
import {
  cancelDelegation,
  deleteDelegation,
  getDelegation,
  getDelegationSettings,
  getDelegationStats,
  listDelegations,
  retryDelegation,
  setDelegationSettings,
} from '../agent/background-delegations';
import { getSwarmStats } from '../agent/swarm-stats';
import { listWorkspaceDocs, readWorkspaceDoc, writeWorkspaceDoc } from '../documents/document-doc';
import { SystemNotifier } from '../utils/system-notifier';
import { sendToRenderer } from '../events/renderer-sender';
import type { SessionManager } from '../session/session-manager';

/** Accessors for the app-level state owned by main/index.ts. */
export interface ClientEventHandlerContext {
  getSessionManager(): SessionManager | null;
  getMainWindow(): BrowserWindow | null;
  getCurrentWorkingDir(): string | null;
  getProjectStore(): ProjectStore;
  getWorkingDir(): string | null;
  setWorkingDir(
    newDir: string,
    sessionId?: string
  ): Promise<{ success: boolean; path: string; error?: string }>;
  getWorkspacePathUnsupportedReason(workspacePath?: string): string | null;
  /** Rebuild the application menu from renderer-synced labels and session state. */
  applyAppMenuState?(state: AppMenuState): void;
}

export async function handleClientEvent(
  event: ClientEvent,
  context: ClientEventHandlerContext
): Promise<unknown> {
  const { getProjectStore, getWorkingDir, setWorkingDir, getWorkspacePathUnsupportedReason } =
    context;
  // Snapshot the mutable window/session handles for the duration of one event.
  const sessionManager = context.getSessionManager();
  const mainWindow = context.getMainWindow();
  const currentWorkingDir = context.getCurrentWorkingDir();
  // Check if configured before starting sessions
  if (event.type === 'session.start' && !configStore.hasUsableCredentialsForActiveSet()) {
    sendToRenderer({
      type: 'error',
      payload: {
        message: 'No usable API credentials configured. Run the GUI to set up API keys.',
        code: 'CONFIG_REQUIRED_ACTIVE_SET',
        action: 'open_api_settings',
      },
    });
    return null;
  }

  if (eventRequiresSessionManager(event) && !sessionManager) {
    throw new Error('Session manager not initialized');
  }
  // After the guard above, sessionManager is guaranteed non-null for session.* events.
  // Use a local alias to satisfy TypeScript's control-flow narrowing.
  const sm = sessionManager!;

  switch (event.type) {
    case 'appMenu.sync': {
      // Renderer-pushed localized menu labels + session state (no session
      // manager involved, safe before any session exists).
      context.applyAppMenuState?.(event.payload);
      return { success: true };
    }
    case 'session.start': {
      // When the session starts inside a project, the project's workdir is the
      // workspace unless the caller explicitly overrode cwd.
      let cwd = event.payload.cwd;
      if (event.payload.projectId) {
        const project = getProjectStore().get(event.payload.projectId);
        if (!project) {
          throw new Error(`Project not found: ${event.payload.projectId}`);
        }
        if (!cwd) cwd = project.workdir;
      }
      if (getWorkspacePathUnsupportedReason(cwd)) {
        sendToRenderer({
          type: 'error',
          payload: {
            message: getWorkspacePathUnsupportedReason(cwd)!,
          },
        });
        return null;
      }
      return sm.startSession(
        event.payload.title,
        event.payload.prompt,
        cwd,
        event.payload.allowedTools,
        event.payload.content,
        event.payload.memoryEnabled,
        event.payload.projectId
      );
    }

    case 'session.continue':
      return sm.continueSession(
        event.payload.sessionId,
        event.payload.prompt,
        event.payload.content
      );

    case 'session.stop':
      return sm.stopSession(event.payload.sessionId);

    case 'session.delete':
      return sm.deleteSession(event.payload.sessionId);

    case 'session.batchDelete':
      return sm.batchDeleteSessions(event.payload.sessionIds);

    case 'session.rename':
      return sm.renameSession(event.payload.sessionId, event.payload.title);

    case 'session.togglePin':
      return sm.togglePinSession(event.payload.sessionId, event.payload.isPinned);

    case 'session.activate': {
      const { sessionId, cwd } = event.payload;
      if (sessionId) {
        configStore.set('lastActiveSessionId', sessionId);
        configStore.set('lastActiveSessionUpdatedAt', Date.now());
        if (cwd) configStore.set('lastActiveCwd', cwd);
      } else {
        // Session deselected — keep the last known session for resumption
      }
      return { ok: true };
    }

    case 'session.list': {
      const sessions = sm.listSessions();
      const lastActiveSessionId = configStore.get('lastActiveSessionId') as string | undefined;
      const lastActiveCwd = configStore.get('lastActiveCwd') as string | undefined;
      sendToRenderer({
        type: 'session.list',
        payload: { sessions, lastActiveSessionId, lastActiveCwd },
      });
      return sessions;
    }

    case 'session.getMessages':
      return sm.getMessages(event.payload.sessionId);

    case 'session.getTraceSteps':
      return sm.getTraceSteps(event.payload.sessionId);

    case 'session.compact':
      return sm.compactSession(event.payload.sessionId, event.payload.customInstructions);

    case 'session.setConfigOverride': {
      const { sessionId, configSetId, modelId } = event.payload;
      const updated = sm.setConfigOverride(sessionId, configSetId ?? null, modelId ?? null);
      return updated ? { success: true } : { success: false, error: 'Session not found' };
    }

    case 'session.getContextUsage':
      return sm.getContextUsage(event.payload.sessionId);

    case 'permission.response':
      return sm.handlePermissionResponse(event.payload.toolUseId, event.payload.result);

    case 'sudo.password.response':
      return sm.handleSudoPasswordResponse(event.payload.toolUseId, event.payload.password);

    case 'folder.select': {
      const folderResult = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
      });
      if (!folderResult.canceled && folderResult.filePaths.length > 0) {
        sendToRenderer({
          type: 'folder.selected',
          payload: { path: folderResult.filePaths[0] },
        });
        return folderResult.filePaths[0];
      }
      return null;
    }

    case 'workdir.get':
      return getWorkingDir();

    case 'workdir.set':
      return setWorkingDir(event.payload.path, event.payload.sessionId);

    case 'workdir.select': {
      const dialogDefaultPath =
        event.payload.currentPath && isAbsolute(event.payload.currentPath)
          ? event.payload.currentPath
          : currentWorkingDir || undefined;
      const workdirResult = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: 'Select Working Directory',
        defaultPath: dialogDefaultPath,
      });
      if (!workdirResult.canceled && workdirResult.filePaths.length > 0) {
        const selectedPath = workdirResult.filePaths[0];
        return setWorkingDir(selectedPath, event.payload.sessionId);
      }
      return { success: false, path: '', error: 'User cancelled' };
    }

    case 'config.createSet': {
      const payload = event.payload as { name?: unknown; mode?: unknown; fromSetId?: unknown };
      if (typeof payload.name !== 'string' || !payload.name.trim()) {
        return { success: false, error: 'name is required' };
      }
      try {
        const previousActiveId = configStore.getAll().activeConfigSetId;
        configStore.createSet({
          name: payload.name.trim(),
          mode: payload.mode === 'blank' ? 'blank' : 'clone',
          fromSetId: typeof payload.fromSetId === 'string' ? payload.fromSetId : undefined,
        });
        // createSet activates the new set: restore the user's previous active
        // set so creating one from RPC never changes the running profile.
        if (previousActiveId && configStore.getAll().activeConfigSetId !== previousActiveId) {
          configStore.switchSet({ id: previousActiveId });
        }
        // NEVER return credentials: only the id and display name of each set.
        const sets = configStore.getAll().configSets.map((set) => ({ id: set.id, name: set.name }));
        return { success: true, sets };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'createSet failed',
        };
      }
    }

    case 'settings.update': {
      if (
        event.payload.theme === 'dark' ||
        event.payload.theme === 'light' ||
        event.payload.theme === 'system'
      ) {
        const nextTheme = event.payload.theme as AppTheme;
        configStore.update({ theme: nextTheme });
        applyNativeThemePreference(nextTheme);
        if (mainWindow && !mainWindow.isDestroyed()) {
          const effectiveTheme = resolveEffectiveTheme(nextTheme);
          mainWindow.setBackgroundColor(effectiveTheme === 'dark' ? DARK_BG : LIGHT_BG);
        }
        sendToRenderer({
          type: 'config.status',
          payload: {
            isConfigured: configStore.isConfigured(),
            config: configStore.getAll(),
          },
        });
      }

      if (Array.isArray((event.payload as { permissionRules?: unknown }).permissionRules)) {
        setPermissionRules(
          (event.payload as { permissionRules: PermissionRule[] }).permissionRules
        );
      }

      if (typeof (event.payload as { autoApproveAll?: unknown }).autoApproveAll === 'boolean') {
        setAutoApproveAll((event.payload as { autoApproveAll: boolean }).autoApproveAll);
      }

      if (
        typeof (event.payload as { systemNotifications?: unknown }).systemNotifications ===
        'boolean'
      ) {
        SystemNotifier.setEnabled(
          (event.payload as { systemNotifications: boolean }).systemNotifications
        );
      }

      // Sub-agent swarm settings: non-sensitive (configSet ids, timeouts,
      // concurrency) and normalized by configStore.update.
      const subAgents = (event.payload as { subAgents?: unknown }).subAgents;
      if (typeof subAgents === 'object' && subAgents !== null) {
        configStore.update({ subAgents: subAgents as Partial<AppConfig>['subAgents'] });
        sendToRenderer({
          type: 'config.status',
          payload: {
            isConfigured: configStore.isConfigured(),
            config: configStore.getAll(),
          },
        });
      }
      return null;
    }

    // ── Projects ────────────────────────────────────────────────────────────
    // Validation errors (bad name, missing workdir, unknown id) come back as
    // { success: false, error } so the renderer can show them; internal errors
    // surface the same shape after logging, never an uncaught IPC throw.
    case 'projects.create': {
      try {
        const project = getProjectStore().create({
          name: event.payload.name,
          workdir: event.payload.workdir,
          description: event.payload.description,
          configSetId: event.payload.configSetId,
          modelId: event.payload.modelId,
          pipelineMode: event.payload.pipelineMode,
          draftConfigSetId: event.payload.draftConfigSetId,
          draftModelId: event.payload.draftModelId,
          refineConfigSetId: event.payload.refineConfigSetId,
          refineModelId: event.payload.refineModelId,
          instructions: event.payload.instructions,
        });
        return { success: true, project };
      } catch (error) {
        if (error instanceof ProjectValidationError) {
          return { success: false, error: error.message };
        }
        logError('[IPC] projects.create failed:', error);
        return { success: false, error: 'Failed to create project' };
      }
    }

    case 'projects.list': {
      try {
        const projects = getProjectStore().list(event.payload.includeArchived === true);
        return { success: true, projects };
      } catch (error) {
        logError('[IPC] projects.list failed:', error);
        return { success: false, error: 'Failed to list projects', projects: [] };
      }
    }

    case 'projects.get': {
      try {
        const project = getProjectStore().get(event.payload.projectId);
        if (!project) return { success: false, error: 'Project not found' };
        const sessions = getProjectStore().getSessions(project.id);
        return {
          success: true,
          project,
          sessions,
          usage: computeProjectContextUsage(project),
        };
      } catch (error) {
        logError('[IPC] projects.get failed:', error);
        return { success: false, error: 'Failed to load project' };
      }
    }

    case 'projects.update': {
      try {
        const project = getProjectStore().update(event.payload.projectId, {
          name: event.payload.name,
          description: event.payload.description,
          workdir: event.payload.workdir,
          configSetId: event.payload.configSetId,
          modelId: event.payload.modelId,
          pipelineMode: event.payload.pipelineMode,
          draftConfigSetId: event.payload.draftConfigSetId,
          draftModelId: event.payload.draftModelId,
          refineConfigSetId: event.payload.refineConfigSetId,
          refineModelId: event.payload.refineModelId,
          instructions: event.payload.instructions,
        });
        return { success: true, project };
      } catch (error) {
        if (error instanceof ProjectValidationError) {
          return { success: false, error: error.message };
        }
        logError('[IPC] projects.update failed:', error);
        return { success: false, error: 'Failed to update project' };
      }
    }

    case 'projects.archive': {
      try {
        const project = getProjectStore().archive(event.payload.projectId, event.payload.archived);
        return { success: true, project };
      } catch (error) {
        if (error instanceof ProjectValidationError) {
          return { success: false, error: error.message };
        }
        logError('[IPC] projects.archive failed:', error);
        return { success: false, error: 'Failed to archive project' };
      }
    }

    case 'projects.attachFile': {
      try {
        const project = getProjectStore().attachFile(event.payload.projectId, event.payload.path);
        return { success: true, project };
      } catch (error) {
        if (error instanceof ProjectValidationError) {
          return { success: false, error: error.message };
        }
        logError('[IPC] projects.attachFile failed:', error);
        return { success: false, error: 'Failed to attach file' };
      }
    }

    case 'projects.detachFile': {
      try {
        const project = getProjectStore().detachFile(event.payload.projectId, event.payload.path);
        return { success: true, project };
      } catch (error) {
        if (error instanceof ProjectValidationError) {
          return { success: false, error: error.message };
        }
        logError('[IPC] projects.detachFile failed:', error);
        return { success: false, error: 'Failed to detach file' };
      }
    }

    case 'projects.linkSession': {
      try {
        getProjectStore().linkSession(event.payload.projectId, event.payload.sessionId);
        return { success: true };
      } catch (error) {
        if (error instanceof ProjectValidationError) {
          return { success: false, error: error.message };
        }
        logError('[IPC] projects.linkSession failed:', error);
        return { success: false, error: 'Failed to link session' };
      }
    }

    case 'projects.unlinkSession': {
      try {
        getProjectStore().unlinkSession(event.payload.sessionId);
        return { success: true };
      } catch (error) {
        logError('[IPC] projects.unlinkSession failed:', error);
        return { success: false, error: 'Failed to unlink session' };
      }
    }

    case 'projects.delete': {
      try {
        const outcome = getProjectStore().delete(event.payload.projectId);
        return { success: true, ...outcome };
      } catch (error) {
        if (error instanceof ProjectValidationError) {
          return { success: false, error: error.message };
        }
        logError('[IPC] projects.delete failed:', error);
        return { success: false, error: 'Failed to delete project' };
      }
    }

    // ── Background delegations (tracking view) ─────────────────────────────
    case 'backgroundTasks.list': {
      try {
        return { success: true, tasks: listDelegations(event.payload.sessionId) };
      } catch (error) {
        logError('[IPC] backgroundTasks.list failed:', error);
        return { success: false, tasks: [] };
      }
    }

    case 'backgroundTasks.get': {
      try {
        const task = getDelegation(event.payload.taskId);
        if (!task) return { success: false, error: 'Task not found' };
        return { success: true, task };
      } catch (error) {
        logError('[IPC] backgroundTasks.get failed:', error);
        return { success: false, error: 'Failed to load task' };
      }
    }

    case 'backgroundTasks.cancel': {
      try {
        const cancelled = cancelDelegation(event.payload.taskId);
        return {
          success: true,
          cancelled,
          error: cancelled ? undefined : 'Task not found or not running',
        };
      } catch (error) {
        logError('[IPC] backgroundTasks.cancel failed:', error);
        return { success: false, error: 'Failed to cancel task' };
      }
    }

    case 'backgroundTasks.retry': {
      try {
        const retried = retryDelegation(event.payload.taskId);
        if (!retried) {
          return { success: false, error: 'Task not found or still running' };
        }
        return { success: true, taskId: retried.taskId };
      } catch (error) {
        logError('[IPC] backgroundTasks.retry failed:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to retry task',
        };
      }
    }

    case 'backgroundTasks.delete': {
      try {
        const deleted = deleteDelegation(event.payload.taskId);
        return {
          success: true,
          deleted,
          error: deleted ? undefined : 'Task not found or still running',
        };
      } catch (error) {
        logError('[IPC] backgroundTasks.delete failed:', error);
        return { success: false, error: 'Failed to delete task' };
      }
    }

    case 'backgroundTasks.getSettings': {
      try {
        return { success: true, settings: getDelegationSettings() };
      } catch (error) {
        logError('[IPC] backgroundTasks.getSettings failed:', error);
        return { success: false, error: 'Failed to load settings' };
      }
    }

    // Single round-trip for the Sub-agents transparency sections.
    case 'backgroundTasks.getStats': {
      try {
        return {
          success: true,
          swarm: getSwarmStats(),
          delegations: getDelegationStats(),
        };
      } catch (error) {
        logError('[IPC] backgroundTasks.getStats failed:', error);
        return { success: false, error: 'Failed to load stats' };
      }
    }

    // ── Live document co-editing (workspace-confined) ──────────────────────
    case 'document.read': {
      try {
        return { success: true, ...readWorkspaceDoc(event.payload.cwd, event.payload.path) };
      } catch (error) {
        logError('[IPC] document.read failed:', error);
        return { success: false, error: 'Failed to read document' };
      }
    }

    case 'document.write': {
      try {
        const result = writeWorkspaceDoc(
          event.payload.cwd,
          event.payload.path,
          event.payload.content,
          { baseMtimeMs: event.payload.baseMtimeMs, force: event.payload.force }
        );
        return { success: result.ok, ...result };
      } catch (error) {
        logError('[IPC] document.write failed:', error);
        return { success: false, status: 'error', error: 'Failed to write document' };
      }
    }

    case 'document.list': {
      try {
        return { success: true, files: listWorkspaceDocs(event.payload.cwd) };
      } catch (error) {
        logError('[IPC] document.list failed:', error);
        return { success: false, files: [], error: 'Failed to list documents' };
      }
    }

    case 'backgroundTasks.setSettings': {
      try {
        // modelId null (UI "clear the pin") normalizes to undefined internally.
        const { modelId, ...rest } = event.payload;
        const settings = setDelegationSettings({
          ...rest,
          ...(modelId === null ? { modelId: undefined } : { modelId }),
        });
        return { success: true, settings };
      } catch (error) {
        logError('[IPC] backgroundTasks.setSettings failed:', error);
        return { success: false, error: 'Failed to save settings' };
      }
    }

    default:
      logWarn('Unknown event type:', event);
      return null;
  }
}
