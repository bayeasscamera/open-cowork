/**
 * @module main/index
 *
 * Electron main-process entry point.
 *
 * Responsibilities:
 * - App lifecycle: ready, activate, before-quit, window-will-close
 * - Central IPC hub: ~100 handlers namespaced as config.*, mcp.*, session.*,
 *   sandbox.*, logs.*, remote.*, schedule.*, etc.
 * - BrowserWindow creation and deep-link / protocol handling
 *
 * Renderer event routing lives in events/renderer-sender.ts; file reveal in
 * utils/reveal-in-folder.ts (both wired here via their context setters).
 *
 * Dependencies: session-manager, config-store, mcp-manager, sandbox-adapter,
 *               skills-manager, scheduled-task-manager, nav-server, remote-manager
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  nativeTheme,
  Tray,
  globalShortcut,
} from 'electron';
import { join, resolve } from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { config } from 'dotenv';
import { initDatabase, closeDatabase, getDatabase } from './db/database';
import { SessionManager } from './session/session-manager';
import { SkillsManager } from './skills/skills-manager';
import { PluginCatalogService } from './skills/plugin-catalog-service';
import { PluginRuntimeService } from './skills/plugin-runtime-service';
import { MemoryService } from './memory/memory-service';
import { MemoryExtension } from './memory/memory-extension';
import { ConfigExtension } from './config/config-extension';
import { SubagentExtension } from './agent/subagent-extension';
import { AgentRuntimeExtensionManager } from './extensions/agent-runtime-extension-manager';
import { configStore, type AppTheme } from './config/config-store';
import { startConfigFileWatcher, stopConfigFileWatcher } from './config/config-file-watcher';
import { decidePermission } from './config/permission-rules-store';
import { shutdownSandbox } from './sandbox/sandbox-adapter';
import { SandboxSync } from './sandbox/sandbox-sync';
import { getSandboxBootstrap } from './sandbox/sandbox-bootstrap';
import type { ClientEvent, ServerEvent } from '../shared/types';
import { remoteManager, type AgentExecutor } from './remote/remote-manager';
import { remoteConfigStore } from './remote/remote-config-store';
import { startNavServer, stopNavServer } from './nav-server';
import { ScheduledTaskManager } from './schedule/scheduled-task-manager';
import { createScheduledTaskStore } from './schedule/scheduled-task-store';
import {
  buildScheduledTaskFallbackTitle,
  buildScheduledTaskTitle,
} from '../shared/schedule/task-title';
import { NavigationUrlPolicy } from './utils/navigation-url-policy';
import {
  applyNativeThemePreference,
  DARK_BG,
  LIGHT_BG,
  resolveEffectiveTheme,
} from './utils/window-theme';
import {
  handleClientEvent as dispatchClientEvent,
  type ClientEventHandlerContext,
} from './ipc/client-event-handler';
import { getUnsupportedWorkspacePathReason } from './workspace-path-constraints';

import { log, logWarn, logError, closeLogFile, setDevLogsEnabled } from './utils/logger';
import { safeOpenExternal } from './utils/safe-open-external';
import { registerArtifactsIpcHandlers } from './ipc/artifacts-handlers';
import { registerConfigIpcHandlers } from './ipc/config-handlers';
import { registerLogsIpcHandlers } from './ipc/logs-handlers';
import { registerMcpIpcHandlers } from './ipc/mcp-handlers';
import { registerRemoteIpcHandlers } from './ipc/remote-handlers';
import { registerScheduleIpcHandlers } from './ipc/schedule-handlers';
import { registerMemoryIpcHandlers } from './ipc/memory-handlers';
import { registerSandboxIpcHandlers } from './ipc/sandbox-handlers';
import { registerSkillsIpcHandlers } from './ipc/skills-handlers';
import { registerWindowIpcHandlers } from './ipc/window-handlers';
import { registerModsIpcHandlers } from './ipc/mods-handlers';
import { registerWorkflowIpcHandlers } from './ipc/workflow-handlers';
import { registerProjectMemoryIpcHandlers } from './ipc/project-memory-handlers';
import { registerControlCenterIpcHandlers } from './ipc/control-center-handlers';
import { registerModelRoutingIpcHandlers } from './ipc/model-routing-handlers';
import { registerMetricsIpcHandlers } from './ipc/metrics-handlers';
import { WorkflowRegistry, DEFAULT_PERSIST_DEBOUNCE_MS } from './agent/workflow-registry';
import { ControlCenterService } from './agent/control-center-service';
import { ModelRoutingService, type ModelRoutingSnapshot } from './agent/model-routing-service';
import type { TaskQueue } from './agent/task-queue';
import { WorkflowPersistence } from './agent/workflow-persistence';
import { MetricsHistory } from './agent/metrics-harness';
import { createScenarioAgentRunner } from './agent/scenario-runner';
import { createAgentTaskRunner } from './agent/agent-task-runner';
import { createShellProofRunner } from './agent/proof-runner';
import type { ProjectMemoryStore } from './memory/project-memory-store';
import { getModsRegistry } from './mods/mods-runtime';
import { createBuiltinMods } from './mods/builtin-mods';
import { createProjectStore, ProjectStore } from './projects/project-store';
import {
  delegationNotifyEnabled,
  resumeInterruptedDelegations,
} from './agent/background-delegations';

import { sendToRenderer, setRendererSenderContext } from './events/renderer-sender';
import { revealFileInFolder, setRevealContext } from './utils/reveal-in-folder';

import {
  parseHeadlessArgs,
  redirectConsoleToStderr,
  createHeadlessSendToRenderer,
  contentBlocksToText,
  emitSessionStarted,
  emitSessionEnded,
  emitHeadlessReady,
  readStdinPrompt,
  startRpcLoop,
  writeResultFileAtomic,
} from './cli/headless-io';
import { CrashGuard } from './utils/crash-guard';
import {
  BackgroundJobRegistry,
  migrateLegacyDynamicSkillsToProposals,
} from './tools/dynamic-tool-creator';

// Initialize Global Crash & Robustness Guardian
CrashGuard.initialize();

// Current working directory (persisted between sessions)
let currentWorkingDir: string | null = null;

// Load .env file from project root (for development)
const envPath = resolve(__dirname, '../../.env');
log('[dotenv] Loading from:', envPath);
const dotenvResult = config({ path: envPath });
if (dotenvResult.error) {
  logWarn('[dotenv] Failed to load .env:', dotenvResult.error.message);
} else {
  log('[dotenv] Loaded successfully');
}

// Apply saved config (this overrides .env if config exists)
if (configStore.isConfigured()) {
  log('[Config] Applying saved configuration...');
  configStore.applyToEnv();
}

// Enable Metal / Hardware Acceleration on macOS for 60/120Hz ProMotion smoothness
if (process.platform !== 'darwin') {
  app.disableHardwareAcceleration();
} else {
  // Apple Silicon performance flags
  app.commandLine.appendSwitch('enable-accelerated-mjpeg-decode');
  app.commandLine.appendSwitch('enable-accelerated-video-decode');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
}

let mainWindow: BrowserWindow | null = null;
let sessionManager: SessionManager | null = null;
let skillsManager: SkillsManager | null = null;
let pluginRuntimeService: PluginRuntimeService | null = null;
let memoryService: MemoryService | null = null;
let scheduledTaskManager: ScheduledTaskManager | null = null;
let projectStore: ProjectStore | null = null;

/** Lazily wire the ProjectStore over the database once it is initialized. */
function getProjectStore(): ProjectStore {
  if (!projectStore) {
    projectStore = createProjectStore(getDatabase());
  }
  return projectStore;
}

// Wire the extracted modules to the mutable app-level singletons above.
setRendererSenderContext({
  getMainWindow: () => mainWindow,
  getEventSender: () => eventSender,
  getSessionManager: () => sessionManager,
  getDelegationNotifyEnabled: () => delegationNotifyEnabled(),
});
setRevealContext({
  getWorkingDir: () => currentWorkingDir,
});

/**
 * Tool names that a spawned subagent may never invoke, regardless of what
 * `decidePermission` returns. Subagents run non-interactively — there is no
 * user present to answer a permission prompt — so for tools whose whole
 * purpose is to require interactive approval (like `config_write`, which
 * mutates persisted app configuration), the only safe non-interactive
 * decision is `deny`. This intentionally overrides even an explicit
 * `'allow'` permission rule: config writes must always go through the
 * interactive dialog in the top-level session, never through a background
 * subagent.
 */
const SUBAGENT_ALWAYS_DENIED_TOOLS = new Set<string>(['config_write']);

/**
 * Resolve the allow/deny decision for a tool call made by a spawned
 * subagent. Delegates to the shared `decidePermission` rules cache, but
 * hard-denies tools in `SUBAGENT_ALWAYS_DENIED_TOOLS` first — see that
 * constant's docstring for why.
 */
