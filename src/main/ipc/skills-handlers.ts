/**
 * @module main/ipc/skills-handlers
 *
 * Skills and plugin IPC channels (skills.*, plugins.*) plus the skills.doctor
 * self-check. Extracted from main/index.ts; the skills manager and session
 * manager handles are injected.
 */

import { app, ipcMain, shell } from 'electron';
import { join } from 'path';
import { configStore } from '../config/config-store';
import {
  buildSkillDoctorReport,
  loadSkillSourcesFromDir,
  type SkillDoctorSkillSource,
} from '../mods/skill-doctor';
import { approveProposal, listProposals, rejectProposal } from '../skills/skill-proposals';
import type { PluginRuntimeService } from '../skills/plugin-runtime-service';
import { sendToRenderer } from '../events/renderer-sender';
import type { SessionManager } from '../session/session-manager';
import type { SkillsManager } from '../skills/skills-manager';
import { logError } from '../utils/logger';

/** Accessors for app-level state owned by main/index.ts. */
interface SkillsIpcContext {
  getSkillsManager(): SkillsManager | null;
  getPluginRuntimeService(): PluginRuntimeService | null;
  getSessionManager(): SessionManager | null;
}

export function registerSkillsIpcHandlers(context: SkillsIpcContext): void {
  const skillsManager = context.getSkillsManager();
  const sessionManager = context.getSessionManager();
  const pluginRuntimeService = context.getPluginRuntimeService();
  ipcMain.handle('skills.getAll', async () => {
    try {
      if (!skillsManager) {
        throw new Error('Skills manager is still starting');
      }
      return await skillsManager.listSkills();
    } catch (error) {
      logError('[Skills] Error getting skills:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.install', async (_event, skillPath: string) => {
    try {
      if (!skillsManager) {
        throw new Error('SkillsManager not initialized');
      }
      const skill = await skillsManager.installSkill(skillPath);
      sessionManager?.invalidateSkillsSetup();
      return { success: true, skill };
    } catch (error) {
      logError('[Skills] Error installing skill:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.delete', async (_event, skillId: string) => {
    try {
      if (!skillsManager) {
        throw new Error('SkillsManager not initialized');
      }
      await skillsManager.uninstallSkill(skillId);
      sessionManager?.invalidateSkillsSetup();
      return { success: true };
    } catch (error) {
      logError('[Skills] Error deleting skill:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.setEnabled', async (_event, skillId: string, enabled: boolean) => {
    try {
      if (!skillsManager) {
        throw new Error('SkillsManager not initialized');
      }
      skillsManager.setSkillEnabled(skillId, enabled);
      sessionManager?.invalidateSkillsSetup();
      return { success: true };
    } catch (error) {
      logError('[Skills] Error toggling skill:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.validate', async (_event, skillPath: string) => {
    try {
      if (!skillsManager) {
        return { valid: false, errors: ['SkillsManager not initialized'] };
      }
      const result = await skillsManager.validateSkillFolder(skillPath);
      return result;
    } catch (error) {
      logError('[Skills] Error validating skill:', error);
      return { valid: false, errors: ['Validation failed'] };
    }
  });

  ipcMain.handle('skills.getStoragePath', async () => {
    try {
      if (!skillsManager) {
        return null;
      }
      return skillsManager.getGlobalSkillsPath();
    } catch (error) {
      logError('[Skills] Error getting storage path:', error);
      return null;
    }
  });

  ipcMain.handle('skills.setStoragePath', async (_event, targetPath: string, migrate = true) => {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    const result = await skillsManager.setGlobalSkillsPath(targetPath, migrate !== false);
    sendToRenderer({
      type: 'config.status',
      payload: {
        isConfigured: configStore.isConfigured(),
        config: configStore.getAll(),
      },
    });
    return { success: true, ...result };
  });

  ipcMain.handle('skills.openStoragePath', async () => {
    if (!skillsManager) {
      throw new Error('SkillsManager not initialized');
    }
    const storagePath = skillsManager.getGlobalSkillsPath();
    const openResult = await shell.openPath(storagePath);
    if (openResult) {
      return { success: false, path: storagePath, error: openResult };
    }
    return { success: true, path: storagePath };
  });

  // ── Proposed skills (sub-agent / synthesizer drafts, MANUAL approval gate) ──
  // A proposal is INERT until the user approves it here: approve moves the draft
  // into the ACTIVE skills directory; reject deletes it. Nothing else in the app
  // can activate a proposal — there is no automatic path.
  ipcMain.handle('skills.listProposals', async () => {
    try {
      return { success: true, proposals: listProposals() };
    } catch (error) {
      logError('[IPC] skills.listProposals failed:', error);
      return { success: false, proposals: [] };
    }
  });

  ipcMain.handle('skills.approveProposal', async (_event, name: unknown, renameTo?: unknown) => {
    try {
      if (typeof name !== 'string' || !name.trim()) {
        return { success: false, error: 'Skill name is required.' };
      }
      const activeDir = skillsManager
        ? skillsManager.getGlobalSkillsPath()
        : join(app.getPath('userData'), 'claude', 'skills');
      const rename = typeof renameTo === 'string' && renameTo.trim() ? renameTo : undefined;
      const result = approveProposal(name, activeDir, rename);
      if (!result.ok) {
        // Structured code lets the UI offer the approve-as-rename flow.
        return { success: false, code: result.code, error: result.error };
      }
      return { success: true, name: result.name, path: result.path };
    } catch (error) {
      logError('[IPC] skills.approveProposal failed:', error);
      return { success: false, error: 'Failed to approve the proposed skill.' };
    }
  });

  ipcMain.handle('skills.rejectProposal', async (_event, name: unknown) => {
    try {
      if (typeof name !== 'string' || !name.trim()) {
        return { success: false, error: 'Skill name is required.' };
      }
      const result = rejectProposal(name);
      if (!result.ok) {
        return { success: false, error: result.error };
      }
      return { success: true };
    } catch (error) {
      logError('[IPC] skills.rejectProposal failed:', error);
      return { success: false, error: 'Failed to reject the proposed skill.' };
    }
  });

  ipcMain.handle('plugins.listCatalog', async (_event, options?: { installableOnly?: boolean }) => {
    try {
      if (!pluginRuntimeService) {
        throw new Error('PluginRuntimeService not initialized');
      }
      return await pluginRuntimeService.listCatalog(options);
    } catch (error) {
      logError('[Plugins] Error listing catalog:', error);
      throw error;
    }
  });

  ipcMain.handle('plugins.listInstalled', async () => {
    try {
      if (!pluginRuntimeService) {
        throw new Error('PluginRuntimeService not initialized');
      }
      return pluginRuntimeService.listInstalled();
    } catch (error) {
      logError('[Plugins] Error listing installed plugins:', error);
      throw error;
    }
  });

  ipcMain.handle('plugins.install', async (_event, pluginName: string) => {
    try {
      if (!pluginRuntimeService) {
        throw new Error('PluginRuntimeService not initialized');
      }
      const result = await pluginRuntimeService.install(pluginName);
      sessionManager?.invalidateSkillsSetup();
      return result;
    } catch (error) {
      logError('[Plugins] Error installing plugin:', error);
      throw error;
    }
  });

  ipcMain.handle('plugins.setEnabled', async (_event, pluginId: string, enabled: boolean) => {
    try {
      if (!pluginRuntimeService) {
        throw new Error('PluginRuntimeService not initialized');
      }
      const result = await pluginRuntimeService.setEnabled(pluginId, enabled);
      sessionManager?.invalidateSkillsSetup();
      return result;
    } catch (error) {
      logError('[Plugins] Error toggling plugin:', error);
      throw error;
    }
  });

  ipcMain.handle(
    'plugins.setComponentEnabled',
    async (
      _event,
      pluginId: string,
      component: 'skills' | 'commands' | 'agents' | 'hooks' | 'mcp',
      enabled: boolean
    ) => {
      try {
        if (!pluginRuntimeService) {
          throw new Error('PluginRuntimeService not initialized');
        }
        const result = await pluginRuntimeService.setComponentEnabled(pluginId, component, enabled);
        if (component === 'skills') {
          sessionManager?.invalidateSkillsSetup();
        }
        return result;
      } catch (error) {
        logError('[Plugins] Error toggling plugin component:', error);
        throw error;
      }
    }
  );

  ipcMain.handle('plugins.uninstall', async (_event, pluginId: string) => {
    try {
      if (!pluginRuntimeService) {
        throw new Error('PluginRuntimeService not initialized');
      }
      const result = await pluginRuntimeService.uninstall(pluginId);
      sessionManager?.invalidateSkillsSetup();
      return result;
    } catch (error) {
      logError('[Plugins] Error uninstalling plugin:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.doctor', async () => {
    try {
      const sources: SkillDoctorSkillSource[] = [];
      // Built-in skills (bundled with the app)
      const builtinDir = app.isPackaged
        ? join(process.resourcesPath, 'skills')
        : join(__dirname, '../../.claude', 'skills');
      sources.push(...loadSkillSourcesFromDir(builtinDir));
      // User skills directory
      const userDir = join(app.getPath('userData'), 'claude', 'skills');
      sources.push(...loadSkillSourcesFromDir(userDir));
      const contextWindow = Number(configStore.get('contextWindow')) || null;
      return { success: true, report: buildSkillDoctorReport(sources, contextWindow) };
    } catch (error) {
      logError('[IPC] Error building skill doctor report:', error);
      return { success: false, report: null };
    }
  });
}
