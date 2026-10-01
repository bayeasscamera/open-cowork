/**
 * @module main/ipc/config-handlers
 *
 * Application configuration IPC channels (config.*). Extracted from
 * main/index.ts so the config mutation flow (persist → reload runner/sandbox →
 * notify renderer → export plaintext) lives with the rest of the IPC domains.
 */

import { ipcMain } from 'electron';
import {
  configStore,
  getPiAiModelPresets,
  type AppConfig,
  type CreateConfigSetPayload,
} from '../config/config-store';
import { exportOnConfigChange } from '../config/config-file-watcher';
import { runConfigApiTest } from '../config/config-test-routing';
import { listOllamaModels } from '../config/ollama-api';
import { log, logError } from '../utils/logger';
import { sendToRenderer } from '../events/renderer-sender';
import type {
  ApiTestInput,
  ApiTestResult,
  DiagnosticInput,
  ProviderModelInfo,
} from '../../shared/types';
import type { SecretSourceKind, SecretSourceProbe } from '../../shared/secret-source';
import { getSecretResolver } from '../config/secret-resolver';
import type { SessionManager } from '../session/session-manager';
import { getSharedProjectStore } from '../projects/project-store';
import { collectHealthReport } from '../utils/health-report-collector';

/** Accessors for app-level state owned by main/index.ts. */
interface ConfigIpcContext {
  getSessionManager(): SessionManager | null;
  applyBackgroundAccessSetting(enabled: boolean): void;
}