function resolveSubagentToolPermission(
  toolName: string,
  toolInput: Record<string, unknown>
): 'allow' | 'deny' {
  if (SUBAGENT_ALWAYS_DENIED_TOOLS.has(toolName)) {
    return 'deny';
  }
  const decision = decidePermission('subagent', toolName, toolInput);
  return decision === 'deny' ? 'deny' : 'allow';
}

async function verifyGeminiRuntimeForSmokeTest(): Promise<void> {
  const { completeSimple, getModel } = await import('@mariozechner/pi-ai');
  const model = getModel('google', 'gemini-2.5-flash');
  if (!model) {
    throw new Error('Gemini smoke-test model is missing from the pi-ai registry');
  }

  // Abort before dispatch so this loads the packaged Gemini provider and SDK
  // without sending a network request or requiring a real API key.
  const controller = new AbortController();
  controller.abort();
  const result = await completeSimple(
    model,
    {
      systemPrompt: 'smoke',
      messages: [{ role: 'user', content: 'smoke', timestamp: Date.now() }],
    },
    { apiKey: 'smoke-test-key', signal: controller.signal }
  );

  if (result.stopReason !== 'aborted') {
    throw new Error(`Gemini provider smoke test returned ${result.stopReason}`);
  }
}

async function resolveScheduledTaskTitle(
  prompt: string,
  _cwd?: string,
  fallbackTitle?: string
): Promise<string> {
  const normalizedPrompt = prompt.trim();
  const fallback = fallbackTitle
    ? buildScheduledTaskTitle(fallbackTitle)
    : buildScheduledTaskFallbackTitle(normalizedPrompt);
  if (!sessionManager) {
    return fallback;
  }
  try {
    return await sessionManager.generateScheduledTaskTitle(normalizedPrompt);
  } catch (error) {
    logWarn('[Schedule] Failed to generate title via session title flow, using fallback', error);
    return fallback;
  }
}

async function waitForDevServer(url: string, maxAttempts = 30, intervalMs = 500): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        if (attempt > 1) {
          log(`[App] Dev server ready after ${attempt} attempt(s): ${url}`);
        }
        return true;
      }
    } catch {
      // Ignore and retry until timeout
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  logWarn(`[App] Dev server did not become ready within timeout: ${url}`);
  return false;
}

// Single-instance lock: skip in dev mode so vite-plugin-electron can restart freely
// without the old process blocking the new one during async cleanup.
const isDev = !!process.env.VITE_DEV_SERVER_URL;
const ELECTRON_DEVTOOLS_DEBUG_PORT = '9223';

// Enable Chrome DevTools Protocol in dev mode so the renderer can be inspected
// via chrome://inspect or connected to by Puppeteer/Playwright at localhost:9223.
// Chrome MCP uses 9222, so keep Electron on a separate port in development.
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', ELECTRON_DEVTOOLS_DEBUG_PORT);
  app.commandLine.appendSwitch(
    'remote-allow-origins',
    `http://localhost:${ELECTRON_DEVTOOLS_DEBUG_PORT}`
  );
}

// COWORK_MULTI_INSTANCE=1 bypasses the lock for measurement/automation runs
// (headless benchmarks beside an active GUI session). Never the default.
const hasSingleInstanceLock =
  isDev || process.env.COWORK_MULTI_INSTANCE === '1' || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  logWarn('[App] Another instance is already running, quitting this instance');
  app.quit();
} else if (!isDev) {
  app.on('second-instance', () => {
    const existingWindow =
      mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());

    if (!existingWindow) {
      log('[App] No existing window found, creating new one');
      createWindow();
      return;
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = existingWindow;
    }
    if (existingWindow.isMinimized()) {
      existingWindow.restore();
    }
    existingWindow.show();
    existingWindow.focus();
    log('[App] Blocked second instance and focused existing window');
  });
}

// Tray instance (kept alive to prevent GC)
let tray: Tray | null = null;

function buildMacMenu() {
  if (process.platform !== 'darwin') return;

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences…',
          accelerator: 'CmdOrCtrl+,',
          click: () =>
            mainWindow?.webContents.send('server-event', { type: 'navigate', payload: 'settings' }),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }, { type: 'separator' }, { role: 'front' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function setupTray() {
  if (!configStore.get('trayEnabled')) return;
  if (tray) return;

  // Use .ico on Windows for proper multi-resolution tray support; fall back to .png if absent
  const iconName =
    process.platform === 'darwin'
      ? 'tray-iconTemplate.png'
      : process.platform === 'win32'
        ? 'tray-icon.ico'
        : 'tray-icon.png';
  // TODO: create resources/tray-icon.ico from tray-icon.png for full Windows tray fidelity
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, iconName)
    : join(__dirname, '../../resources', iconName);

  // On Windows, fall back to .png if the .ico file has not been created yet
  const resolvedIconPath =
    process.platform === 'win32' && !fs.existsSync(iconPath)
      ? app.isPackaged
        ? join(process.resourcesPath, 'tray-icon.png')
        : join(__dirname, '../../resources', 'tray-icon.png')
      : iconPath;

  // Gracefully skip tray if icon is missing (e.g. dev environment)
  if (!fs.existsSync(resolvedIconPath)) {
    log('[Tray] Icon not found at', resolvedIconPath, '— skipping tray setup');
    return;
  }

  tray = new Tray(resolvedIconPath);
  tray.setToolTip('Open Cowork');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide Window',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow();
        } else if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'New Session',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('server-event', { type: 'new-session' });
        }
      },
    },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          mainWindow.webContents.send('server-event', { type: 'navigate', payload: 'settings' });
        }
      },
    },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
    } else if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Global window-toggle shortcut (Alt+Space, Spotlight/Raycast style) — part of the
// "background quick access" bundle with the tray, so it is gated by the same
// setting: without a tray icon, a hidden window would be unreachable on
// platforms without a persistent Dock.
let windowToggleAccelerator: string | null = null;

function registerWindowToggleShortcut(): void {
  if (windowToggleAccelerator) return;
  try {
    const toggleWindow = () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
      } else if (mainWindow.isVisible() && mainWindow.isFocused()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    };

    // Never plain Alt+Space: on French keyboards Alt+Espace is the
    // non-breaking-space keystroke, and a global shortcut on it hides the
    // window while the user is typing (reported as "the app hides itself").
    if (globalShortcut.register('CommandOrControl+Alt+Space', toggleWindow)) {
      windowToggleAccelerator = 'CommandOrControl+Alt+Space';
      log('[Shortcut] Registered CommandOrControl+Alt+Space global toggle shortcut');
    } else {
      logWarn(
        '[Shortcut] CommandOrControl+Alt+Space occupied, trying CommandOrControl+Shift+Space'
      );
      if (globalShortcut.register('CommandOrControl+Shift+Space', toggleWindow)) {
        windowToggleAccelerator = 'CommandOrControl+Shift+Space';
      }
    }
  } catch (shortcutErr) {
    logWarn('[Shortcut] Failed to register global shortcut:', shortcutErr);
  }
}

function unregisterWindowToggleShortcut(): void {
  if (!windowToggleAccelerator) return;
  try {
    globalShortcut.unregister(windowToggleAccelerator);
  } catch (error) {
    logWarn('[Shortcut] Failed to unregister global shortcut:', error);
  }
  windowToggleAccelerator = null;
}

/** Apply the trayEnabled setting at startup or on config change. */
function applyBackgroundAccessSetting(enabled: boolean): void {
  if (enabled) {
    setupTray();
    registerWindowToggleShortcut();
  } else {
    tray?.destroy();
    tray = null;
    unregisterWindowToggleShortcut();
  }
}

function getSavedThemePreference(): AppTheme {
  const theme = configStore.get('theme');
  return theme === 'dark' || theme === 'system' ? theme : 'light';
}

