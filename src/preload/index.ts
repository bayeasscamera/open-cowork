import { contextBridge, ipcRenderer } from 'electron';
import type { PersonalFilesAPI } from '../shared/personal-files';
import type {
  ClientEvent,
  ServerEvent,
  AppConfig,
  CreateSetPayload,
  ProviderPresets,
  Skill,
  ApiTestInput,
  ApiTestResult,
  PluginCatalogItemV2,
  InstalledPlugin,
  PluginInstallResultV2,
  PluginToggleResult,
  PluginComponentKind,
  ScheduleTask,
  ScheduleCreateInput,
  ScheduleUpdateInput,
  ProviderModelInfo,
  LocalOllamaDiscoveryResult,
  MemoryOverview,
  MemorySearchResult,
  MemoryReadResult,
  MemorySearchScope,
  MemoryDebugFileInfo,
  MemoryDebugFileContent,
  MemoryInspectSessionResult,
  Project,
  PipelineMode,
  ProjectContextUsage,
  BackgroundTask,
  DelegationSettings,
  SwarmStats,
  DelegationStats,
} from '../shared/types';
import type { DiagnosticInput, DiagnosticResult } from '../shared/types';
import type { HealthReport } from '../shared/health-report';
import type { SecretSourceKind, SecretSourceProbe } from '../shared/secret-source';
import type {
  McpServerConfig,
  McpTool,
  McpServerStatus,
  McpPresetsMap,
  RemoteConfig,
  GatewayConfig,
  FeishuChannelConfig,
  PairedUser,
  PairingRequest,
  RemoteSessionMapping,
} from '../shared/ipc-types';
import type {
  AtomicTask,
  CreateTaskContractInput,
  WorkflowMode,
} from '../shared/task-contract';
import type {
  MemoryInjection,
  ProjectMemoryItem,
  ProjectMemoryOverview,
  UpsertMemoryInput,
} from '../shared/project-memory-types';
import type {
  ActivityEvent,
  ActivityEventInput,
  ActivityStatus,
  ApprovalNotification,
  ControlCenterSnapshot,
  DetachedTask,
  DetachedTaskInput,
  DetachedTaskStatus,
  GitStatusSummary,
  NotificationInput,
  RerunFailedTestsOutcome,
  TerminalSessionInfo,
  TerminalSnapshot,
  TestCommandId,
  TestRunResult,
  WorkspaceEntry,
  WorkspaceFileContent,
  WorkspaceTreeOptions,
} from '../shared/control-center-types';
import type {
  BenchmarkRecordInput,
  LocalProviderKind,
  LocalProviderProbe,
  ModelBenchmark,
  ModelProfile,
  ModelProfileId,
  ModelRoutingState,
  RegistryEntryInput,
  RegistryValidation,
  RoutingDecision,
  RoutingRequest,
  TaskKind,
} from '../shared/model-routing-types';
import type {
  ApprovalDecisionInput,
  ApprovalOutcome,
  ApprovalRequest,
  AuditEntry,
  IsolationPlan,
  NewCheckpointEvidence,
  RoleAssignment,
  RolePlanInput,
  TaskCheckpoint,
  TaskRunResult,
  TaskVerification,
  VerifyResult,
  WorkflowExecutionReport,
  WorkflowState,
} from '../shared/workflow-types';
import type {
  MetricsDelta,
  RoutingValidationReport,
  ScenarioSuiteResult,
} from '../shared/metrics-types';
import type { SkillRuntimeReport } from '../shared/skill-runtime-types';

// Track registered callbacks to prevent duplicate listeners
let registeredCallback: ((event: ServerEvent) => void) | null = null;
let ipcListener: ((event: Electron.IpcRendererEvent, data: ServerEvent) => void) | null = null;

// Exhaustive allowlist of valid ClientEvent types to prevent spoofing arbitrary
// IPC channels. Typed as `Record<ClientEvent['type'], true>` so TypeScript fails
// the build if this map and the ClientEvent union ever drift apart (previously a
// hand-maintained array, which silently omitted 'config.createSet').
const ALLOWED_CLIENT_EVENT_MAP: Record<ClientEvent['type'], true> = {
  'session.start': true,
  'session.continue': true,
  'session.stop': true,
  'session.delete': true,
  'session.batchDelete': true,
  'session.rename': true,
  'session.togglePin': true,
  'session.activate': true,
  'session.list': true,
  'session.getMessages': true,
  'session.getTraceSteps': true,
  'session.compact': true,
  'session.getContextUsage': true,
  'session.setConfigOverride': true,
  'permission.response': true,
  'sudo.password.response': true,
  'settings.update': true,
  'appMenu.sync': true,
  'config.createSet': true,
  'folder.select': true,
  'workdir.get': true,
  'workdir.set': true,
  'workdir.select': true,
  'projects.create': true,
  'projects.list': true,
  'projects.get': true,
  'projects.update': true,
  'projects.archive': true,
  'projects.attachFile': true,
  'projects.detachFile': true,
  'projects.linkSession': true,
  'projects.unlinkSession': true,
  'projects.delete': true,
  'backgroundTasks.list': true,
  'backgroundTasks.get': true,
  'backgroundTasks.cancel': true,
  'backgroundTasks.retry': true,
  'backgroundTasks.delete': true,
  'backgroundTasks.getSettings': true,
  'backgroundTasks.getStats': true,
  'backgroundTasks.setSettings': true,
  'document.read': true,
  'document.write': true,
  'document.list': true,
};
const ALLOWED_CLIENT_EVENTS: ReadonlySet<string> = new Set(Object.keys(ALLOWED_CLIENT_EVENT_MAP));