export function registerConfigIpcHandlers(context: ConfigIpcContext): void {
  // Config IPC handlers
  ipcMain.handle('config.get', () => {
    try {
      return configStore.getAll();
    } catch (error) {
      logError('[Config] Error getting config:', error);
      return {};
    }
  });

  ipcMain.handle('config.getPresets', () => {
    try {
      return getPiAiModelPresets();
    } catch (error) {
      logError('[Config] Error getting presets:', error);
      return [];
    }
  });

  const buildAgentRuntimeSignature = (config: AppConfig): string =>
    JSON.stringify({
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      customProtocol: config.customProtocol,
      model: config.model,
      enableThinking: config.enableThinking,
      memoryEnabled: config.memoryEnabled,
      memoryRuntime: config.memoryRuntime,
    });

  const syncConfigAfterMutation = async (previousConfig: AppConfig, context: ConfigIpcContext) => {
    const sessionManager = context.getSessionManager();
    // Mark as configured if any config set has usable credentials
    configStore.set('isConfigured', configStore.hasAnyUsableCredentials());

    // Apply to environment
    await configStore.applyToEnv();

    const updatedConfig = configStore.getAll();
    const shouldReloadRunner =
      buildAgentRuntimeSignature(previousConfig) !== buildAgentRuntimeSignature(updatedConfig);
    const shouldReloadSandbox = previousConfig.sandboxEnabled !== updatedConfig.sandboxEnabled;

    if (sessionManager) {
      if (shouldReloadRunner) {
        sessionManager.reloadConfig();
      }
      if (shouldReloadSandbox) {
        await sessionManager
          .reloadSandbox()
          .catch((err) => logError('[Config] Sandbox reload failed:', err));
      }
      if (shouldReloadRunner || shouldReloadSandbox) {
        log(
          '[Config] Session manager config synced:',
          JSON.stringify({
            runnerReloaded: shouldReloadRunner,
            sandboxReloaded: shouldReloadSandbox,
          })
        );
      }
    }

    // Notify renderer of config update
    const isConfigured = configStore.isConfigured();
    sendToRenderer({
      type: 'config.status',
      payload: {
        isConfigured,
        config: updatedConfig,
      },
    });
    log('[Config] Notified renderer of config update, isConfigured:', isConfigured);

    // Sync plaintext config file with updated safe fields
    exportOnConfigChange();

    return updatedConfig;
  };

  ipcMain.handle('config.save', async (_event, newConfig: Partial<AppConfig>) => {
    log('[Config] Saving config:', {
      ...newConfig,
      apiKey: newConfig.apiKey ? '***' : '',
      tavilyApiKey: newConfig.tavilyApiKey ? '***' : undefined,
      braveApiKey: newConfig.braveApiKey ? '***' : undefined,
      memoryRuntime: newConfig.memoryRuntime
        ? {
            ...newConfig.memoryRuntime,
            llm: newConfig.memoryRuntime.llm
              ? {
                  ...newConfig.memoryRuntime.llm,
                  apiKey: newConfig.memoryRuntime.llm.apiKey ? '***' : '',
                }
              : undefined,
            embedding: newConfig.memoryRuntime.embedding
              ? {
                  ...newConfig.memoryRuntime.embedding,
                  apiKey: newConfig.memoryRuntime.embedding.apiKey ? '***' : '',
                }
              : undefined,
          }
        : undefined,
    });

    const previousConfig = configStore.getAll();
    // Update config
    configStore.update(newConfig);
    const updatedConfig = await syncConfigAfterMutation(previousConfig, context);

    // Apply tray / global-shortcut background access immediately when toggled
    if (typeof newConfig.trayEnabled === 'boolean') {
      context.applyBackgroundAccessSetting(newConfig.trayEnabled);
    }

    return { success: true, config: updatedConfig };
  });

  ipcMain.handle('config.createSet', async (_event, payload: CreateConfigSetPayload) => {
    log('[Config] Creating config set:', payload);
    const previousConfig = configStore.getAll();
    configStore.createSet(payload);
    const updatedConfig = await syncConfigAfterMutation(previousConfig, context);
    return { success: true, config: updatedConfig };
  });

  ipcMain.handle('config.renameSet', async (_event, payload: { id: string; name: string }) => {
    log('[Config] Renaming config set:', payload);
    const previousConfig = configStore.getAll();
    configStore.renameSet(payload);
    const updatedConfig = await syncConfigAfterMutation(previousConfig, context);
    return { success: true, config: updatedConfig };
  });

  ipcMain.handle('config.deleteSet', async (_event, payload: { id: string }) => {
    log('[Config] Deleting config set:', payload);
    const previousConfig = configStore.getAll();
    configStore.deleteSet(payload);
    const updatedConfig = await syncConfigAfterMutation(previousConfig, context);
    return { success: true, config: updatedConfig };
  });

  ipcMain.handle('config.switchSet', async (_event, payload: { id: string }) => {
    log('[Config] Switching config set:', payload);
    const previousConfig = configStore.getAll();
    configStore.switchSet(payload);
    const updatedConfig = await syncConfigAfterMutation(previousConfig, context);
    return { success: true, config: updatedConfig };
  });

  ipcMain.handle('config.isConfigured', () => {
    try {
      return configStore.isConfigured();
    } catch (error) {
      logError('[Config] Error checking configured status:', error);
      return false;
    }
  });

  ipcMain.handle('config.test', async (_event, payload: ApiTestInput): Promise<ApiTestResult> => {
    try {
      return await runConfigApiTest(payload, configStore.getAll());
    } catch (error) {
      logError('[Config] API test failed:', error);
      return {
        ok: false,
        errorType: 'unknown',
        details: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    'config.listModels',
    async (
      _event,
      payload: { provider: AppConfig['provider']; apiKey: string; baseUrl?: string }
    ): Promise<ProviderModelInfo[]> => {
      if (payload.provider !== 'ollama') {
        return [];
      }
      return listOllamaModels(payload);
    }
  );

  ipcMain.handle('config.diagnose', async (_event, payload: DiagnosticInput) => {
    try {
      const { runDiagnostics } = await import('../config/api-diagnostics');
      return await runDiagnostics(payload);
    } catch (error) {
      logError('[Config] Error running diagnostics:', error);
      throw error;
    }
  });

  /**
   * Whole-app health report for the diagnostics page. The projection uses the
   * same global -> project -> session ladder as the agent runner, so the
   * credentials being probed are the ones a run would actually use.
   */
  ipcMain.handle(
    'diagnostics.report',
    (_event, payload?: { sessionId?: string | null }): unknown => {
      try {
        const session = payload?.sessionId
          ? context.getSessionManager()?.loadSession(payload.sessionId) ?? null
          : null;
        const project = session?.projectId
          ? getSharedProjectStore().get(session.projectId) ?? null
          : null;
        return collectHealthReport({ session, project });
      } catch (error) {
        logError('[Config] Error building the health report:', error);
        return collectHealthReport({});
      }
    }
  );

  ipcMain.handle('config.discover-local', async (_event, payload?: { baseUrl?: string }) => {
    try {
      const { discoverLocalOllama } = await import('../config/api-diagnostics');
      return await discoverLocalOllama(payload);
    } catch (error) {
      logError('[Config] Error discovering local services:', error);
      return [];
    }
  });

  // ── External secret sources (Bitwarden / 1Password) ────────────────────
  // Probing only reports presence + lock state. It never returns a secret, so
  // this channel is safe to call as often as the Settings UI likes.

  ipcMain.handle(
    'secrets.probeSource',
    async (_event, payload: { kind: SecretSourceKind }): Promise<SecretSourceProbe> => {
      try {
        return await getSecretResolver().probe(payload.kind);
      } catch (error) {
        logError('[Secrets] Probe failed:', error);
        return {
          installed: false,
          unlocked: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  /**
   * Resolve one ConfigSet's key from its configured source.
   *
   * Returns the resolved value so the "Test connection" button can prove an
   * external key really works. The value is returned to the renderer, which is
   * the user's own settings surface, and is never persisted by this handler.
   */
  ipcMain.handle(
    'secrets.testConfigSet',
    async (
      _event,
      payload: { configSetId: string }
    ): Promise<{ ok: boolean; detail: string }> => {
      try {
        const config = configStore.getAll();
        const configSet = config.configSets.find((set) => set.id === payload.configSetId);
        const storedApiKey =
          configSet?.profiles[configSet.activeProfileKey]?.apiKey ?? config.apiKey ?? '';
        const outcome = await getSecretResolver().resolveForConfigSet(
          payload.configSetId,
          config.secretSources,
          storedApiKey
        );
        if (outcome.error) {
          return { ok: false, detail: outcome.error.message };
        }
        return {
          ok: true,
          detail: outcome.fromLocal
            ? 'The key is stored locally in the encrypted config store.'
            : `Resolved from the external vault (${outcome.value ? `${outcome.value.length} characters` : 'empty'}).`,
        };
      } catch (error) {
        logError('[Secrets] Test failed:', error);
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  /** ConfigSets whose key is declared through more than one external source. */
  ipcMain.handle('secrets.getConflicts', () => {
    try {
      return getSecretResolver().findConflicts(configStore.getAll().secretSources);
    } catch (error) {
      logError('[Secrets] Conflict scan failed:', error);
      return [];
    }
  });

  /** Drop cached resolutions — called after the user re-locks or switches. */
  ipcMain.handle('secrets.invalidate', () => {
    try {
      getSecretResolver().invalidate();
      return { success: true };
    } catch (error) {
      logError('[Secrets] Invalidate failed:', error);
      return { success: false };
    }
  });
}