function createWindow() {
  const savedTheme = getSavedThemePreference();
  applyNativeThemePreference(savedTheme);
  const effectiveTheme = resolveEffectiveTheme(savedTheme);
  const THEME =
    effectiveTheme === 'dark'
      ? {
          background: DARK_BG,
          titleBar: DARK_BG,
          titleBarSymbol: '#f1ece4',
        }
      : {
          background: LIGHT_BG,
          titleBar: LIGHT_BG,
          titleBarSymbol: '#1a1a1a',
        };

  // Platform-specific window configuration
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';

  // Base window options
  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: THEME.background,
    icon: (() => {
      const windowIconName = isMac ? 'icon.icns' : isWindows ? 'icon.ico' : 'icon.png';
      return app.isPackaged
        ? join(process.resourcesPath, windowIconName)
        : join(__dirname, `../../resources/${windowIconName}`);
    })(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  };

  if (isMac) {
    // macOS: Use hiddenInset for native traffic light buttons
    windowOptions.titleBarStyle = 'hiddenInset';
    windowOptions.trafficLightPosition = { x: 16, y: 12 };
  } else if (isWindows) {
    // Windows: Use frameless window with custom titlebar
    // Note: frame: false removes native frame, allowing custom titlebar
    windowOptions.frame = false;
  } else {
    // Linux: Use frameless window
    windowOptions.frame = false;
  }

  mainWindow = new BrowserWindow(windowOptions);

  const navigationPolicy = new NavigationUrlPolicy(process.env.VITE_DEV_SERVER_URL);

  async function revealNavigationTarget(url: string): Promise<boolean> {
    const localPath = navigationPolicy.extractLocalPath(url);
    if (!localPath) {
      return false;
    }
    return revealFileInFolder(localPath);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const localPath = navigationPolicy.extractLocalPath(url);
    if (localPath) {
      void revealNavigationTarget(url);
      return { action: 'deny' };
    }
    if (navigationPolicy.isExternalUrl(url)) {
      void safeOpenExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const localPath = navigationPolicy.extractLocalPath(url);
    if (localPath) {
      event.preventDefault();
      void revealNavigationTarget(url);
      return;
    }
    if (navigationPolicy.isExternalUrl(url)) {
      event.preventDefault();
      void safeOpenExternal(url);
    }
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    void (async () => {
      await waitForDevServer(devServerUrl, 40, 500);
      if (!mainWindow || mainWindow.isDestroyed()) return;

      try {
        await mainWindow.loadURL(devServerUrl);
      } catch (error) {
        logError('[App] Failed to load dev server URL:', error);
      }
    })();
    // mainWindow.webContents.openDevTools(); // Commented out - open manually with Cmd+Option+I if needed
  } else {
    mainWindow.loadFile(join(__dirname, '../../dist/index.html'));
  }

  // macOS: intercept the close button — call app.quit() instead of hiding
  // This prevents the app from lingering as a zombie process after the window is closed
  mainWindow.on('close', () => {
    if (!isCleaningUp) {
      log('[App] Window close requested — starting quit sequence');
      // Independent hard failsafe: whatever happens inside before-quit or the
      // cleanup chain, the process must die within 9s of a close request.
      // (The before-quit failsafe only exists if that handler actually runs.)
      const hardKillTimer = setTimeout(() => {
        logError('[App] Quit sequence did not finish — forcing exit');
        process.exit(0);
      }, 9000);
      hardKillTimer.unref?.();
      app.once('will-quit', () => clearTimeout(hardKillTimer));
      app.quit();
    } else {
      log('[App] Window close ignored: cleanup already in progress');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Notify renderer about config status after window is ready
  mainWindow.webContents.on('did-finish-load', () => {
    const isConfigured = configStore.isConfigured();
    log('[Config] Notifying renderer, isConfigured:', isConfigured);
    sendToRenderer({
      type: 'config.status',
      payload: {
        isConfigured,
        config: configStore.getAll(),
      },
    });

    // Send current working directory to renderer
    sendToRenderer({
      type: 'workdir.changed',
      payload: { path: currentWorkingDir || '' },
    });

    // Start sandbox bootstrap after window is loaded
    startSandboxBootstrap();
  });
}

/**
 * Initialize default working directory
 * This is always the app's default_working_dir in userData - it never changes
 * Each session can have its own cwd that differs from this default
 */
function initializeDefaultWorkingDir(): string {
  // Create default working directory in user data path (this is the permanent global default)
  const userDataPath = app.getPath('userData');
  const defaultDir = join(userDataPath, 'default_working_dir');

  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
    log('[App] Created default working directory:', defaultDir);
  }

  currentWorkingDir = defaultDir;

  log('[App] Global default working directory:', currentWorkingDir);
  return currentWorkingDir;
}

/**
 * Get current working directory
 */
function getWorkingDir(): string | null {
  return currentWorkingDir;
}

function getWorkspacePathUnsupportedReason(workspacePath?: string): string | null {
  return getUnsupportedWorkspacePathReason({
    platform: process.platform,
    sandboxEnabled: configStore.get('sandboxEnabled') !== false,
    workspacePath,
  });
}

/**
 * Set working directory
 * - If sessionId is provided: update only that session's cwd (for switching directories within a chat)
 * - If no sessionId: update UI display only (for WelcomeView - will be used when creating new session)
 *
 * Note: The global default (currentWorkingDir) is NEVER changed after initialization.
 * It is always app.getPath('userData')/default_working_dir
 */
async function setWorkingDir(
  newDir: string,
  sessionId?: string
): Promise<{ success: boolean; path: string; error?: string }> {
  const unsupportedReason = getWorkspacePathUnsupportedReason(newDir);
  if (unsupportedReason) {
    return { success: false, path: newDir, error: unsupportedReason };
  }

  if (!fs.existsSync(newDir)) {
    return { success: false, path: newDir, error: 'Directory does not exist' };
  }

  if (sessionId && sessionManager) {
    // Update only this session's cwd - don't change the global default
    log('[App] Updating session cwd:', sessionId, '->', newDir);
    sessionManager.updateSessionCwd(sessionId, newDir);

    // Clear this session's sandbox mapping so next query uses the new directory
    SandboxSync.clearSession(sessionId);
    const { LimaSync } = await import('./sandbox/lima-sync');
    LimaSync.clearSession(sessionId);
  }

  // Notify renderer of workdir change (for UI display)
  // This updates what the user sees, and will be passed to startSession for new sessions
  sendToRenderer({
    type: 'workdir.changed',
    payload: { path: newDir },
  });

  log(
    '[App] Working directory for UI updated:',
    newDir,
    sessionId ? `(session: ${sessionId})` : '(pending new session)'
  );

  return { success: true, path: newDir };
}

/**
 * Start sandbox bootstrap in the background
 * This pre-initializes WSL/Lima environment at app startup
 */
async function startSandboxBootstrap(): Promise<void> {
  // Skip sandbox bootstrap if disabled - use native mode directly
  const sandboxEnabled = configStore.get('sandboxEnabled');
  if (sandboxEnabled === false) {
    log('[App] Sandbox disabled, skipping bootstrap (using native mode)');
    return;
  }

  const bootstrap = getSandboxBootstrap();

  // Skip if already complete
  if (bootstrap.isComplete()) {
    log('[App] Sandbox bootstrap already complete');
    return;
  }

  // Set up progress callback to notify renderer
  bootstrap.setProgressCallback((progress) => {
    sendToRenderer({
      type: 'sandbox.progress',
      payload: progress,
    });
  });

  // Start bootstrap (non-blocking)
  log('[App] Starting sandbox bootstrap...');
  try {
    const result = await bootstrap.bootstrap();
    log('[App] Sandbox bootstrap complete:', result.mode);
  } catch (error) {
    logError('[App] Sandbox bootstrap error:', error);
  }
}

// Pluggable event sender — defaults to mainWindow IPC, swapped for JSONL in headless mode
let eventSender: ((event: ServerEvent) => void) | null = null;

// Initialize app
app
  .whenReady()
  .then(async () => {
    // Smoke test mode: verify the app can start, then exit cleanly
    if (process.argv.includes('--smoke-test')) {
      log('[SmokeTest] App launched successfully in smoke test mode');
      log('[SmokeTest] Platform:', process.platform, 'Arch:', process.arch);
      log('[SmokeTest] Electron:', process.versions.electron, 'Node:', process.versions.node);
      try {
        // Verify critical native modules load
        require('better-sqlite3');
        log('[SmokeTest] better-sqlite3: OK');
      } catch (e) {
        log('[SmokeTest] FAIL: better-sqlite3 failed to load:', e);
        process.exit(1);
      }
      try {
        await verifyGeminiRuntimeForSmokeTest();
        log('[SmokeTest] Gemini provider runtime: OK');
      } catch (e) {
        log('[SmokeTest] FAIL: Gemini provider runtime failed to load:', e);
        process.exit(1);
      }
      log('[SmokeTest] PASSED');
      process.exit(0);
    }

    // ── Headless mode ──────────────────────────────────────────────────
    const headlessArgs = parseHeadlessArgs();

    if (headlessArgs.headless) {
      // Redirect console.log/warn to stderr so stdout stays clean JSONL
      redirectConsoleToStderr();

      log('[Headless] Starting in headless mode');
      log('[Headless] Args:', JSON.stringify(headlessArgs));

      // Detached delegations read their outcome from this file; the parent
      // appends it atomically so it is never observed half-written.
      const headlessResultFile = headlessArgs.resultFile;
      /** Last assistant message seen — the detached task's real output. */
      let headlessFinalOutput = '';
      const writeHeadlessResult = (
        status: 'completed' | 'failed',
        sessionId?: string,
        error?: string
      ): void => {
        if (!headlessResultFile) return;
        const result: Parameters<typeof writeResultFileAtomic>[1] = {
          status,
          finishedAt: Date.now(),
        };
        if (sessionId) result.sessionId = sessionId;
        if (error) result.error = error;
        if (headlessFinalOutput) result.output = headlessFinalOutput;
        writeResultFileAtomic(headlessResultFile, result);
      };

      if (headlessArgs.autoApprove) {
        process.stderr.write(
          '\n⚠️  WARNING: --auto-approve is active. ALL tool calls (file writes, shell commands, network) will be approved without confirmation.\n\n'
        );
      }

      // Validate --cwd before proceeding
      const cwdUnsupported = getWorkspacePathUnsupportedReason(headlessArgs.cwd);
      if (cwdUnsupported) {
        process.stderr.write(`Error: --cwd path is invalid: ${cwdUnsupported}\n`);
        process.exit(1);
        return;
      }
      const fs = await import('fs');
      if (!fs.existsSync(headlessArgs.cwd)) {
        process.stderr.write(`Error: --cwd path does not exist: ${headlessArgs.cwd}\n`);
        process.exit(1);
        return;
      }

      // Apply dev logs setting
      setDevLogsEnabled(configStore.get('enableDevLogs'));

      // Start config file watcher for bidirectional sync
      startConfigFileWatcher();
      const db = initDatabase();

      pluginRuntimeService = new PluginRuntimeService(new PluginCatalogService());
      memoryService = new MemoryService(db, {
        personalHost: {
          // Same trusted local account as the desktop path; headless runs on
          // this machine share the installation's memory store.
          owner: 'local-installation',
          isSessionEnabled: (sessionId) =>
            !remoteManager.isRemoteSession(sessionId) &&
            db.sessions.get(sessionId)?.memory_enabled === 1,
          // No confirmDelete in headless: deletions fail closed with
          // confirmation_required instead of being auto-approved.
        },
      });
      const headlessExtensionManager = new AgentRuntimeExtensionManager([
        new MemoryExtension(memoryService),
        new ConfigExtension(configStore),
        new SubagentExtension(
          () => sessionManager?.getMCPManager() ?? null,
          sendToRenderer,
          async (toolName, toolInput) =>
            resolveSubagentToolPermission(toolName, toolInput as Record<string, unknown>),
          undefined,
          controlCenterService.queue
        ),
      ]);

      // Build the JSONL sender with permission interception BEFORE constructing SessionManager
      const headlessSendToRenderer = createHeadlessSendToRenderer();
      // Mutable interceptor: set in stdio mode to route events to StdioChannel
      let stdioEventInterceptor: ((event: ServerEvent) => void) | null = null;
      const headlessSendWithPermission = (event: ServerEvent) => {
        if (event.type === 'stream.message' && event.payload.message.role === 'assistant') {
          headlessFinalOutput = contentBlocksToText(event.payload.message.content);
        }
        if (event.type === 'permission.request') {
          const { toolUseId } = event.payload;
          const result = headlessArgs.autoApprove ? 'allow' : 'deny';
          log(
            `[Headless] Permission ${result} for ${event.payload.toolName} (auto-approve=${headlessArgs.autoApprove})`
          );
          setTimeout(() => {
            sessionManager?.handlePermissionResponse(toolUseId, result);
          }, 0);
        }
        if (event.type === 'sudo.password.request') {
          const { toolUseId } = event.payload;
          log('[Headless] Sudo password request denied (headless mode)');
          setTimeout(() => {
            sessionManager?.handleSudoPasswordResponse(toolUseId, null);
          }, 0);
        }
        // Route to stdio channel if interceptor is set (must come before headlessSendToRenderer
        // because headlessSendToRenderer writes JSONL to stdout which conflicts with stdio events)
        if (stdioEventInterceptor) {
          stdioEventInterceptor(event);
          return;
        }
        headlessSendToRenderer(event);
      };

      // Set the global event sender so handleClientEvent's sendToRenderer calls
      // go through JSONL instead of the null mainWindow
      eventSender = headlessSendWithPermission;

      sessionManager = new SessionManager(
        db,
        headlessSendWithPermission,
        pluginRuntimeService,
        headlessExtensionManager
      );
      attachAgentServices(sessionManager);

      skillsManager = new SkillsManager(db, {
        getConfiguredGlobalSkillsPath: () => configStore.get('globalSkillsPath') || '',
        setConfiguredGlobalSkillsPath: (nextPath: string) => {
          configStore.update({ globalSkillsPath: nextPath });
        },
        watchStorage: false, // No renderer to notify in headless mode
      });

      // Set working directory from --cwd flag
      currentWorkingDir = headlessArgs.cwd;
      log('[Headless] Working directory:', currentWorkingDir);

      // Initialize scheduled task manager (runs in background)
      const headlessScheduledTaskStore = createScheduledTaskStore(db);
      scheduledTaskManager = new ScheduledTaskManager({
        store: headlessScheduledTaskStore,
        executeTask: async (task) => {
          if (!sessionManager) {
            throw new Error('Session manager not initialized');
          }
          const unsupportedReason = getWorkspacePathUnsupportedReason(task.cwd);
          if (unsupportedReason) {
            throw new Error(unsupportedReason);
          }
          const fallbackTitle = buildScheduledTaskFallbackTitle(task.prompt);
          const needsRegeneratedTitle = !task.title?.trim() || task.title === fallbackTitle;
          const title = needsRegeneratedTitle
            ? await resolveScheduledTaskTitle(task.prompt, task.cwd, task.title)
            : buildScheduledTaskTitle(task.title);
          if (title !== task.title) {
            headlessScheduledTaskStore.update(task.id, { title });
          }
          await sessionManager.startSession(title, task.prompt, task.cwd);
          return { sessionId: '' };
        },
        onTaskError: (taskId, error) => {
          headlessSendWithPermission({
            type: 'scheduled-task.error',
            payload: { taskId, error },
          });
        },
        now: () => Date.now(),
      });
      scheduledTaskManager.start();

      // Headless cleanup on exit signals
      const headlessCleanup = async () => {
        log('[Headless] Cleaning up...');
        stopConfigFileWatcher();
        scheduledTaskManager?.stop();
        try {
          const mcpManager = sessionManager?.getMCPManager();
          if (mcpManager) {
            await mcpManager.shutdown();
          }
        } catch (e) {
          logError('[Headless] MCP shutdown error:', e);
        }
        try {
          closeDatabase();
        } catch (e) {
          logError('[Headless] DB close error:', e);
        }
        closeLogFile();
      };

      // Handle SIGTERM/SIGINT for headless mode
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.on(sig, async () => {
          log(`[Headless] Received ${sig}`);
          // Stop all active sessions
          if (sessionManager) {
            const sessions = sessionManager.listSessions();
            for (const s of sessions) {
              if (s.status === 'running') {
                try {
                  await sessionManager.stopSession(s.id);
                } catch {
                  // Best effort
                }
              }
            }
          }
          await headlessCleanup();
          process.exit(0);
        });
      }

      // Helper: wait for a session to reach idle/error state
      const waitForSessionCompletion = (sessionId: string): Promise<void> =>
        new Promise((resolve) => {
          const checkInterval = setInterval(() => {
            let sessions: ReturnType<NonNullable<typeof sessionManager>['listSessions']>;
            try {
              sessions = sessionManager!.listSessions();
            } catch {
              // The database may already be closed by a parallel shutdown
              // (e.g. app.quit() during a long-running tool): stop polling
              // instead of crashing the timer (observed: "database connection
              // is not open" uncaught exception during headless runs).
              clearInterval(checkInterval);
              resolve();
              return;
            }
            const current = sessions.find((s) => s.id === sessionId);
            if (!current || current.status === 'idle' || current.status === 'error') {
              clearInterval(checkInterval);
              resolve();
            }
          }, 500);
          // Clear interval on process exit to avoid firing during cleanup
          for (const sig of ['SIGTERM', 'SIGINT'] as const) {
            process.once(sig, () => clearInterval(checkInterval));
          }
        });

      if (headlessArgs.prompt) {
        // ── Single-shot mode: run prompt, stream output, exit ──
        log('[Headless] Single-shot mode with prompt');

        if (!configStore.hasUsableCredentialsForActiveSet()) {
          writeHeadlessResult('failed', undefined, 'No usable API credentials configured.');
          headlessSendWithPermission({
            type: 'error',
            payload: {
              message: 'No usable API credentials configured. Run the GUI to set up API keys.',
              code: 'CONFIG_REQUIRED_ACTIVE_SET',
            },
          });
          await headlessCleanup();
          process.exit(1);
          return;
        }

        try {
          const session = await sessionManager.startSession(
            'Headless Session',
            headlessArgs.prompt,
            headlessArgs.cwd
          );
          emitSessionStarted(session.id);
          await waitForSessionCompletion(session.id);
          emitSessionEnded(session.id);
          writeHeadlessResult('completed', session.id);
          await headlessCleanup();
          process.exit(0);
        } catch (err) {
          logError('[Headless] Session error:', err);
          const message = err instanceof Error ? err.message : String(err);
          writeHeadlessResult('failed', undefined, message);
          headlessSendWithPermission({
            type: 'error',
            payload: {
              message,
            },
          });
          await headlessCleanup();
          process.exit(1);
        }
      } else if (headlessArgs.mode === 'rpc') {
        // ── RPC mode: read ClientEvent JSONL from stdin, keep running ──
        log('[Headless] RPC mode — reading JSONL from stdin');
        emitHeadlessReady();

        startRpcLoop(async (event) => {
          // Guard GUI-only operations in headless mode
          if (event.type === 'folder.select' || event.type === 'workdir.select') {
            throw new Error(`${event.type} is not supported in headless mode`);
          }
          return handleClientEvent(event);
        });

        // Process stays alive until stdin closes or signal received
      } else if (headlessArgs.mode === 'stdio') {
        // ── Stdio channel mode: session-based RPC via RemoteManager ──
        log('[Headless] Stdio channel mode');

        if (!configStore.hasUsableCredentialsForActiveSet()) {
          headlessSendWithPermission({
            type: 'error',
            payload: {
              message: 'No usable API credentials configured. Run the GUI to set up API keys.',
              code: 'CONFIG_REQUIRED_ACTIVE_SET',
            },
          });
          await headlessCleanup();
          process.exit(1);
          return;
        }

        // Set up RemoteManager with StdioChannel
        const stdioAgentExecutor: AgentExecutor = {
          startSession: async (title, prompt, cwd) => {
            if (!sessionManager) throw new Error('Session manager not initialized');
            const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
            if (unsupportedReason) {
              throw new Error(unsupportedReason);
            }
            return sessionManager.startSession(title, prompt, cwd);
          },
          continueSession: async (sessionId, prompt, content) => {
            if (!sessionManager) throw new Error('Session manager not initialized');
            await sessionManager.continueSession(sessionId, prompt, content);
          },
          stopSession: async (sessionId) => {
            if (!sessionManager) throw new Error('Session manager not initialized');
            await sessionManager.stopSession(sessionId);
          },
          validateWorkingDirectory: (cwd) => {
            return getWorkspacePathUnsupportedReason(cwd) || null;
          },
        };
        remoteManager.setAgentExecutor(stdioAgentExecutor);
        remoteManager.setRendererCallback(headlessSendWithPermission);

        const stdioChannel = await remoteManager.startStdioMode(headlessArgs.cwd);

        // Set the interceptor so ALL events from SM flow through stdio routing
        // (fixes the dead-code issue: SM calls headlessSendWithPermission directly,
        // which now checks stdioEventInterceptor before writing JSONL)
        stdioEventInterceptor = (event: ServerEvent) => {
          const payload =
            'payload' in event
              ? (event.payload as { sessionId?: string; [key: string]: unknown })
              : undefined;
          const sessionId = payload?.sessionId;

          if (sessionId && remoteManager.isRemoteSession(sessionId)) {
            if (event.type === 'stream.partial') {
              stdioChannel.writeEvent({
                type: 'agent.text_delta',
                sessionId,
                text: (payload.delta as string) || '',
              });
            } else if (event.type === 'trace.step') {
              const step = payload.step as {
                type?: string;
                toolName?: string;
                status?: string;
                title?: string;
                input?: unknown;
                output?: string;
              };
              if (step?.type === 'tool_call' && step?.toolName) {
                if (step.status === 'running') {
                  stdioChannel.writeToolStart(sessionId, step.toolName, step.input || {});
                } else if (step.status === 'completed' || step.status === 'error') {
                  stdioChannel.writeToolEnd(sessionId, step.toolName, step.output || '');
                }
              }
            } else if (event.type === 'session.status') {
              const status = payload.status as string;
              if (status === 'running') {
                stdioChannel.writeSessionStarted(sessionId);
              } else if (status === 'idle' || status === 'error') {
                stdioChannel.writeSessionEnd(sessionId);
                remoteManager.clearSessionBuffer(sessionId).catch(() => {});
              }
            }
            // permission.request is already handled by headlessSendWithPermission above
          }
        };

        // Notify that session.started events should come through the channel
        // The StdioChannel's onMessage triggers the MessageRouter which calls
        // remoteManager.executeAgent → sessionManager.startSession. When the session
        // is created, the remoteManager will call back writeSessionStarted via
        // its session mapping.

        // Process stays alive until stdin closes or signal received
      } else {
        // No prompt and not RPC mode — try reading from stdin pipe
        log('[Headless] Attempting to read prompt from stdin');
        const stdinPrompt = await readStdinPrompt();
        if (stdinPrompt) {
          if (!configStore.hasUsableCredentialsForActiveSet()) {
            headlessSendWithPermission({
              type: 'error',
              payload: {
                message: 'No usable API credentials configured.',
                code: 'CONFIG_REQUIRED_ACTIVE_SET',
              },
            });
            await headlessCleanup();
            process.exit(1);
            return;
          }

          try {
            const session = await sessionManager.startSession(
              'Headless Session',
              stdinPrompt,
              headlessArgs.cwd
            );
            emitSessionStarted(session.id);
            await waitForSessionCompletion(session.id);
            emitSessionEnded(session.id);
            await headlessCleanup();
            process.exit(0);
          } catch (err) {
            logError('[Headless] Session error:', err);
            await headlessCleanup();
            process.exit(1);
          }
        } else {
          process.stderr.write(
            'Error: --headless requires either -p "prompt", --mode rpc, or piped stdin\n'
          );
          await headlessCleanup();
          process.exit(1);
        }
      }

      return; // Skip all GUI initialization below
    }

    // ── GUI mode (default) ─────────────────────────────────────────────

    // Apply dev logs setting from config
    const enableDevLogs = configStore.get('enableDevLogs');
    setDevLogsEnabled(enableDevLogs);

    // Start config file watcher for bidirectional sync
    startConfigFileWatcher();

    // Log environment variables for debugging
    log('=== Open Cowork Starting ===');
    log('Config file:', configStore.getPath());
    log('Is configured:', configStore.isConfigured());
    log('[Runtime] Using Open Cowork agent SDK for all providers');
    log('Developer logs:', enableDevLogs ? 'Enabled' : 'Disabled');
    log('Environment Variables:');
    log('  ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? '✓ Set' : '✗ Not set');
    log('  ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL || '(not set)');
    log('  CLAUDE_MODEL:', process.env.CLAUDE_MODEL || '(not set)');
    log('  AGENT_CLI_PATH:', process.env.AGENT_CLI_PATH || '(not set)');
    log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✓ Set' : '✗ Not set');
    log('  OPENAI_BASE_URL:', process.env.OPENAI_BASE_URL || '(not set)');
    log('  OPENAI_MODEL:', process.env.OPENAI_MODEL || '(not set)');
    log('  OPENAI_API_MODE:', process.env.OPENAI_API_MODE || '(default)');
    log('===========================');

    // Initialize default working directory
    initializeDefaultWorkingDir();
    log('Working directory:', currentWorkingDir);
    // 远程会话默认使用全局工作目录
    remoteManager.setDefaultWorkingDirectory(currentWorkingDir || undefined);

    // Initialize database
    const db = initDatabase();

    pluginRuntimeService = new PluginRuntimeService(new PluginCatalogService());
    memoryService = new MemoryService(db, {
      personalHost: {
        // Stable account within this installation's userData DB, not remote authentication.
        owner: 'local-installation',
        isSessionEnabled: (sessionId) =>
          !remoteManager.isRemoteSession(sessionId) &&
          db.sessions.get(sessionId)?.memory_enabled === 1,
        confirmDelete: async (sessionId, toolUseId, path, version) => {
          try {
            if (
              !mainWindow ||
              mainWindow.isDestroyed() ||
              remoteManager.isRemoteSession(sessionId) ||
              !sessionManager
            )
              return false;
            return (
              (await sessionManager.requestPermission(sessionId, toolUseId, 'memory_delete', {
                path,
                if_version: version,
              })) === 'allow'
            );
          } catch {
            return false;
          }
        },
      },
    });
    const extensionManager = new AgentRuntimeExtensionManager([
      new MemoryExtension(memoryService),
      new ConfigExtension(configStore),
      new SubagentExtension(
        () => sessionManager?.getMCPManager() ?? null,
        sendToRenderer,
        async (toolName, toolInput) =>
          resolveSubagentToolPermission(toolName, toolInput as Record<string, unknown>),
        undefined,
        controlCenterService.queue
      ),
    ]);

    // Initialize session manager before creating an interactive window.
    // This avoids session.start racing the startup path and hitting a null manager.
    sessionManager = new SessionManager(db, sendToRenderer, pluginRuntimeService, extensionManager);
    attachAgentServices(sessionManager);
    skillsManager = new SkillsManager(db, {
      getConfiguredGlobalSkillsPath: () => configStore.get('globalSkillsPath') || '',
      setConfiguredGlobalSkillsPath: (nextPath: string) => {
        configStore.update({ globalSkillsPath: nextPath });
      },
      watchStorage: true,
    });
    skillsManager.onStorageChanged((event) => {
      sendToRenderer({
        type: 'skills.storageChanged',
        payload: event,
      });
    });
    // One-time sweep: move every legacy dynamic_skills/ skill into the
    // PENDING-proposals store (human approval gate) — nothing stays outside it.
    try {
      migrateLegacyDynamicSkillsToProposals();
    } catch (migrateErr) {
      logError('[Startup] Legacy dynamic-skills migration failed:', migrateErr);
    }
    // pi-ai handles model routing natively — no proxy warmup needed

    // macOS: application menu, dock menu, tray icon + global toggle shortcut
    buildMacMenu();
    applyBackgroundAccessSetting(configStore.get('trayEnabled'));

    // Show window after core managers are ready so first-load actions can be handled.
    createWindow();

    // macOS: dock menu
    if (process.platform === 'darwin') {
      const dockMenu = Menu.buildFromTemplate([
        {
          label: 'New Session',
          click: () => mainWindow?.webContents.send('server-event', { type: 'new-session' }),
        },
        {
          label: 'Settings',
          click: () =>
            mainWindow?.webContents.send('server-event', { type: 'navigate', payload: 'settings' }),
        },
      ]);
      app.dock?.setMenu(dockMenu);
    }

    // macOS: send initial system theme to renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.on('did-finish-load', () => {
        sendToRenderer({
          type: 'native-theme.changed',
          payload: { shouldUseDarkColors: nativeTheme.shouldUseDarkColors },
        });
      });
    }

    // Listen for system theme changes
    nativeTheme.on('updated', () => {
      sendToRenderer({
        type: 'native-theme.changed',
        payload: { shouldUseDarkColors: nativeTheme.shouldUseDarkColors },
      });
      if (getSavedThemePreference() === 'system' && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG);
      }
    });

    // Auto-updater: check for updates in production
    if (!isDev) {
      import('electron-updater')
        .then(({ autoUpdater }) => {
          autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
            log('[AutoUpdater] Update check failed:', err);
          });
        })
        .catch((err: unknown) => {
          log('[AutoUpdater] Failed to load electron-updater:', err);
        });
    }

    startNavServer(() => mainWindow);

    const scheduledTaskStore = createScheduledTaskStore(db);
    scheduledTaskManager = new ScheduledTaskManager({
      store: scheduledTaskStore,
      executeTask: async (task) => {
        if (!sessionManager) {
          throw new Error('Session manager not initialized');
        }
        const unsupportedReason = getWorkspacePathUnsupportedReason(task.cwd);
        if (unsupportedReason) {
          throw new Error(unsupportedReason);
        }
        const fallbackTitle = buildScheduledTaskFallbackTitle(task.prompt);
        const needsRegeneratedTitle = !task.title?.trim() || task.title === fallbackTitle;
        const title = needsRegeneratedTitle
          ? await resolveScheduledTaskTitle(task.prompt, task.cwd, task.title)
          : buildScheduledTaskTitle(task.title);
        if (title !== task.title) {
          scheduledTaskStore.update(task.id, { title });
        }
        const started = await sessionManager.startSession(title, task.prompt, task.cwd);
        // 定时任务创建的新会话需要主动同步到前端会话列表
        sendToRenderer({
          type: 'session.update',
          payload: { sessionId: started.id, updates: started },
        });
        return { sessionId: started.id };
      },
      onTaskError: (taskId, error) => {
        sendToRenderer({
          type: 'scheduled-task.error',
          payload: { taskId, error },
        });
      },
      now: () => Date.now(),
    });
    scheduledTaskManager.start();

    // Delegations that were still running when the app last quit are resumed
    // here (opt-in via the delegation settings). A background sub-agent lives
    // inside this process, so "persistent" means re-launched at startup with
    // the stored prompt, workspace and role.
    try {
      const resumeOutcome = resumeInterruptedDelegations();
      if (resumeOutcome.resumed.length > 0) {
        log(
          `[App] Resumed ${resumeOutcome.resumed.length} interrupted delegation(s) after restart`
        );
      }
    } catch (error) {
      logError('[App] Failed to resume interrupted delegations:', error);
    }

    // 初始化远程管理器
    remoteManager.setRendererCallback(sendToRenderer);
    const agentExecutor: AgentExecutor = {
      startSession: async (title, prompt, cwd) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
        if (unsupportedReason) {
          throw new Error(unsupportedReason);
        }
        return sessionManager.startSession(title, prompt, cwd);
      },
      continueSession: async (sessionId, prompt, content, cwd) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        if (cwd) {
          const result = await setWorkingDir(cwd, sessionId);
          if (!result.success) {
            throw new Error(result.error || 'Failed to update working directory');
          }
        }
        await sessionManager.continueSession(sessionId, prompt, content);
      },
      stopSession: async (sessionId) => {
        if (!sessionManager) throw new Error('Session manager not initialized');
        await sessionManager.stopSession(sessionId);
      },
      validateWorkingDirectory: async (cwd) => {
        const unsupportedReason = getWorkspacePathUnsupportedReason(cwd);
        if (unsupportedReason) {
          return unsupportedReason;
        }
        if (!fs.existsSync(cwd)) {
          return 'Directory does not exist';
        }
        return null;
      },
    };
    remoteManager.setAgentExecutor(agentExecutor);

    // 远程控制启用时启动
    if (remoteConfigStore.isEnabled()) {
      remoteManager.start().catch((error) => {
        logError('[App] Failed to start remote control:', error);
      });
    }

    app.on('activate', () => {
      const hasVisibleWindow = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed());
      if (!hasVisibleWindow) {
        createWindow();
      }
    });
  })
  .catch((error) => {
    logError('[App] Startup failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown startup error';
    dialog.showErrorBox(
      'Open Cowork failed to start',
      `${message}\n\nCheck the logs for more information.`
    );
    app.quit();
  });

// Flag to prevent double cleanup
let isCleaningUp = false;

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
}