// Invoke a whitelisted ClientEvent and wait for the response. Defined once at
// module scope so both the generic `invoke()` API and the typed `session.*`
// helpers below share the same ALLOWED_CLIENT_EVENTS check instead of one of
// them bypassing it via a raw ipcRenderer.invoke('client-invoke', ...) call.
const invoke = async <T>(event: ClientEvent): Promise<T> => {
  if (!ALLOWED_CLIENT_EVENTS.has(event.type)) {
    console.warn('[Preload] Blocked unauthorized invoke type:', event.type);
    throw new Error(`Unauthorized event type: ${event.type}`);
  }
  return ipcRenderer.invoke('client-invoke', event);
};

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Send events to main process
  send: (event: ClientEvent) => {
    if (!ALLOWED_CLIENT_EVENTS.has(event.type)) {
      console.warn('[Preload] Blocked unauthorized event type:', event.type);
      return;
    }
    ipcRenderer.send('client-event', event);
  },

  // Receive events from main process - ensures only ONE listener
  on: (callback: (event: ServerEvent) => void) => {
    // Remove previous listener if exists
    if (ipcListener) {
      ipcRenderer.removeListener('server-event', ipcListener);
    }

    registeredCallback = callback;
    ipcListener = (_: Electron.IpcRendererEvent, data: ServerEvent) => {
      if (registeredCallback) {
        registeredCallback(data);
      }
    };

    ipcRenderer.on('server-event', ipcListener);

    // Return cleanup function
    return () => {
      if (ipcListener) {
        ipcRenderer.removeListener('server-event', ipcListener);
        ipcListener = null;
        registeredCallback = null;
      }
    };
  },

  // Invoke and wait for response
  invoke,

  // Session compaction and context usage
  session: {
    compact: (
      sessionId: string,
      customInstructions?: string
    ): Promise<{
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details?: unknown;
    } | null> =>
      invoke({
        type: 'session.compact',
        payload: { sessionId, customInstructions },
      }),
    getContextUsage: (
      sessionId: string
    ): Promise<{
      tokens: number | null;
      contextWindow: number;
      percent: number | null;
    } | null> =>
      invoke({
        type: 'session.getContextUsage',
        payload: { sessionId },
      }),

    /**
     * Pin (or clear) the SESSION-level settings override. Both null = inherit
     * the project, then the globally active ConfigSet.
     */
    setConfigOverride: (
      sessionId: string,
      configSetId: string | null,
      modelId: string | null
    ): Promise<{ success: boolean; error?: string }> =>
      invoke({
        type: 'session.setConfigOverride',
        payload: { sessionId, configSetId, modelId },
      }),
  },

  // Projects — grouped sessions with shared working context
  projects: {
    create: (payload: {
      name: string;
      workdir: string;
      description?: string;
      configSetId?: string;
      modelId?: string;
      pipelineMode?: PipelineMode;
      draftConfigSetId?: string;
      draftModelId?: string;
      refineConfigSetId?: string;
      refineModelId?: string;
      instructions?: string;
    }): Promise<{ success: boolean; project?: Project; error?: string }> =>
      invoke({ type: 'projects.create', payload }),

    list: (includeArchived?: boolean): Promise<{ success: boolean; projects: Project[] }> =>
      invoke({ type: 'projects.list', payload: { includeArchived } }),

    get: (
      projectId: string
    ): Promise<{
      success: boolean;
      project?: Project;
      sessions?: Array<{
        id: string;
        title: string;
        status: string;
        cwd: string | null;
        updated_at: number;
      }>;
      usage?: ProjectContextUsage;
      error?: string;
    }> => invoke({ type: 'projects.get', payload: { projectId } }),

    update: (payload: {
      projectId: string;
      name?: string;
      description?: string | null;
      workdir?: string;
      configSetId?: string | null;
      modelId?: string | null;
      pipelineMode?: PipelineMode;
      draftConfigSetId?: string | null;
      draftModelId?: string | null;
      refineConfigSetId?: string | null;
      refineModelId?: string | null;
      instructions?: string | null;
    }): Promise<{ success: boolean; project?: Project; error?: string }> =>
      invoke({ type: 'projects.update', payload }),

    archive: (
      projectId: string,
      archived: boolean
    ): Promise<{ success: boolean; project?: Project; error?: string }> =>
      invoke({ type: 'projects.archive', payload: { projectId, archived } }),

    attachFile: (
      projectId: string,
      path: string
    ): Promise<{ success: boolean; project?: Project; error?: string }> =>
      invoke({ type: 'projects.attachFile', payload: { projectId, path } }),

    detachFile: (
      projectId: string,
      path: string
    ): Promise<{ success: boolean; project?: Project; error?: string }> =>
      invoke({ type: 'projects.detachFile', payload: { projectId, path } }),

    linkSession: (
      projectId: string,
      sessionId: string
    ): Promise<{ success: boolean; error?: string }> =>
      invoke({ type: 'projects.linkSession', payload: { projectId, sessionId } }),

    unlinkSession: (sessionId: string): Promise<{ success: boolean; error?: string }> =>
      invoke({ type: 'projects.unlinkSession', payload: { sessionId } }),

    delete: (
      projectId: string
    ): Promise<{
      success: boolean;
      orphanedSessions?: number;
      removedReferenceFiles?: number;
      error?: string;
    }> => invoke({ type: 'projects.delete', payload: { projectId } }),
  },

  /**
   * Session deletion. General project archive/delete intentionally leaves
   * linked conversations intact (orphaned, never deleted) — removing a
   * conversation stays an explicit, user-visible action. The invoke shape is
   * unchanged: the historical dynamic-forwarding fallback still routes this
   * channel, this types the surface the renderer already calls.
   */
  sessions: {
    delete: (sessionId: string): Promise<{ success: boolean; error?: string }> =>
      invoke({ type: 'session.delete', payload: { sessionId } }),
  },

  // Background delegations — tracking view API
  backgroundTasks: {
    list: (sessionId?: string): Promise<{ success: boolean; tasks: BackgroundTask[] }> =>
      invoke({ type: 'backgroundTasks.list', payload: { sessionId } }),
    get: (
      taskId: string
    ): Promise<{ success: boolean; task?: BackgroundTask; error?: string }> =>
      invoke({ type: 'backgroundTasks.get', payload: { taskId } }),
    cancel: (
      taskId: string
    ): Promise<{ success: boolean; cancelled?: boolean; error?: string }> =>
      invoke({ type: 'backgroundTasks.cancel', payload: { taskId } }),
    retry: (
      taskId: string
    ): Promise<{ success: boolean; taskId?: string; error?: string }> =>
      invoke({ type: 'backgroundTasks.retry', payload: { taskId } }),
    delete: (
      taskId: string
    ): Promise<{ success: boolean; deleted?: boolean; error?: string }> =>
      invoke({ type: 'backgroundTasks.delete', payload: { taskId } }),
    getSettings: (): Promise<{ success: boolean; settings?: DelegationSettings; error?: string }> =>
      invoke({ type: 'backgroundTasks.getSettings', payload: {} }),
    getStats: (): Promise<{
      success: boolean;
      swarm?: SwarmStats;
      delegations?: DelegationStats;
      error?: string;
    }> => invoke({ type: 'backgroundTasks.getStats', payload: {} }),
    setSettings: (next: {
      configSetId?: string;
      modelId?: string | null;
      timeoutMs?: number;
      maxConcurrent?: number;
      notifyOnCompletion?: boolean;
      resumeOnRestart?: boolean;
      detachedExecution?: boolean;
      detachedAutoApprove?: boolean;
    }): Promise<{ success: boolean; settings?: DelegationSettings; error?: string }> =>
      invoke({ type: 'backgroundTasks.setSettings', payload: next }),
  },

  // Live document co-editing (workspace-confined)
  document: {
    read: (
      cwd: string,
      path: string
    ): Promise<{
      success: boolean;
      ok?: boolean;
      content?: string;
      mtimeMs?: number;
      error?: string;
    }> => invoke({ type: 'document.read', payload: { cwd, path } }),
    write: (
      cwd: string,
      path: string,
      content: string,
      options?: { baseMtimeMs?: number; force?: boolean }
    ): Promise<{
      success: boolean;
      ok?: boolean;
      status?: 'written' | 'conflict' | 'error';
      mtimeMs?: number;
      error?: string;
    }> => invoke({ type: 'document.write', payload: { cwd, path, content, ...options } }),
    list: (
      cwd: string
    ): Promise<{
      success: boolean;
      files?: Array<{ path: string; mtimeMs: number }>;
      error?: string;
    }> => invoke({ type: 'document.list', payload: { cwd } }),
  },

  // Platform info
  platform: process.platform,
  /**
   * CPU architecture of the running app, straight from the process.
   *
   * The renderer used to infer this from `navigator.userAgent`, which is wrong
   * twice over: UA sniffing is deprecated on Apple platforms, and the UA
   * describes the *browser engine*, not the binary Cowork is running as. An
   * x64 Electron build on Apple silicon reports "Intel" in its UA and was
   * therefore labelled `x64` in the settings overview.
   */
  arch: process.arch,

  // System theme
  getSystemTheme: () => ipcRenderer.invoke('system.getTheme'),

  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Open links in default browser
  openExternal: (url: string) => {
    // Sanitize mailto: URLs to strip dangerous query params that could attach files
    let safeUrl = url;
    if (/^mailto:/i.test(url)) {
      try {
        const parsed = new URL(url);
        parsed.searchParams.delete('attach');
        parsed.searchParams.delete('attachment');
        safeUrl = parsed.toString();
      } catch {
        // If URL parsing fails, block the call
        return Promise.resolve(false);
      }
    }
    return ipcRenderer.invoke('shell.openExternal', safeUrl);
  },
  showItemInFolder: (filePath: string, cwd?: string) =>
    ipcRenderer.invoke('shell.showItemInFolder', filePath, cwd),

  // Select files using native dialog
  selectFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog.selectFiles'),

  artifacts: {
    listRecentFiles: (
      cwd: string,
      sinceMs: number,
      limit = 50
    ): Promise<Array<{ path: string; modifiedAt: number; size: number }>> =>
      ipcRenderer.invoke('artifacts.listRecentFiles', cwd, sinceMs, Math.min(limit, 500)),
    readFile: (filePath: string): Promise<string> =>
      ipcRenderer.invoke('artifacts.readFile', filePath),
  },

  // Config methods
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke('config.get'),
    getPresets: (): Promise<ProviderPresets> => ipcRenderer.invoke('config.getPresets'),
    save: (config: Partial<AppConfig>): Promise<{ success: boolean; config: AppConfig }> =>
      ipcRenderer.invoke('config.save', config),
    createSet: (payload: CreateSetPayload): Promise<{ success: boolean; config: AppConfig }> =>
      ipcRenderer.invoke('config.createSet', payload),
    renameSet: (payload: {
      id: string;
      name: string;
    }): Promise<{ success: boolean; config: AppConfig }> =>
      ipcRenderer.invoke('config.renameSet', payload),
    deleteSet: (payload: { id: string }): Promise<{ success: boolean; config: AppConfig }> =>
      ipcRenderer.invoke('config.deleteSet', payload),
    switchSet: (payload: { id: string }): Promise<{ success: boolean; config: AppConfig }> =>
      ipcRenderer.invoke('config.switchSet', payload),
    isConfigured: (): Promise<boolean> => ipcRenderer.invoke('config.isConfigured'),
    test: (config: ApiTestInput): Promise<ApiTestResult> =>
      ipcRenderer.invoke('config.test', config),
    listModels: (payload: {
      provider: AppConfig['provider'];
      apiKey: string;
      baseUrl?: string;
    }): Promise<ProviderModelInfo[]> => ipcRenderer.invoke('config.listModels', payload),
    diagnose: (input: DiagnosticInput): Promise<DiagnosticResult> =>
      ipcRenderer.invoke('config.diagnose', input),
    discoverLocal: (payload?: { baseUrl?: string }): Promise<LocalOllamaDiscoveryResult> =>
      ipcRenderer.invoke('config.discover-local', payload),
  },

  /**
   * External secret managers (Bitwarden / 1Password).
   *
   * The renderer only ever selects a source and types a reference; the secret
   * itself is resolved in the main process and is never handed back except by
   * `testConfigSet`, which reports success plus a length rather than the value.
   */
  secrets: {
    probeSource: (kind: SecretSourceKind): Promise<SecretSourceProbe> =>
      ipcRenderer.invoke('secrets.probeSource', { kind }),
    testConfigSet: (configSetId: string): Promise<{ ok: boolean; detail: string }> =>
      ipcRenderer.invoke('secrets.testConfigSet', { configSetId }),
    getConflicts: (): Promise<
      Array<{ configSetId: string; kinds: SecretSourceKind[]; winner: SecretSourceKind }>
    > => ipcRenderer.invoke('secrets.getConflicts'),
    invalidate: (): Promise<{ success: boolean }> => ipcRenderer.invoke('secrets.invalidate'),
  },

  /**
   * Whole-app diagnostics. The report is built in the main process from real
   * probes (credentials of the ConfigSet in effect, workspace, sandbox,
   * storage, git) — the renderer only renders it.
   */
  diagnostics: {
    report: (sessionId?: string | null): Promise<HealthReport> =>
      ipcRenderer.invoke('diagnostics.report', { sessionId: sessionId ?? null }),
  },

  // Window control methods
  window: {
    minimize: () => ipcRenderer.send('window.minimize'),
    maximize: () => ipcRenderer.send('window.maximize'),
    close: () => ipcRenderer.send('window.close'),
  },

  // MCP methods
  mcp: {
    getServers: (): Promise<McpServerConfig[]> => ipcRenderer.invoke('mcp.getServers'),
    getServer: (serverId: string): Promise<McpServerConfig | undefined> =>
      ipcRenderer.invoke('mcp.getServer', serverId),
    saveServer: (config: McpServerConfig): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp.saveServer', config),
    deleteServer: (serverId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('mcp.deleteServer', serverId),
    getTools: (): Promise<McpTool[]> => ipcRenderer.invoke('mcp.getTools'),
    getServerStatus: (): Promise<McpServerStatus[]> => ipcRenderer.invoke('mcp.getServerStatus'),
    getPresets: (): Promise<McpPresetsMap> => ipcRenderer.invoke('mcp.getPresets'),
  },

  // Skills methods
  skills: {
    getAll: (): Promise<Skill[]> => ipcRenderer.invoke('skills.getAll'),
    install: (skillPath: string): Promise<{ success: boolean; skill: Skill }> =>
      ipcRenderer.invoke('skills.install', skillPath),
    delete: (skillId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('skills.delete', skillId),
    setEnabled: (skillId: string, enabled: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('skills.setEnabled', skillId, enabled),
    validate: (skillPath: string): Promise<{ valid: boolean; errors: string[] }> =>
      ipcRenderer.invoke('skills.validate', skillPath),
    getStoragePath: (): Promise<string> => ipcRenderer.invoke('skills.getStoragePath'),
    getRuntimeView: (): Promise<SkillRuntimeReport> =>
      ipcRenderer.invoke('skills.getRuntimeView'),
    setStoragePath: (
      targetPath: string,
      migrate = true
    ): Promise<{
      success: boolean;
      path: string;
      migratedCount: number;
      skippedCount: number;
      error?: string;
    }> => ipcRenderer.invoke('skills.setStoragePath', targetPath, migrate),
    openStoragePath: (): Promise<{ success: boolean; path: string; error?: string }> =>
      ipcRenderer.invoke('skills.openStoragePath'),
    // Proposed skills (sub-agent / synthesizer drafts awaiting MANUAL approval)
    listProposals: (): Promise<{
      success: boolean;
      proposals: Array<{
        name: string;
        description: string;
        proposedBy: string;
        proposedAt: number;
        version: number;
        rationale?: string;
        path: string;
        content: string;
      }>;
    }> => ipcRenderer.invoke('skills.listProposals'),
    approveProposal: (
      name: string,
      renameTo?: string
    ): Promise<{
      success: boolean;
      name?: string;
      path?: string;
      code?: 'invalid_name' | 'not_found' | 'name_conflict' | 'failed';
      error?: string;
    }> => ipcRenderer.invoke('skills.approveProposal', name, renameTo),
    rejectProposal: (name: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('skills.rejectProposal', name),
  },

  plugins: {
    listCatalog: (options?: { installableOnly?: boolean }): Promise<PluginCatalogItemV2[]> =>
      ipcRenderer.invoke('plugins.listCatalog', options),
    listInstalled: (): Promise<InstalledPlugin[]> => ipcRenderer.invoke('plugins.listInstalled'),
    install: (pluginName: string): Promise<PluginInstallResultV2> =>
      ipcRenderer.invoke('plugins.install', pluginName),
    setEnabled: (pluginId: string, enabled: boolean): Promise<PluginToggleResult> =>
      ipcRenderer.invoke('plugins.setEnabled', pluginId, enabled),
    setComponentEnabled: (
      pluginId: string,
      component: PluginComponentKind,
      enabled: boolean
    ): Promise<PluginToggleResult> =>
      ipcRenderer.invoke('plugins.setComponentEnabled', pluginId, component, enabled),
    uninstall: (pluginId: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('plugins.uninstall', pluginId),
  },

  // Sandbox methods
  sandbox: {
    getStatus: (): Promise<{
      platform: string;
      mode: string;
      initialized: boolean;
      wsl?: {
        available: boolean;
        distro?: string;
        nodeAvailable?: boolean;
        version?: string;
        pythonAvailable?: boolean;
        pythonVersion?: string;
        pipAvailable?: boolean;
        claudeCodeAvailable?: boolean;
      };
      lima?: {
        available: boolean;
        instanceExists?: boolean;
        instanceRunning?: boolean;
        instanceName?: string;
        nodeAvailable?: boolean;
        version?: string;
        pythonAvailable?: boolean;
        pythonVersion?: string;
        pipAvailable?: boolean;
        claudeCodeAvailable?: boolean;
      };
      error?: string;
    }> => ipcRenderer.invoke('sandbox.getStatus'),
    checkWSL: (): Promise<{
      available: boolean;
      distro?: string;
      nodeAvailable?: boolean;
      version?: string;
      pythonAvailable?: boolean;
      pythonVersion?: string;
      pipAvailable?: boolean;
      claudeCodeAvailable?: boolean;
    }> => ipcRenderer.invoke('sandbox.checkWSL'),
    checkLima: (): Promise<{
      available: boolean;
      instanceExists?: boolean;
      instanceRunning?: boolean;
      instanceName?: string;
      nodeAvailable?: boolean;
      version?: string;
      pythonAvailable?: boolean;
      pythonVersion?: string;
      pipAvailable?: boolean;
      claudeCodeAvailable?: boolean;
    }> => ipcRenderer.invoke('sandbox.checkLima'),
    installNodeInWSL: (distro: string): Promise<boolean> =>
      ipcRenderer.invoke('sandbox.installNodeInWSL', distro),
    installPythonInWSL: (distro: string): Promise<boolean> =>
      ipcRenderer.invoke('sandbox.installPythonInWSL', distro),
    installNodeInLima: (): Promise<boolean> => ipcRenderer.invoke('sandbox.installNodeInLima'),
    installPythonInLima: (): Promise<boolean> => ipcRenderer.invoke('sandbox.installPythonInLima'),
    startLimaInstance: (): Promise<boolean> => ipcRenderer.invoke('sandbox.startLimaInstance'),
    stopLimaInstance: (): Promise<boolean> => ipcRenderer.invoke('sandbox.stopLimaInstance'),
    retrySetup: (): Promise<{ success: boolean; error?: string; result?: unknown }> =>
      ipcRenderer.invoke('sandbox.retrySetup'),
    retryLimaSetup: (): Promise<{ success: boolean; error?: string; result?: unknown }> =>
      ipcRenderer.invoke('sandbox.retryLimaSetup'),
  },

  // Git methods — every command runs in the main process against the current
  // workspace; the renderer never spawns git itself.
  git: {
    listBranches: (): Promise<{
      isRepo: boolean;
      branches: Array<{ name: string; current: boolean }>;
      currentBranch: string | null;
      dirtyCount: number;
      repoRoot: string | null;
      error?: string;
    }> => ipcRenderer.invoke('git.listBranches'),
    isRepository: (): Promise<boolean> => ipcRenderer.invoke('git.isRepository'),
    checkoutBranch: (
      name: string,
      stash?: boolean
    ): Promise<{ ok: boolean; stashed: boolean; error?: string }> =>
      ipcRenderer.invoke('git.checkoutBranch', { name, stash: stash === true }),
    createBranch: (name: string): Promise<{ ok: boolean; stashed: boolean; error?: string }> =>
      ipcRenderer.invoke('git.createBranch', { name }),
  },

  // Logs methods
  logs: {
    getPath: (): Promise<string | null> => ipcRenderer.invoke('logs.getPath'),
    getDirectory: (): Promise<string> => ipcRenderer.invoke('logs.getDirectory'),
    getAll: (): Promise<Array<{ name: string; path: string; size: number; mtime: Date }>> =>
      ipcRenderer.invoke('logs.getAll'),
    export: (): Promise<{ success: boolean; path?: string; size?: number; error?: string }> =>
      ipcRenderer.invoke('logs.export'),
    open: (): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('logs.open'),
    clear: (): Promise<{ success: boolean; deletedCount?: number; error?: string }> =>
      ipcRenderer.invoke('logs.clear'),
    setEnabled: (
      enabled: boolean
    ): Promise<{ success: boolean; enabled?: boolean; error?: string }> =>
      ipcRenderer.invoke('logs.setEnabled', enabled),
    isEnabled: (): Promise<{ success: boolean; enabled?: boolean; error?: string }> =>
      ipcRenderer.invoke('logs.isEnabled'),
    write: (
      level: 'info' | 'warn' | 'error',
      ...args: unknown[]
    ): Promise<{ success: boolean; error?: string }> =>
      // The handler expects a single args array, not spread IPC arguments.
      ipcRenderer.invoke('logs.write', level, args),
  },

  // Local mods (function hooks)
  mods: {
    list: (): Promise<{
      success: boolean;
      mods: Array<{ id: string; label: string; description: string; enabled: boolean }>;
    }> => ipcRenderer.invoke('mods.list'),
    setEnabled: (id: string, enabled: boolean): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('mods.setEnabled', id, enabled),
  },

  // Live diff panel (session file changes)
  diff: {
    getSessionFiles: (
      sessionId: string
    ): Promise<{
      success: boolean;
      files: Array<{
        path: string;
        added: number;
        removed: number;
        updatedAt: number;
        before: string | null;
        after: string | null;
        diff: string;
      }>;
    }> => ipcRenderer.invoke('diff.getSessionFiles', sessionId),
  },

  // Local dev-server preview: a hardened, loopback-only child window.
  preview: {
    open: (
      url: string
    ): Promise<{
      success: boolean;
      error?: string;
      state: { open: boolean; url: string | null };
    }> => ipcRenderer.invoke('preview.open', url),
    close: (): Promise<{ open: boolean; url: string | null }> =>
      ipcRenderer.invoke('preview.close'),
    state: (): Promise<{ open: boolean; url: string | null }> =>
      ipcRenderer.invoke('preview.state'),
  },
  // Skill doctor (context cost analyzer)
  skillsDoctor: (): Promise<{
    success: boolean;
    report: {
      entries: Array<{
        name: string;
        path: string;
        tokenEstimate: number;
        useCount: number;
        lastUsedAt: number | null;
        recommendation: 'disable' | 'keep';
      }>;
      totalSkillTokens: number;
      contextWindow: number | null;
    } | null;
  }> => ipcRenderer.invoke('skills.doctor'),

  // Remote control methods
  remote: {
    getConfig: (): Promise<RemoteConfig> => ipcRenderer.invoke('remote.getConfig'),
    getStatus: (): Promise<{
      running: boolean;
      port?: number;
      publicUrl?: string;
      channels: Array<{ type: string; connected: boolean; error?: string }>;
      activeSessions: number;
      pendingPairings: number;
    }> => ipcRenderer.invoke('remote.getStatus'),
    setEnabled: (enabled: boolean): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('remote.setEnabled', enabled),
    updateGatewayConfig: (
      config: Partial<GatewayConfig>
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('remote.updateGatewayConfig', config),
    updateFeishuConfig: (
      config: FeishuChannelConfig
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('remote.updateFeishuConfig', config),
    getPairedUsers: (): Promise<PairedUser[]> => ipcRenderer.invoke('remote.getPairedUsers'),
    getPendingPairings: (): Promise<PairingRequest[]> =>
      ipcRenderer.invoke('remote.getPendingPairings'),
    approvePairing: (
      channelType: string,
      userId: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('remote.approvePairing', channelType, userId),
    revokePairing: (
      channelType: string,
      userId: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('remote.revokePairing', channelType, userId),
    rejectPairing: (
      channelType: string,
      userId: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('remote.rejectPairing', channelType, userId),
    getRemoteSessions: (): Promise<RemoteSessionMapping[]> =>
      ipcRenderer.invoke('remote.getRemoteSessions'),
    clearRemoteSession: (sessionId: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('remote.clearRemoteSession', sessionId),
    getTunnelStatus: (): Promise<{
      connected: boolean;
      url: string | null;
      provider: string;
      error?: string;
    }> => ipcRenderer.invoke('remote.getTunnelStatus'),
    getWebhookUrl: (): Promise<string | null> => ipcRenderer.invoke('remote.getWebhookUrl'),
    restart: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('remote.restart'),
  },

  schedule: {
    list: (): Promise<ScheduleTask[]> => ipcRenderer.invoke('schedule.list'),
    create: (payload: ScheduleCreateInput): Promise<ScheduleTask> =>
      ipcRenderer.invoke('schedule.create', payload),
    update: (id: string, updates: ScheduleUpdateInput): Promise<ScheduleTask | null> =>
      ipcRenderer.invoke('schedule.update', id, updates),
    delete: (id: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('schedule.delete', id),
    toggle: (id: string, enabled: boolean): Promise<ScheduleTask | null> =>
      ipcRenderer.invoke('schedule.toggle', id, enabled),
    runNow: (id: string): Promise<ScheduleTask | null> => ipcRenderer.invoke('schedule.runNow', id),
  },

  personalFiles: {
    list: () => ipcRenderer.invoke('personalFiles.list'),
    read: (path) => ipcRenderer.invoke('personalFiles.read', path),
    history: (path) => ipcRenderer.invoke('personalFiles.history', path),
    restore: (request) => ipcRenderer.invoke('personalFiles.restore', request),
  } satisfies PersonalFilesAPI,

  memory: {
    getOverview: (cwd?: string): Promise<MemoryOverview> =>
      ipcRenderer.invoke('memory.getOverview', cwd),
    search: (payload: {
      query: string;
      cwd?: string;
      sourceWorkspace?: string | null;
      scope?: MemorySearchScope;
      limit?: number;
    }): Promise<MemorySearchResult[]> => ipcRenderer.invoke('memory.search', payload),
    read: (id: string): Promise<MemoryReadResult | null> => ipcRenderer.invoke('memory.read', id),
    rebuildWorkspace: (cwd: string): Promise<{ success: boolean; workspaceKey: string }> =>
      ipcRenderer.invoke('memory.rebuildWorkspace', cwd),
    clearWorkspace: (cwd: string): Promise<{ success: boolean; workspaceKey: string }> =>
      ipcRenderer.invoke('memory.clearWorkspace', cwd),
    clearCoreMemory: (): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('memory.clearCoreMemory'),
    rebuildAll: (): Promise<{ success: boolean; workspaceCount: number; sessionCount: number }> =>
      ipcRenderer.invoke('memory.rebuildAll'),
    listFiles: (): Promise<MemoryDebugFileInfo[]> => ipcRenderer.invoke('memory.listFiles'),
    readFile: (filePath: string): Promise<MemoryDebugFileContent> =>
      ipcRenderer.invoke('memory.readFile', filePath),
    inspectSession: (
      sessionId: string,
      workspaceKey?: string
    ): Promise<MemoryInspectSessionResult | null> =>
      ipcRenderer.invoke('memory.inspectSession', sessionId, workspaceKey),
    setEnabled: (enabled: boolean): Promise<{ success: boolean; enabled: boolean }> =>
      ipcRenderer.invoke('memory.setEnabled', enabled),
  },

  workflow: {
    getState: (sessionId: string): Promise<WorkflowState | null> =>
      ipcRenderer.invoke('workflow.getState', sessionId),
    setMode: (sessionId: string, mode: WorkflowMode): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.setMode', sessionId, mode),
    loadContract: (
      sessionId: string,
      contract: CreateTaskContractInput,
      tasks: Array<Partial<AtomicTask> & Pick<AtomicTask, 'id' | 'title'>>
    ): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.loadContract', sessionId, contract, tasks),
    requestApproval: (sessionId: string): Promise<ApprovalRequest> =>
      ipcRenderer.invoke('workflow.requestApproval', sessionId),
    approve: (sessionId: string, decision: ApprovalDecisionInput): Promise<ApprovalOutcome> =>
      ipcRenderer.invoke('workflow.approve', sessionId, decision),
    startExecution: (sessionId: string): Promise<{ started: boolean; reasons: string[] }> =>
      ipcRenderer.invoke('workflow.startExecution', sessionId),

    startTask: (sessionId: string, taskId: string): Promise<TaskCheckpoint> =>
      ipcRenderer.invoke('workflow.startTask', sessionId, taskId),
    completeTask: (
      sessionId: string,
      taskId: string,
      evidence: NewCheckpointEvidence[]
    ): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.completeTask', sessionId, taskId, evidence),
    acceptTask: (sessionId: string, taskId: string): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.acceptTask', sessionId, taskId),
    restoreTask: (sessionId: string, taskId: string): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.restoreTask', sessionId, taskId),
    rejectTask: (sessionId: string, taskId: string, reason?: string): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.rejectTask', sessionId, taskId, reason),
    restorePlan: (sessionId: string): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.restorePlan', sessionId),
    verify: (sessionId: string): Promise<VerifyResult> =>
      ipcRenderer.invoke('workflow.verify', sessionId),
    planRoles: (sessionId: string, input: RolePlanInput): Promise<RoleAssignment[]> =>
      ipcRenderer.invoke('workflow.planRoles', sessionId, input),
    getAuditLog: (sessionId: string): Promise<AuditEntry[]> =>
      ipcRenderer.invoke('workflow.getAuditLog', sessionId),
    exportAuditLog: (
      sessionId: string,
      format?: 'json' | 'ndjson' | 'csv'
    ): Promise<string> => ipcRenderer.invoke('workflow.exportAuditLog', sessionId, format),
    planIsolation: (sessionId: string, taskIds?: string[]): Promise<IsolationPlan[]> =>
      ipcRenderer.invoke('workflow.planIsolation', sessionId, taskIds),
    createIsolation: (
      sessionId: string,
      plan: IsolationPlan
    ): Promise<{ plan: IsolationPlan; branch: string; created: boolean; error?: string }> =>
      ipcRenderer.invoke('workflow.createIsolation', sessionId, plan),
    isolationStatus: (sessionId: string): Promise<string[]> =>
      ipcRenderer.invoke('workflow.isolationStatus', sessionId),
    cleanupIsolation: (
      sessionId: string,
      taskId: string
    ): Promise<{ removed: boolean; reason?: string }> =>
      ipcRenderer.invoke('workflow.cleanupIsolation', sessionId, taskId),
    cleanupAllIsolation: (sessionId: string): Promise<string[]> =>
      ipcRenderer.invoke('workflow.cleanupAllIsolation', sessionId),
    executePlan: (sessionId: string): Promise<WorkflowExecutionReport> =>
      ipcRenderer.invoke('workflow.executePlan', sessionId),
    executeReadyTasks: (sessionId: string): Promise<TaskRunResult[]> =>
      ipcRenderer.invoke('workflow.executeReadyTasks', sessionId),
    pause: (sessionId: string): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.pause', sessionId),
    cancel: (sessionId: string): Promise<WorkflowState> =>
      ipcRenderer.invoke('workflow.cancel', sessionId),
    verifyTask: (sessionId: string, taskId: string): Promise<TaskVerification> =>
      ipcRenderer.invoke('workflow.verifyTask', sessionId, taskId),
    persist: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('workflow.persist', sessionId),
  },

  projectMemory: {
    overview: (sessionId: string): Promise<ProjectMemoryOverview> =>
      ipcRenderer.invoke('projectMemory.overview', sessionId),
    list: (sessionId: string, layer?: string): Promise<ProjectMemoryItem[]> =>
      ipcRenderer.invoke('projectMemory.list', sessionId, layer),
    upsert: (sessionId: string, input: UpsertMemoryInput): Promise<ProjectMemoryItem> =>
      ipcRenderer.invoke('projectMemory.upsert', sessionId, input),
    remove: (sessionId: string, id: string): Promise<{ removed: boolean }> =>
      ipcRenderer.invoke('projectMemory.remove', sessionId, id),
    clear: (sessionId: string, layer?: string): Promise<{ removed: number }> =>
      ipcRenderer.invoke('projectMemory.clear', sessionId, layer),
    purgeExpired: (sessionId: string): Promise<{ removed: string[] }> =>
      ipcRenderer.invoke('projectMemory.purgeExpired', sessionId),
    preview: (sessionId: string, query: string, limit?: number): Promise<MemoryInjection> =>
      ipcRenderer.invoke('projectMemory.preview', sessionId, query, limit),
    seedFromAudit: (sessionId: string, entries: AuditEntry[]): Promise<{ added: number }> =>
      ipcRenderer.invoke('projectMemory.seedFromAudit', sessionId, entries),
  },
  controlCenter: {
    snapshot: (sessionId: string): Promise<ControlCenterSnapshot> =>
      ipcRenderer.invoke('controlCenter.snapshot', sessionId),
    activity: (sessionId: string, limit?: number): Promise<ActivityEvent[]> =>
      ipcRenderer.invoke('controlCenter.activity', sessionId, limit),
    recordActivity: (sessionId: string, input: ActivityEventInput): Promise<ActivityEvent> =>
      ipcRenderer.invoke('controlCenter.recordActivity', sessionId, input),
    finishActivity: (
      sessionId: string,
      id: string,
      outcome: { status: ActivityStatus; error?: string; detail?: string }
    ): Promise<ActivityEvent | null> =>
      ipcRenderer.invoke('controlCenter.finishActivity', sessionId, id, outcome),
    clearActivity: (sessionId?: string): Promise<{ removed: number }> =>
      ipcRenderer.invoke('controlCenter.clearActivity', sessionId),
    workspaceTree: (
      sessionId: string,
      options?: WorkspaceTreeOptions
    ): Promise<WorkspaceEntry[]> =>
      ipcRenderer.invoke('controlCenter.workspaceTree', sessionId, options),
    readFile: (
      sessionId: string,
      relativePath: string,
      maxBytes?: number
    ): Promise<WorkspaceFileContent> =>
      ipcRenderer.invoke('controlCenter.readFile', sessionId, relativePath, maxBytes),
    gitStatus: (sessionId: string): Promise<GitStatusSummary | null> =>
      ipcRenderer.invoke('controlCenter.gitStatus', sessionId),
    runTests: (sessionId: string, commandId: TestCommandId): Promise<TestRunResult> =>
      ipcRenderer.invoke('controlCenter.runTests', sessionId, commandId),
    rerunFailedTests: (sessionId: string): Promise<RerunFailedTestsOutcome> =>
      ipcRenderer.invoke('controlCenter.rerunFailedTests', sessionId),
    openInEditor: (
      sessionId: string,
      filePath: string,
      line?: number
    ): Promise<{ success: boolean; method?: string; error?: string }> =>
      ipcRenderer.invoke('controlCenter.openInEditor', sessionId, filePath, line),
    queue: (sessionId?: string): Promise<DetachedTask[]> =>
      ipcRenderer.invoke('controlCenter.queue', sessionId),
    enqueueTask: (sessionId: string, input: DetachedTaskInput): Promise<DetachedTask> =>
      ipcRenderer.invoke('controlCenter.enqueueTask', sessionId, input),
    updateTask: (
      sessionId: string,
      id: string,
      status: DetachedTaskStatus,
      error?: string
    ): Promise<DetachedTask | null> =>
      ipcRenderer.invoke('controlCenter.updateTask', sessionId, id, status, error),
    cancelTask: (sessionId: string, id: string): Promise<DetachedTask | null> =>
      ipcRenderer.invoke('controlCenter.cancelTask', sessionId, id),
    notifications: (sessionId?: string): Promise<ApprovalNotification[]> =>
      ipcRenderer.invoke('controlCenter.notifications', sessionId),
    notify: (sessionId: string, input: NotificationInput): Promise<ApprovalNotification> =>
      ipcRenderer.invoke('controlCenter.notify', sessionId, input),
    acknowledgeNotification: (
      sessionId: string,
      id: string
    ): Promise<ApprovalNotification | null> =>
      ipcRenderer.invoke('controlCenter.acknowledgeNotification', sessionId, id),
    acknowledgeAll: (sessionId?: string): Promise<{ acknowledged: number }> =>
      ipcRenderer.invoke('controlCenter.acknowledgeAll', sessionId),
    terminalOpen: (sessionId: string, shell?: string): Promise<TerminalSnapshot> =>
      ipcRenderer.invoke('controlCenter.terminalOpen', sessionId, shell),
    terminalList: (sessionId: string): Promise<TerminalSessionInfo[]> =>
      ipcRenderer.invoke('controlCenter.terminalList', sessionId),
    terminalSnapshot: (
      sessionId: string,
      terminalId: string,
      sinceSeq?: number
    ): Promise<TerminalSnapshot> =>
      ipcRenderer.invoke('controlCenter.terminalSnapshot', sessionId, terminalId, sinceSeq),
    terminalWrite: (sessionId: string, terminalId: string, data: string): Promise<{ ok: true }> =>
      ipcRenderer.invoke('controlCenter.terminalWrite', sessionId, terminalId, data),
    terminalClear: (sessionId: string, terminalId: string): Promise<{ cleared: number }> =>
      ipcRenderer.invoke('controlCenter.terminalClear', sessionId, terminalId),
    terminalClose: (sessionId: string, terminalId: string): Promise<{ closed: boolean }> =>
      ipcRenderer.invoke('controlCenter.terminalClose', sessionId, terminalId),
  },

  modelRouting: {
    state: (): Promise<ModelRoutingState> => ipcRenderer.invoke('modelRouting.state'),
    setEnabled: (enabled: boolean): Promise<ModelRoutingState> =>
      ipcRenderer.invoke('modelRouting.setEnabled', enabled),
    setActiveProfile: (profile: ModelProfileId | null): Promise<ModelRoutingState> =>
      ipcRenderer.invoke('modelRouting.setActiveProfile', profile),
    profiles: (): Promise<ModelProfile[]> => ipcRenderer.invoke('modelRouting.profiles'),
    route: (request: RoutingRequest): Promise<RoutingDecision> =>
      ipcRenderer.invoke('modelRouting.route', request),
    benchmarks: (modelId?: string, taskKind?: TaskKind): Promise<ModelBenchmark[]> =>
      ipcRenderer.invoke('modelRouting.benchmarks', modelId, taskKind),
    recordBenchmark: (input: BenchmarkRecordInput): Promise<ModelBenchmark> =>
      ipcRenderer.invoke('modelRouting.recordBenchmark', input),
    clearBenchmarks: (): Promise<{ cleared: number }> =>
      ipcRenderer.invoke('modelRouting.clearBenchmarks'),
    probeLocal: (kind?: LocalProviderKind): Promise<LocalProviderProbe[]> =>
      ipcRenderer.invoke('modelRouting.probeLocal', kind),
    validateRegistry: (input: RegistryEntryInput): Promise<RegistryValidation> =>
      ipcRenderer.invoke('modelRouting.validateRegistry', input),
  },

  metrics: {
    history: (): Promise<ScenarioSuiteResult[]> => ipcRenderer.invoke('metrics.history'),
    compare: (baseline?: string, candidate?: string): Promise<MetricsDelta | null> =>
      ipcRenderer.invoke('metrics.compare', baseline, candidate),
    runSuite: (version?: string): Promise<ScenarioSuiteResult> =>
      ipcRenderer.invoke('metrics.runSuite', version),
    validateRouting: (): Promise<RoutingValidationReport> =>
      ipcRenderer.invoke('metrics.validateRouting'),
    clearHistory: (): Promise<{ cleared: number }> => ipcRenderer.invoke('metrics.clearHistory'),
  },
});

// Type declaration for the renderer process
declare global {
  interface Window {
    electronAPI: {
      send: (event: ClientEvent) => void;
      on: (callback: (event: ServerEvent) => void) => () => void;
      invoke: <T>(event: ClientEvent) => Promise<T>;
      session: {
        compact: (
          sessionId: string,
          customInstructions?: string
        ) => Promise<{
          summary: string;
          firstKeptEntryId: string;
          tokensBefore: number;
          details?: unknown;
        } | null>;
        getContextUsage: (sessionId: string) => Promise<{
          tokens: number | null;
          contextWindow: number;
          percent: number | null;
        } | null>;
        setConfigOverride: (
          sessionId: string,
          configSetId: string | null,
          modelId: string | null
        ) => Promise<{ success: boolean; error?: string }>;
      };
      projects: {
        create: (payload: {
          name: string;
          workdir: string;
          description?: string;
          configSetId?: string;
          modelId?: string;
          pipelineMode?: PipelineMode;
          draftConfigSetId?: string;
          draftModelId?: string;
          refineConfigSetId?: string;
          refineModelId?: string;
          instructions?: string;
        }) => Promise<{ success: boolean; project?: Project; error?: string }>;
        list: (
          includeArchived?: boolean
        ) => Promise<{ success: boolean; projects: Project[] }>;
        get: (
          projectId: string
        ) => Promise<{
          success: boolean;
          project?: Project;
          sessions?: Array<{
            id: string;
            title: string;
            status: string;
            cwd: string | null;
            updated_at: number;
          }>;
          usage?: ProjectContextUsage;
          error?: string;
        }>;
        update: (payload: {
          projectId: string;
          name?: string;
          description?: string | null;
          workdir?: string;
          configSetId?: string | null;
          modelId?: string | null;
          pipelineMode?: PipelineMode;
          draftConfigSetId?: string | null;
          draftModelId?: string | null;
          refineConfigSetId?: string | null;
          refineModelId?: string | null;
          instructions?: string | null;
        }) => Promise<{ success: boolean; project?: Project; error?: string }>;
        archive: (
          projectId: string,
          archived: boolean
        ) => Promise<{ success: boolean; project?: Project; error?: string }>;
        attachFile: (
          projectId: string,
          path: string
        ) => Promise<{ success: boolean; project?: Project; error?: string }>;
        detachFile: (
          projectId: string,
          path: string
        ) => Promise<{ success: boolean; project?: Project; error?: string }>;
        linkSession: (
          projectId: string,
          sessionId: string
        ) => Promise<{ success: boolean; error?: string }>;
        unlinkSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
        delete: (
          projectId: string
        ) => Promise<{
          success: boolean;
          orphanedSessions?: number;
          removedReferenceFiles?: number;
          error?: string;
        }>;
      };
      /** Session deletion — the renderer's session list lives here. */
      sessions: {
        delete: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
      };
      backgroundTasks: {
        list: (sessionId?: string) => Promise<{ success: boolean; tasks: BackgroundTask[] }>;
        get: (
          taskId: string
        ) => Promise<{ success: boolean; task?: BackgroundTask; error?: string }>;
        cancel: (
          taskId: string
        ) => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
        retry: (
          taskId: string
        ) => Promise<{ success: boolean; taskId?: string; error?: string }>;
        delete: (
          taskId: string
        ) => Promise<{ success: boolean; deleted?: boolean; error?: string }>;
        getSettings: () => Promise<{
          success: boolean;
          settings?: DelegationSettings;
          error?: string;
        }>;
        getStats: () => Promise<{
          success: boolean;
          swarm?: SwarmStats;
          delegations?: DelegationStats;
          error?: string;
        }>;
        setSettings: (next: {
          configSetId?: string;
          modelId?: string | null;
          timeoutMs?: number;
          maxConcurrent?: number;
          notifyOnCompletion?: boolean;
          resumeOnRestart?: boolean;
          detachedExecution?: boolean;
          detachedAutoApprove?: boolean;
        }) => Promise<{ success: boolean; settings?: DelegationSettings; error?: string }>;
      };
      document: {
        read: (
          cwd: string,
          path: string
        ) => Promise<{
          success: boolean;
          ok?: boolean;
          content?: string;
          mtimeMs?: number;
          error?: string;
        }>;
        write: (
          cwd: string,
          path: string,
          content: string,
          options?: { baseMtimeMs?: number; force?: boolean }
        ) => Promise<{
          success: boolean;
          ok?: boolean;
          status?: 'written' | 'conflict' | 'error';
          mtimeMs?: number;
          error?: string;
        }>;
        list: (
          cwd: string
        ) => Promise<{
          success: boolean;
          files?: Array<{ path: string; mtimeMs: number }>;
          error?: string;
        }>;
      };
      platform: NodeJS.Platform;
      /**
       * CPU architecture of the running app (`process.arch`). Always defined;
       * falls back to `x64` where it is somehow absent so the settings overview
       * degrades instead of throwing.
       */
      arch: string;
      getSystemTheme: () => Promise<{ shouldUseDarkColors: boolean }>;
      getVersion: () => Promise<string>;
      openExternal: (url: string) => Promise<boolean>;
      showItemInFolder: (filePath: string, cwd?: string) => Promise<boolean>;
      selectFiles: () => Promise<string[]>;
      artifacts: {
        listRecentFiles: (
          cwd: string,
          sinceMs: number,
          limit?: number
        ) => Promise<Array<{ path: string; modifiedAt: number; size: number }>>;
        readFile: (filePath: string) => Promise<string>;
      };
      diagnostics: {
        report: (sessionId?: string | null) => Promise<HealthReport>;
      };
      config: {
        get: () => Promise<AppConfig>;
        getPresets: () => Promise<ProviderPresets>;
        save: (config: Partial<AppConfig>) => Promise<{ success: boolean; config: AppConfig }>;
        createSet: (payload: CreateSetPayload) => Promise<{ success: boolean; config: AppConfig }>;
        renameSet: (payload: {
          id: string;
          name: string;
        }) => Promise<{ success: boolean; config: AppConfig }>;
        deleteSet: (payload: { id: string }) => Promise<{ success: boolean; config: AppConfig }>;
        switchSet: (payload: { id: string }) => Promise<{ success: boolean; config: AppConfig }>;
        isConfigured: () => Promise<boolean>;
        test: (config: ApiTestInput) => Promise<ApiTestResult>;
        listModels: (payload: {
          provider: AppConfig['provider'];
          apiKey: string;
          baseUrl?: string;
        }) => Promise<ProviderModelInfo[]>;
        diagnose: (input: DiagnosticInput) => Promise<DiagnosticResult>;
        discoverLocal: (payload?: { baseUrl?: string }) => Promise<LocalOllamaDiscoveryResult>;
      };
      secrets: {
        probeSource: (kind: SecretSourceKind) => Promise<SecretSourceProbe>;
        testConfigSet: (configSetId: string) => Promise<{ ok: boolean; detail: string }>;
        getConflicts: () => Promise<
          Array<{ configSetId: string; kinds: SecretSourceKind[]; winner: SecretSourceKind }>
        >;
        invalidate: () => Promise<{ success: boolean }>;
      };
      window: {
        minimize: () => void;
        maximize: () => void;
        close: () => void;
      };
      mcp: {
        getServers: () => Promise<McpServerConfig[]>;
        getServer: (serverId: string) => Promise<McpServerConfig | undefined>;
        saveServer: (config: McpServerConfig) => Promise<{ success: boolean; error?: string }>;
        deleteServer: (serverId: string) => Promise<{ success: boolean }>;
        getTools: () => Promise<McpTool[]>;
        getServerStatus: () => Promise<McpServerStatus[]>;
        getPresets: () => Promise<McpPresetsMap>;
      };
      skills: {
        getAll: () => Promise<Skill[]>;
        install: (skillPath: string) => Promise<{ success: boolean; skill: Skill }>;
        delete: (skillId: string) => Promise<{ success: boolean }>;
        setEnabled: (skillId: string, enabled: boolean) => Promise<{ success: boolean }>;
        validate: (skillPath: string) => Promise<{ valid: boolean; errors: string[] }>;
        getStoragePath: () => Promise<string>;
        getRuntimeView: () => Promise<SkillRuntimeReport>;
        setStoragePath: (
          targetPath: string,
          migrate?: boolean
        ) => Promise<{
          success: boolean;
          path: string;
          migratedCount: number;
          skippedCount: number;
          error?: string;
        }>;
        openStoragePath: () => Promise<{ success: boolean; path: string; error?: string }>;
        listProposals: () => Promise<{
          success: boolean;
          proposals: Array<{
            name: string;
            description: string;
            proposedBy: string;
            proposedAt: number;
            version: number;
            rationale?: string;
            path: string;
            content: string;
          }>;
        }>;
        approveProposal: (
          name: string,
          renameTo?: string
        ) => Promise<{
          success: boolean;
          name?: string;
          path?: string;
          code?: 'invalid_name' | 'not_found' | 'name_conflict' | 'failed';
          error?: string;
        }>;
        rejectProposal: (name: string) => Promise<{ success: boolean; error?: string }>;
      };
      plugins: {
        listCatalog: (options?: { installableOnly?: boolean }) => Promise<PluginCatalogItemV2[]>;
        listInstalled: () => Promise<InstalledPlugin[]>;
        install: (pluginName: string) => Promise<PluginInstallResultV2>;
        setEnabled: (pluginId: string, enabled: boolean) => Promise<PluginToggleResult>;
        setComponentEnabled: (
          pluginId: string,
          component: PluginComponentKind,
          enabled: boolean
        ) => Promise<PluginToggleResult>;
        uninstall: (pluginId: string) => Promise<{ success: boolean }>;
      };
      sandbox: {
        getStatus: () => Promise<{
          platform: string;
          mode: string;
          initialized: boolean;
          wsl?: {
            available: boolean;
            distro?: string;
            nodeAvailable?: boolean;
            version?: string;
            pythonAvailable?: boolean;
            pythonVersion?: string;
            pipAvailable?: boolean;
            claudeCodeAvailable?: boolean;
          };
          lima?: {
            available: boolean;
            instanceExists?: boolean;
            instanceRunning?: boolean;
            instanceName?: string;
            nodeAvailable?: boolean;
            version?: string;
            pythonAvailable?: boolean;
            pythonVersion?: string;
            pipAvailable?: boolean;
            claudeCodeAvailable?: boolean;
          };
          error?: string;
        }>;
        checkWSL: () => Promise<{
          available: boolean;
          distro?: string;
          nodeAvailable?: boolean;
          version?: string;
          pythonAvailable?: boolean;
          pythonVersion?: string;
          pipAvailable?: boolean;
          claudeCodeAvailable?: boolean;
        }>;
        checkLima: () => Promise<{
          available: boolean;
          instanceExists?: boolean;
          instanceRunning?: boolean;
          instanceName?: string;
          nodeAvailable?: boolean;
          version?: string;
          pythonAvailable?: boolean;
          pythonVersion?: string;
          pipAvailable?: boolean;
          claudeCodeAvailable?: boolean;
        }>;
        installNodeInWSL: (distro: string) => Promise<boolean>;
        installPythonInWSL: (distro: string) => Promise<boolean>;
        installNodeInLima: () => Promise<boolean>;
        installPythonInLima: () => Promise<boolean>;
        startLimaInstance: () => Promise<boolean>;
        stopLimaInstance: () => Promise<boolean>;
        retrySetup: () => Promise<{ success: boolean; error?: string; result?: unknown }>;
        retryLimaSetup: () => Promise<{ success: boolean; error?: string; result?: unknown }>;
      };
      git: {
        listBranches: () => Promise<{
          isRepo: boolean;
          branches: Array<{ name: string; current: boolean }>;
          currentBranch: string | null;
          dirtyCount: number;
          repoRoot: string | null;
          error?: string;
        }>;
        isRepository: () => Promise<boolean>;
        checkoutBranch: (
          name: string,
          stash?: boolean
        ) => Promise<{ ok: boolean; stashed: boolean; error?: string }>;
        createBranch: (name: string) => Promise<{ ok: boolean; stashed: boolean; error?: string }>;
      };
      logs: {
        getPath: () => Promise<string | null>;
        getDirectory: () => Promise<string>;
        getAll: () => Promise<Array<{ name: string; path: string; size: number; mtime: Date }>>;
        export: () => Promise<{ success: boolean; path?: string; size?: number; error?: string }>;
        open: () => Promise<{ success: boolean; error?: string }>;
        clear: () => Promise<{ success: boolean; deletedCount?: number; error?: string }>;
        setEnabled: (
          enabled: boolean
        ) => Promise<{ success: boolean; enabled?: boolean; error?: string }>;
        isEnabled: () => Promise<{ success: boolean; enabled?: boolean; error?: string }>;
        write: (
          level: 'info' | 'warn' | 'error',
          ...args: unknown[]
        ) => Promise<{ success: boolean; error?: string }>;
      };
      remote: {
        getConfig: () => Promise<RemoteConfig>;
        getStatus: () => Promise<{
          running: boolean;
          port?: number;
          publicUrl?: string;
          channels: Array<{ type: string; connected: boolean; error?: string }>;
          activeSessions: number;
          pendingPairings: number;
        }>;
        setEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
        updateGatewayConfig: (
          config: Partial<GatewayConfig>
        ) => Promise<{ success: boolean; error?: string }>;
        updateFeishuConfig: (
          config: FeishuChannelConfig
        ) => Promise<{ success: boolean; error?: string }>;
        getPairedUsers: () => Promise<PairedUser[]>;
        getPendingPairings: () => Promise<PairingRequest[]>;
        approvePairing: (
          channelType: string,
          userId: string
        ) => Promise<{ success: boolean; error?: string }>;
        revokePairing: (
          channelType: string,
          userId: string
        ) => Promise<{ success: boolean; error?: string }>;
        rejectPairing: (
          channelType: string,
          userId: string
        ) => Promise<{ success: boolean; error?: string }>;
        getRemoteSessions: () => Promise<RemoteSessionMapping[]>;
        clearRemoteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
        getTunnelStatus: () => Promise<{
          connected: boolean;
          url: string | null;
          provider: string;
          error?: string;
        }>;
        getWebhookUrl: () => Promise<string | null>;
        restart: () => Promise<{ success: boolean; error?: string }>;
      };
      schedule: {
        list: () => Promise<ScheduleTask[]>;
        create: (payload: ScheduleCreateInput) => Promise<ScheduleTask>;
        update: (id: string, updates: ScheduleUpdateInput) => Promise<ScheduleTask | null>;
        delete: (id: string) => Promise<{ success: boolean }>;
        toggle: (id: string, enabled: boolean) => Promise<ScheduleTask | null>;
        runNow: (id: string) => Promise<ScheduleTask | null>;
      };
      personalFiles: PersonalFilesAPI;
      mods: {
        list: () => Promise<{
          success: boolean;
          mods: Array<{ id: string; label: string; description: string; enabled: boolean }>;
        }>;
        setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>;
      };
      diff: {
        getSessionFiles: (
          sessionId: string
        ) => Promise<{
          success: boolean;
          files: Array<{
            path: string;
            added: number;
            removed: number;
            updatedAt: number;
            before: string | null;
            after: string | null;
            diff: string;
          }>;
        }>;
      };
      preview: {
        open: (
          url: string
        ) => Promise<{
          success: boolean;
          error?: string;
          state: { open: boolean; url: string | null };
        }>;
        close: () => Promise<{ open: boolean; url: string | null }>;
        state: () => Promise<{ open: boolean; url: string | null }>;
      };
      skillsDoctor: () => Promise<{
        success: boolean;
        report: {
          entries: Array<{
            name: string;
            path: string;
            tokenEstimate: number;
            useCount: number;
            lastUsedAt: number | null;
            recommendation: 'disable' | 'keep';
          }>;
          totalSkillTokens: number;
          contextWindow: number | null;
        } | null;
      }>;
      memory: {
        getOverview: (cwd?: string) => Promise<MemoryOverview>;
        search: (payload: {
          query: string;
          cwd?: string;
          sourceWorkspace?: string | null;
          scope?: MemorySearchScope;
          limit?: number;
        }) => Promise<MemorySearchResult[]>;
        read: (id: string) => Promise<MemoryReadResult | null>;
        rebuildWorkspace: (cwd: string) => Promise<{ success: boolean; workspaceKey: string }>;
        clearWorkspace: (cwd: string) => Promise<{ success: boolean; workspaceKey: string }>;
        clearCoreMemory: () => Promise<{ success: boolean }>;
        rebuildAll: () => Promise<{
          success: boolean;
          workspaceCount: number;
          sessionCount: number;
        }>;
        listFiles: () => Promise<MemoryDebugFileInfo[]>;
        readFile: (filePath: string) => Promise<MemoryDebugFileContent>;
        inspectSession: (
          sessionId: string,
          workspaceKey?: string
        ) => Promise<MemoryInspectSessionResult | null>;
        setEnabled: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>;
      };
      workflow: {
        getState: (sessionId: string) => Promise<WorkflowState | null>;
        setMode: (sessionId: string, mode: WorkflowMode) => Promise<WorkflowState>;
        loadContract: (
          sessionId: string,
          contract: CreateTaskContractInput,
          tasks: Array<Partial<AtomicTask> & Pick<AtomicTask, 'id' | 'title'>>
        ) => Promise<WorkflowState>;
        requestApproval: (sessionId: string) => Promise<ApprovalRequest>;
        approve: (
          sessionId: string,
          decision: ApprovalDecisionInput
        ) => Promise<ApprovalOutcome>;
        startExecution: (sessionId: string) => Promise<{ started: boolean; reasons: string[] }>;

        startTask: (sessionId: string, taskId: string) => Promise<TaskCheckpoint>;
        completeTask: (
          sessionId: string,
          taskId: string,
          evidence: NewCheckpointEvidence[]
        ) => Promise<WorkflowState>;
        acceptTask: (sessionId: string, taskId: string) => Promise<WorkflowState>;
        restoreTask: (sessionId: string, taskId: string) => Promise<WorkflowState>;
        rejectTask: (sessionId: string, taskId: string, reason?: string) => Promise<WorkflowState>;
        restorePlan: (sessionId: string) => Promise<WorkflowState>;
        verify: (sessionId: string) => Promise<VerifyResult>;
        planRoles: (sessionId: string, input: RolePlanInput) => Promise<RoleAssignment[]>;
        getAuditLog: (sessionId: string) => Promise<AuditEntry[]>;
        exportAuditLog: (
          sessionId: string,
          format?: 'json' | 'ndjson' | 'csv'
        ) => Promise<string>;
        planIsolation: (sessionId: string, taskIds?: string[]) => Promise<IsolationPlan[]>;
        createIsolation: (
          sessionId: string,
          plan: IsolationPlan
        ) => Promise<{ plan: IsolationPlan; branch: string; created: boolean; error?: string }>;
        isolationStatus: (sessionId: string) => Promise<string[]>;
        cleanupIsolation: (
          sessionId: string,
          taskId: string
        ) => Promise<{ removed: boolean; reason?: string }>;
        cleanupAllIsolation: (sessionId: string) => Promise<string[]>;
        executePlan: (sessionId: string) => Promise<WorkflowExecutionReport>;
        executeReadyTasks: (sessionId: string) => Promise<TaskRunResult[]>;
        pause: (sessionId: string) => Promise<WorkflowState>;
        cancel: (sessionId: string) => Promise<WorkflowState>;
        verifyTask: (sessionId: string, taskId: string) => Promise<TaskVerification>;
        persist: (sessionId: string) => Promise<boolean>;
      };
      projectMemory: {
        overview: (sessionId: string) => Promise<ProjectMemoryOverview>;
        list: (sessionId: string, layer?: string) => Promise<ProjectMemoryItem[]>;
        upsert: (sessionId: string, input: UpsertMemoryInput) => Promise<ProjectMemoryItem>;
        remove: (sessionId: string, id: string) => Promise<{ removed: boolean }>;
        clear: (sessionId: string, layer?: string) => Promise<{ removed: number }>;
        purgeExpired: (sessionId: string) => Promise<{ removed: string[] }>;
        preview: (sessionId: string, query: string, limit?: number) => Promise<MemoryInjection>;
        seedFromAudit: (sessionId: string, entries: AuditEntry[]) => Promise<{ added: number }>;
      };
      controlCenter: {
        snapshot: (sessionId: string) => Promise<ControlCenterSnapshot>;
        activity: (sessionId: string, limit?: number) => Promise<ActivityEvent[]>;
        recordActivity: (sessionId: string, input: ActivityEventInput) => Promise<ActivityEvent>;
        finishActivity: (
          sessionId: string,
          id: string,
          outcome: { status: ActivityStatus; error?: string; detail?: string }
        ) => Promise<ActivityEvent | null>;
        clearActivity: (sessionId?: string) => Promise<{ removed: number }>;
        workspaceTree: (sessionId: string, options?: WorkspaceTreeOptions) => Promise<WorkspaceEntry[]>;
        readFile: (
          sessionId: string,
          relativePath: string,
          maxBytes?: number
        ) => Promise<WorkspaceFileContent>;
        gitStatus: (sessionId: string) => Promise<GitStatusSummary | null>;
        runTests: (sessionId: string, commandId: TestCommandId) => Promise<TestRunResult>;
        rerunFailedTests: (sessionId: string) => Promise<RerunFailedTestsOutcome>;
        openInEditor: (
          sessionId: string,
          filePath: string,
          line?: number
        ) => Promise<{ success: boolean; method?: string; error?: string }>;
        queue: (sessionId?: string) => Promise<DetachedTask[]>;
        enqueueTask: (sessionId: string, input: DetachedTaskInput) => Promise<DetachedTask>;
        updateTask: (
          sessionId: string,
          id: string,
          status: DetachedTaskStatus,
          error?: string
        ) => Promise<DetachedTask | null>;
        cancelTask: (sessionId: string, id: string) => Promise<DetachedTask | null>;
        notifications: (sessionId?: string) => Promise<ApprovalNotification[]>;
        notify: (sessionId: string, input: NotificationInput) => Promise<ApprovalNotification>;
        acknowledgeNotification: (
          sessionId: string,
          id: string
        ) => Promise<ApprovalNotification | null>;
        acknowledgeAll: (sessionId?: string) => Promise<{ acknowledged: number }>;
        terminalOpen: (sessionId: string, shell?: string) => Promise<TerminalSnapshot>;
        terminalList: (sessionId: string) => Promise<TerminalSessionInfo[]>;
        terminalSnapshot: (
          sessionId: string,
          terminalId: string,
          sinceSeq?: number
        ) => Promise<TerminalSnapshot>;
        terminalWrite: (
          sessionId: string,
          terminalId: string,
          data: string
        ) => Promise<{ ok: true }>;
        terminalClear: (sessionId: string, terminalId: string) => Promise<{ cleared: number }>;
        terminalClose: (sessionId: string, terminalId: string) => Promise<{ closed: boolean }>;
      };
      modelRouting: {
        state: () => Promise<ModelRoutingState>;
        setEnabled: (enabled: boolean) => Promise<ModelRoutingState>;
        setActiveProfile: (profile: ModelProfileId | null) => Promise<ModelRoutingState>;
        profiles: () => Promise<ModelProfile[]>;
        route: (request: RoutingRequest) => Promise<RoutingDecision>;
        benchmarks: (modelId?: string, taskKind?: TaskKind) => Promise<ModelBenchmark[]>;
        recordBenchmark: (input: BenchmarkRecordInput) => Promise<ModelBenchmark>;
        clearBenchmarks: () => Promise<{ cleared: number }>;
        probeLocal: (kind?: LocalProviderKind) => Promise<LocalProviderProbe[]>;
        validateRegistry: (input: RegistryEntryInput) => Promise<RegistryValidation>;
      };
      metrics: {
        history: () => Promise<ScenarioSuiteResult[]>;
        compare: (baseline?: string, candidate?: string) => Promise<MetricsDelta | null>;
        runSuite: (version?: string) => Promise<ScenarioSuiteResult>;
        validateRouting: () => Promise<RoutingValidationReport>;
        clearHistory: () => Promise<{ cleared: number }>;
      };
    };
  }
}
