/**
 * @module main/ipc/skills-handlers
 *
 * Skills and plugin IPC channels (skills.*, plugins.*) plus the skills.doctor
 * self-check. Extracted from main/index.ts; the skills manager and session
 * manager handles are injected.
 */

import { app, ipcMain, shell } from 'electron';
import { readFileSync } from 'fs';
import { join } from 'path';
import { configStore } from '../config/config-store';
import { buildSkillDoctorReport, type SkillDoctorSkillSource } from '../mods/skill-doctor';
import { approveProposal, listProposals, rejectProposal } from '../skills/skill-proposals';
import { describeSkillRuntime } from '../skills/skill-runtime-view';
import { resolveRuntimeSkillSources } from '../skills/skill-runtime-sources';
import type { SkillRuntimeReport } from '../../shared/skill-runtime-types';
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
  // Resolved LAZILY, on every call. These were captured once at registration
  // time, but the main process assigns the manager later in startup (there are
  // two construction sites), so the captured values were permanently null and
  // every handler answered "Skills manager is still starting" forever. A getter
  // that never captured proved it: skills.getAll failed 42 times in one session
  // while the app itself was fine.
  const getSkills = (): SkillsManager | null => context.getSkillsManager();
  const getSession = (): SessionManager | null => context.getSessionManager();
  const getPlugins = (): PluginRuntimeService | null => context.getPluginRuntimeService();
  ipcMain.handle('skills.getAll', async () => {
    try {
      if (!getSkills()) {
        throw new Error('Skills manager is still starting');
      }
      return await getSkills()!.listSkills();
    } catch (error) {
      logError('[Skills] Error getting skills:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.getRuntimeView', async (): Promise<SkillRuntimeReport> => {
    try {
      const sources = await resolveRuntimeSkillSources(getPlugins());
      const enabledByName = new Map<string, boolean>();
      for (const skill of getSkills()?.getAllSkills() ?? []) {
        enabledByName.set(skill.name, skill.enabled);
      }
      const view = describeSkillRuntime(sources, (name) => enabledByName.get(name) ?? true);
      return { success: true, view };
    } catch (error) {
      logError('[Skills] Error building the runtime skill view:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('skills.install', async (_event, skillPath: string) => {
    try {
      if (!getSkills()) {
        throw new Error('SkillsManager not initialized');
      }
      const skill = await getSkills()!.installSkill(skillPath);
      getSession()?.invalidateSkillsSetup();
      return { success: true, skill };
    } catch (error) {
      logError('[Skills] Error installing skill:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.delete', async (_event, skillId: string) => {
    try {
      if (!getSkills()) {
        throw new Error('SkillsManager not initialized');
      }
      await getSkills()!.uninstallSkill(skillId);
      getSession()?.invalidateSkillsSetup();
      return { success: true };
    } catch (error) {
      logError('[Skills] Error deleting skill:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.setEnabled', async (_event, skillId: string, enabled: boolean) => {
    try {
      if (!getSkills()) {
        throw new Error('SkillsManager not initialized');
      }
      getSkills()!.setSkillEnabled(skillId, enabled);
      getSession()?.invalidateSkillsSetup();
      return { success: true };
    } catch (error) {
      logError('[Skills] Error toggling skill:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.validate', async (_event, skillPath: string) => {
    try {
      if (!getSkills()) {
        return { valid: false, errors: ['SkillsManager not initialized'] };
      }
      const result = await getSkills()!.validateSkillFolder(skillPath);
      return result;
    } catch (error) {
      logError('[Skills] Error validating skill:', error);
      return { valid: false, errors: ['Validation failed'] };
    }
  });

  ipcMain.handle('skills.getStoragePath', async () => {
    try {
      if (!getSkills()) {
        return null;
      }
      return getSkills()!.getGlobalSkillsPath();
    } catch (error) {
      logError('[Skills] Error getting storage path:', error);
      return null;
    }
  });

  ipcMain.handle('skills.setStoragePath', async (_event, targetPath: string, migrate = true) => {
    if (!getSkills()) {
      throw new Error('SkillsManager not initialized');
    }
    const result = await getSkills()!.setGlobalSkillsPath(targetPath, migrate !== false);
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
    if (!getSkills()) {
      throw new Error('SkillsManager not initialized');
    }
    const storagePath = getSkills()!.getGlobalSkillsPath();
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
      const activeDir = getSkills()
        ? getSkills()!.getGlobalSkillsPath()
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
      if (!getPlugins()) {
        throw new Error('PluginRuntimeService not initialized');
      }
      return await getPlugins()!.listCatalog(options);
    } catch (error) {
      logError('[Plugins] Error listing catalog:', error);
      throw error;
    }
  });

  ipcMain.handle('plugins.listInstalled', async () => {
    try {
      if (!getPlugins()) {
        throw new Error('PluginRuntimeService not initialized');
      }
      return getPlugins()!.listInstalled();
    } catch (error) {
      logError('[Plugins] Error listing installed plugins:', error);
      throw error;
    }
  });

  ipcMain.handle('plugins.install', async (_event, pluginName: string) => {
    try {
      if (!getPlugins()) {
        throw new Error('PluginRuntimeService not initialized');
      }
      const result = await getPlugins()!.install(pluginName);
      getSession()?.invalidateSkillsSetup();
      return result;
    } catch (error) {
      logError('[Plugins] Error installing plugin:', error);
      throw error;
    }
  });

  ipcMain.handle('plugins.setEnabled', async (_event, pluginId: string, enabled: boolean) => {
    try {
      if (!getPlugins()) {
        throw new Error('PluginRuntimeService not initialized');
      }
      const result = await getPlugins()!.setEnabled(pluginId, enabled);
      getSession()?.invalidateSkillsSetup();
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
        if (!getPlugins()) {
          throw new Error('PluginRuntimeService not initialized');
        }
        const result = await getPlugins()!.setComponentEnabled(pluginId, component, enabled);
        if (component === 'skills') {
          getSession()?.invalidateSkillsSetup();
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
      if (!getPlugins()) {
        throw new Error('PluginRuntimeService not initialized');
      }
      const result = await getPlugins()!.uninstall(pluginId);
      getSession()?.invalidateSkillsSetup();
      return result;
    } catch (error) {
      logError('[Plugins] Error uninstalling plugin:', error);
      throw error;
    }
  });

  ipcMain.handle('skills.doctor', async () => {
    try {
      // Analyse the same roots the agent loads, so the doctor and the
      // capability pane can never disagree about which skills exist. Disabled
      // skills are included on purpose — the report recommends which to switch
      // off, so hiding them would defeat it.
      const view = describeSkillRuntime(await resolveRuntimeSkillSources(getPlugins()));
      const sources: SkillDoctorSkillSource[] = [];
      for (const source of view.sources) {
        for (const skill of source.skills) {
          const skillFile = join(skill.path, 'SKILL.md');
          try {
            sources.push({
              name: skill.name,
              path: skillFile,
              content: readFileSync(skillFile, 'utf-8'),
            });
          } catch {
            // Unreadable skill — the doctor simply skips it.
          }
        }
      }
      const contextWindow = Number(configStore.get('contextWindow')) || null;
      return { success: true, report: buildSkillDoctorReport(sources, contextWindow) };
    } catch (error) {
      logError('[IPC] Error building skill doctor report:', error);
      return { success: false, report: null };
    }
  });
}