/**
 * Last-resort exit guard that survives a blocked main thread.
 *
 * The JS timers on the quit path cannot fire when a cleanup step blocks the
 * event loop synchronously (observed: chokidar's FSWatcher.close() deadlocking
 * in libuv's macOS FSEvents teardown on uv_sem_wait). A detached POSIX helper
 * is the only watchdog that still runs in that case: it SIGKILLs the process
 * after `graceMs` if it is still alive. Returns a disarm function that the
 * clean exit path calls to stop the race the other way around.
 */
function armHardExitWatchdog(graceMs = 15000): () => void {
  // Windows has no FSEvents deadlock and kill is not a POSIX shell builtin;
  // the JS failsafe timer above stays the guard on that platform.
  if (process.platform === 'win32') {
    return () => undefined;
  }
  try {
    const seconds = Math.ceil(graceMs / 1000);
    const pid = process.pid;
    // Capture our own start time so the helper can never SIGKILL an unrelated
    // process that happens to reuse this PID after we exit normally.
    const script = [
      `START="$(ps -p ${pid} -o lstart= 2>/dev/null)"`,
      `sleep ${seconds}`,
      `NOW="$(ps -p ${pid} -o lstart= 2>/dev/null)"`,
      `[ -n "$START" ] && [ "$NOW" = "$START" ] && kill -9 ${pid} 2>/dev/null`,
      'exit 0',
    ].join('; ');
    const watchdog = spawn('/bin/sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
    });
    // Detached + unref so the helper never keeps us alive by itself.
    watchdog.unref();
    return () => {
      try {
        watchdog.kill('SIGKILL');
      } catch {
        // Already gone: the clean exit path won the race.
      }
    };
  } catch (error) {
    logError('[App] Failed to arm hard-exit watchdog:', error);
    return () => undefined;
  }
}

/**
 * Cleanup all sandbox resources
 * Called on app quit (both Windows and macOS)
 */
async function cleanupSandboxResources(): Promise<void> {
  // isCleaningUp is set by the caller (before-quit) before calling this function.
  // Do NOT guard here — that would skip all cleanup when called from before-quit.

  stopNavServer();
  stopConfigFileWatcher();
  // Skills storage monitoring is a signature poller on macOS (no native
  // FSEvents handle): closing a recursive chokidar watcher deadlocks libuv
  // (uv_fs_event_stop → uv__fsevents_close → uv_sem_wait), and leaving the
  // handle open hangs Node's own teardown just the same, so the app could only
  // ever be killed with Force Quit. Clearing the poller interval here is what
  // lets the event loop drain.
  skillsManager?.stopStorageMonitoring();
  scheduledTaskManager?.stop();
  try {
    BackgroundJobRegistry.getInstance().stopAllJobs();
  } catch (err) {
    logError('[App] Error stopping background jobs:', err);
  }
  tray?.destroy();
  tray = null;

  // Independent shutdown steps run in parallel so the worst case is bounded
  // by the slowest pipeline (~7s: session sync-back 5s + adapter 3s) instead
  // of the sum of sequential timeouts (previously up to 23s — far beyond the
  // old 3s failsafe, which hard-killed the process mid-cleanup and orphaned
  // MCP/VM child processes). Each step keeps its own withTimeout per policy.
  const cleanupTasks: Promise<void>[] = [
    // 停止远程控制
    (async () => {
      try {
        log('[App] Stopping remote control...');
        await withTimeout(remoteManager.stop(), 5000, 'Remote control shutdown');
        log('[App] Remote control stopped');
      } catch (error) {
        logError('[App] Error stopping remote control:', error);
      }
    })(),

    // Cleanup all sandbox sessions (sync changes back to host OS first),
    // then tear down the adapter — the adapter must outlive the sync-back.
    (async () => {
      try {
        log('[App] Cleaning up all sandbox sessions...');
        await Promise.all([
          (async () => {
            try {
              await withTimeout(SandboxSync.cleanupAllSessions(), 4000, 'WSL session cleanup');
            } catch (error) {
              logError('[App] Error cleaning up WSL sessions:', error);
            }
          })(),
          (async () => {
            try {
              const { LimaSync } = await import('./sandbox/lima-sync');
              await withTimeout(LimaSync.cleanupAllSessions(), 4000, 'Lima session cleanup');
            } catch (error) {
              logError('[App] Error cleaning up Lima sessions:', error);
            }
          })(),
        ]);
        log('[App] Sandbox sessions cleanup complete');
      } catch (error) {
        logError('[App] Error cleaning up sandbox sessions:', error);
      }

      try {
        await withTimeout(shutdownSandbox(), 3000, 'Sandbox shutdown');
        log('[App] Sandbox shutdown complete');
      } catch (error) {
        logError('[App] Error shutting down sandbox:', error);
      }
    })(),

    // Shutdown MCP servers (kills stdio child processes)
    (async () => {
      try {
        const mcpManager = sessionManager?.getMCPManager();
        if (mcpManager) {
          log('[App] Shutting down MCP servers...');
          await withTimeout(mcpManager.shutdown(), 5000, 'MCP shutdown');
          log('[App] MCP servers shutdown complete');
        }
      } catch (error) {
        logError('[App] Error shutting down MCP servers:', error);
      }
    })(),

    // Kill embedded control-center terminals so no shell outlives the app.
    (async () => {
      try {
        const closed = controlCenterService.closeAllTerminals();
        if (closed > 0) {
          log('[App] Closed ' + closed + ' embedded terminal(s)');
        }
      } catch (error) {
        logError('[App] Error closing embedded terminals:', error);
      }
    })(),

    // Flush durable Cowork 4.0 state (plans, checkpoints, project memory,
    // detached-task queue, benchmark history and routing evidence) so a restart
    // resumes from the last known point instead of starting over.
    (async () => {
      try {
        if (queuePersistTimer) {
          clearTimeout(queuePersistTimer);
          queuePersistTimer = null;
        }
        if (routingPersistTimer) {
          clearTimeout(routingPersistTimer);
          routingPersistTimer = null;
        }
        await withTimeout(
          (async () => {
            await workflowRegistry.persistAll();
            await workflowPersistence.saveMetrics(metricsHistory.serialize());
            await workflowPersistence.saveRouting(modelRoutingService.serialize());
          })(),
          5000,
          'Workflow state persistence'
        );
        log('[App] Workflow state persisted');
      } catch (error) {
        logError('[App] Error persisting workflow state:', error);
      }
    })(),
  ];

  await Promise.all(cleanupTasks);

  try {
    closeDatabase();
  } catch (error) {
    logError('[App] Error closing database:', error);
  }

  closeLogFile();

  // pi-ai doesn't need proxy shutdown
}

// Handle app quit - window-all-closed (quitte directement l'application sur tous les OS)
app.on('window-all-closed', () => {
  // In headless mode there are no windows, so this event fires immediately.
  // The headless path manages its own lifecycle — skip cleanup here.
  if (process.argv.includes('--headless')) return;

  // If before-quit cleanup is already running, it owns the exit path
  // (app.exit(0) + failsafe). A second quit here (e.g. user clicks the
  // close button again while cleanup is in flight) would let Electron
  // terminate mid-cleanup and orphan MCP/VM child processes.
  if (isCleaningUp) return;

  // cleanup is handled by before-quit; just trigger quit
  app.quit();
});

// Handle SIGTERM/SIGINT (e.g. pkill) — route through app.quit() for clean shutdown
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.quit();
  });
}

// Handle app quit - before-quit (for macOS Cmd+Q and other quit methods)
app.on('before-quit', async (event) => {
  log('[App] before-quit received (isCleaningUp:', isCleaningUp, ')');
  if (!isCleaningUp) {
    // Set the flag immediately — before any early return or await — so the
    // window 'close' interceptor can never re-enter and cancel quit forever.
    // Without this, the dev-mode early return left isCleaningUp=false, every
    // close was preventDefault()'d, and app.quit() could never complete —
    // the app "hid" instead of exiting (and pkill/SIGTERM hit the same loop).
    isCleaningUp = true;

    // In dev mode, exit quickly — no need for async sandbox cleanup
    if (process.env.VITE_DEV_SERVER_URL) {
      stopNavServer();
      try {
        closeDatabase();
      } catch {
        /* best-effort */
      }
      closeLogFile();
      tray?.destroy();
      tray = null;
      return;
    }
    event.preventDefault();

    // Hard failsafe: cleanup steps run in parallel with per-step timeouts
    // capped at 5000ms (worst case ~7s for the sandbox pipeline), so 9s is
    // enough for a healthy shutdown to finish while still guaranteeing the
    // process cannot linger as a zombie. The old 3s cut cleanup short and
    // orphaned MCP/VM child processes.
    let disarmWatchdog: () => void = () => undefined;
    const failsafeTimer = setTimeout(() => {
      logError('[App] Cleanup timed out — forcing exit');
      disarmWatchdog();
      process.exit(0);
    }, 9000);

    // Armed BEFORE cleanup: a synchronous block inside cleanup would starve
    // the timer above, so only an out-of-process watchdog can still exit us.
    disarmWatchdog = armHardExitWatchdog(15000);

    try {
      await cleanupSandboxResources();
    } catch (error) {
      logError('[App] before-quit cleanup failed, forcing quit:', error);
    } finally {
      clearTimeout(failsafeTimer);
    }
    // Unregister shortcuts
    globalShortcut.unregisterAll();
    log('[App] Cleanup complete — exiting now');
    // Clean shutdown won the race: cancel the long-grace watchdog …
    disarmWatchdog();
    // … and immediately re-arm a short-grace one. process.exit() runs Node's
    // environment teardown first, and that teardown can block forever closing
    // a native handle (observed: uv_fs_event_stop → uv__fsevents_close →
    // uv_sem_wait while freeing a chokidar FSWatcher). In-process timers cannot
    // fire during that synchronous block, so this out-of-process helper is the
    // only thing that can still end the process. It is SIGKILLed as soon as we
    // exit normally, so a healthy quit just leaves a sleeping shell for at most
    // the grace period — the guarantee is that no quit can ever hang again.
    armHardExitWatchdog(5000);
    // process.exit() is deliberate, NOT app.exit(): once a quit has been
    // cancelled with preventDefault() above, app.exit(0) can return without
    // terminating (observed: cleanup fully completed, watchdog disarmed, and
    // the process was still alive and needed Force Quit). process.exit() cannot
    // be swallowed, and both failsafe timers above rely on it for the same
    // reason.
    process.exit(0);
  }
});

// IPC Handlers
ipcMain.on('client-event', async (_event, data: ClientEvent) => {
  try {
    await handleClientEvent(data);
  } catch (error) {
    logError('Error handling client event:', error);
    sendToRenderer({
      type: 'error',
      payload: { message: error instanceof Error ? error.message : 'Unknown error' },
    });
  }
});

ipcMain.handle('client-invoke', async (_event, data: ClientEvent) => {
  return handleClientEvent(data);
});

registerArtifactsIpcHandlers({ getWorkingDir });

// Config IPC handlers (see main/ipc/config-handlers.ts)
registerConfigIpcHandlers({
  getSessionManager: () => sessionManager,
  applyBackgroundAccessSetting,
});

// MCP Server IPC handlers (see main/ipc/mcp-handlers.ts)
registerMcpIpcHandlers({
  getMcpManager: () => sessionManager?.getMCPManager() ?? null,
  invalidateMcpServersCache: () => sessionManager?.invalidateMcpServersCache(),
});

// Skills and plugin IPC handlers (see main/ipc/skills-handlers.ts)
registerSkillsIpcHandlers({
  getSkillsManager: () => skillsManager,
  getPluginRuntimeService: () => pluginRuntimeService,
  getSessionManager: () => sessionManager,
});

// Window and system IPC handlers (see main/ipc/window-handlers.ts)
registerWindowIpcHandlers({ getMainWindow: () => mainWindow });

// Sandbox IPC handlers (see main/ipc/sandbox-handlers.ts)
registerSandboxIpcHandlers();

// Register built-in local mods once (idempotent registry).
const modsRegistry = getModsRegistry();
for (const mod of createBuiltinMods()) {
  modsRegistry.register(mod);
}

// Logs IPC handlers (see main/ipc/logs-handlers.ts)
registerLogsIpcHandlers({
  getSessionManager: () => sessionManager,
  getMainWindow: () => mainWindow,
  getCurrentWorkingDir: () => currentWorkingDir,
});

// Mods and diff IPC handlers (see main/ipc/mods-handlers.ts)
registerModsIpcHandlers();

// Remote control IPC handlers (see main/ipc/remote-handlers.ts)
registerRemoteIpcHandlers();
// Scheduled task IPC handlers (see main/ipc/schedule-handlers.ts)
registerScheduleIpcHandlers({
  getScheduledTaskManager: () => scheduledTaskManager,
  getWorkspacePathUnsupportedReason,
  resolveScheduledTaskTitle,
});

// Memory and personal-files IPC handlers (see main/ipc/memory-handlers.ts)
registerMemoryIpcHandlers({
  getMemoryService: () => memoryService,
  getMainWindow: () => mainWindow,
  getSessionManager: () => sessionManager,
});

// Durable Cowork 4.0 state (Phases 1.6 / 5.5): workflow plans, checkpoints,
// project memory, the detached-task queue, benchmark history and routing
// evidence all live under the app userData directory, so a restart resumes
// instead of silently starting over.
const workflowPersistence = new WorkflowPersistence();
const metricsHistory = new MetricsHistory();
metricsHistory.restore(workflowPersistence.loadMetrics());

// Filled in once the control-center service exists below. The registry only
// reads it while persisting, so the declaration order is safe.
let controlCenterQueue: TaskQueue | null = null;

// Workflow (Plan -> Act -> Verify) IPC handlers. The registry owns one
// orchestrator per session, rooted at the session working directory. The LLM
// runner and the proof runner are injected here so an approved plan is really
// executed and its proof commands really re-run by the main process.
const workflowRegistry = new WorkflowRegistry({
  resolveWorkspaceRoot: () => getWorkingDir(),
  fallbackWorkspaceRoot: () => currentWorkingDir,
  persistence: workflowPersistence,
  queueProvider: () => controlCenterQueue,
  // Push every phase/task transition to the renderer so the workflow status
  // banner reflects execution without the UI having to poll.
  onStateChange: (sessionId, state) => {
    sendToRenderer({ type: 'workflow.state', payload: { sessionId, state } });
  },
  // Live cost/token visibility: one event per finished task, plus throttled
  // progress while a task is still running.
  onTaskResult: (sessionId, result) => {
    sendToRenderer({ type: 'workflow.taskResult', payload: { sessionId, result } });
  },
  onTaskProgress: (sessionId, progress) => {
    sendToRenderer({ type: 'workflow.taskProgress', payload: { sessionId, progress } });
  },
});
registerWorkflowIpcHandlers({
  registry: workflowRegistry,
  runWorkflowTask: createAgentTaskRunner(),
  runProof: createShellProofRunner(),
});

// Project memory (Phase 4): four-layer memory per workspace, with the same
// per-session workspace resolution as the workflow registry.
registerProjectMemoryIpcHandlers({
  resolve: (sessionId) => {
    const entry = workflowRegistry.getOrCreate(sessionId);
    if (!entry) {
      return null;
    }
    const workspaceKey = workflowRegistry.workspaceKey(sessionId);
    if (!workspaceKey) {
      return null;
    }
    return { store: entry.memory as ProjectMemoryStore, workspaceKey };
  },
});

// Control center (Phase 6): activity feed, detached-task queue, notifications
// and read-only workspace probes, all rooted at the session workspace.
let queuePersistTimer: NodeJS.Timeout | null = null;
const controlCenterService = new ControlCenterService({
  resolveWorkspaceRoot: (sessionId) =>
    workflowRegistry.getOrCreate(sessionId)?.workspaceRoot ?? getWorkingDir(),
  // The queue is persisted on change rather than only at shutdown, so a crash
  // cannot lose a detached task that was enqueued minutes earlier.
  queueOnChange: () => {
    if (queuePersistTimer) {
      return;
    }
    queuePersistTimer = setTimeout(() => {
      queuePersistTimer = null;
      void workflowPersistence.saveQueue(controlCenterService.queue.serialize());
    }, DEFAULT_PERSIST_DEBOUNCE_MS);
    queuePersistTimer.unref?.();
  },
});
controlCenterQueue = controlCenterService.queue;
const restoredQueue = workflowPersistence.loadQueue();
if (restoredQueue.length > 0) {
  controlCenterService.queue.restore(restoredQueue);
}
registerControlCenterIpcHandlers({ service: controlCenterService });

// Model routing (Phase 7): named profiles, local benchmark store, local provider
// detection and validated registry entries. The service also backs adaptive
// model selection in the agent runner, but only once a user picks a profile.
const modelRoutingService = new ModelRoutingService();
const persistedRouting = workflowPersistence.loadRouting();
if (persistedRouting) {
  modelRoutingService.restore(persistedRouting as ModelRoutingSnapshot | null);
}

let routingPersistTimer: NodeJS.Timeout | null = null;
/** Coalesce routing writes: benchmarks change on every finished agent run. */
function persistRoutingSoon(): void {
  if (routingPersistTimer) {
    return;
  }
  routingPersistTimer = setTimeout(() => {
    routingPersistTimer = null;
    void workflowPersistence.saveRouting(modelRoutingService.serialize());
  }, DEFAULT_PERSIST_DEBOUNCE_MS);
  routingPersistTimer.unref?.();
}

registerModelRoutingIpcHandlers({ service: modelRoutingService, onChange: persistRoutingSoon });

/**
 * Wire the Phase 6 control center and the Phase 7 router into a freshly
 * created SessionManager. Both services are created at module scope, so the
 * async bootstrap that builds the manager always sees them initialized.
 */
function attachAgentServices(manager: SessionManager): void {
  manager.setActivityTracker(controlCenterService.activity);
  manager.setNotificationCenter(controlCenterService.notifications);
  manager.setModelResolver((input) => modelRoutingService.resolveModel(input));
  manager.setBenchmarkRecorder((input) => {
    modelRoutingService.recordRun(input);
    persistRoutingSoon();
  });
}

// Reference benchmarks and end-to-end routing validation (Phases 5.5 / 7.5).
// The suite is only runnable when the agent runner is wired, and its history is
// persisted so two releases can be compared.
registerMetricsIpcHandlers({
  history: metricsHistory,
  // The workspace can change between runs, so the runner is built per suite.
  runSuite: async (scenario) => {
    const workspaceRoot = getWorkingDir() ?? currentWorkingDir;
    if (!workspaceRoot) {
      throw new Error('No workspace is available to run the reference scenarios.');
    }
    return createScenarioAgentRunner({ workspaceRoot })(scenario);
  },
  benchmarks: () => modelRoutingService.benchmarks.list(),
  onRecord: (history) => {
    void workflowPersistence.saveMetrics(history.serialize());
  },
});

// Client event dispatch lives in its own module; wire the app-level state it
// needs here so the dependency surface stays explicit.
const clientEventHandlerContext: ClientEventHandlerContext = {
  getSessionManager: () => sessionManager,
  getMainWindow: () => mainWindow,
  getCurrentWorkingDir: () => currentWorkingDir,
  getProjectStore,
  getWorkingDir,
  setWorkingDir,
  getWorkspacePathUnsupportedReason,
};

async function handleClientEvent(event: ClientEvent): Promise<unknown> {
  return dispatchClientEvent(event, clientEventHandlerContext);
}
