/**
 * @module main/session/session-manager
 *
 * Session lifecycle manager.
 *
 * Responsibilities:
 * - Session CRUD: create, continue, stop, delete, list
 * - Chat history persistence to SQLite via DatabaseInstance
 * - Workspace-scoped sessions with sandbox integration
 * - Delegates AI execution to CoworkAgentRunner
 *
 * Dependencies: database, agent-runner, config-store, mcp-manager, sandbox-adapter
 */
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import type {
  Session,
  Message,
  ServerEvent,
  PermissionResult,
  ContentBlock,
  TextContent,
  TraceStep,
  FileAttachmentContent,
  ImageContent,
} from '../../shared/types';
import type { DatabaseInstance, TraceStepRow } from '../db/database';
import { PathResolver } from '../sandbox/path-resolver';
import {
  SandboxAdapter,
  getSandboxAdapter,
  initializeSandbox,
  reinitializeSandbox,
} from '../sandbox/sandbox-adapter';
import { SandboxSync } from '../sandbox/sandbox-sync';
import { CoworkAgentRunner } from '../agent/agent-runner';
import type { ActivityTracker } from '../agent/activity-tracker';
import type { SkillsAdapter } from '../skills/skills-adapter';
import type { NotificationCenter } from '../agent/notification-center';
import { summarizeToolActivityDetail } from '../agent/tool-activity-recorder';
import { configStore } from '../config/config-store';
import { MCPManager } from '../mcp/mcp-manager';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import { PluginRuntimeService } from '../skills/plugin-runtime-service';
import { AgentRuntimeExtensionManager } from '../extensions/agent-runtime-extension-manager';
import { MemoryManager } from '../memory/memory-manager';
import { forgetSessionPermissions } from '../config/permission-rules-store';

/** Plain text out of a stored message body (JSON-encoded content blocks). */
function extractMessageText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'string') return parsed.trim();
    if (!Array.isArray(parsed)) return '';
    return (parsed as Array<{ type?: unknown; text?: unknown }>)
      .map((block) =>
        block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''
      )
      .join('')
      .trim();
  } catch {
    return '';
  }
}
import {
  log,
  logError,
  logWarn,
  logCtx,
  logCtxError,
  runWithLogContext,
  generateTraceId,
} from '../utils/logger';
import { maybeGenerateSessionTitle } from './session-title-flow';
import {
  buildTitlePrompt,
  getDefaultTitleFromPrompt,
  normalizeGeneratedTitle,
} from './session-title-utils';
import { generateTitleWithSdk } from '../agent/sdk-one-shot';
import { buildFallbackCandidates, selectOverflowFallback } from '../agent/provider-fallback';
import { isContextOverflowError } from '../agent/context-overflow';
import {
  resolveEffectiveContextWindow,
} from '../agent/learned-context-limits';
import { buildScheduledTaskTitle } from '../../shared/schedule/task-title';
import { buildAttachmentPromptHints } from './attachment-hints';

/**
 * Outcome of one run attempt, as the session manager sees it. Declared
 * structurally (rather than imported from the runner) so this module keeps its
 * no-agent-import testability; the runner's AgentRunResult is assignable to it.
 * Every non-void result carries flushError, so the caller never has to
 * distinguish "new-style runner" from mocks: call first.flushError?.() where a
 * direct call is not guaranteed.
 */
interface AgentRunAttempt {
  ok: boolean;
  /** True when the failure may be replayed on another provider. */
  retryable: boolean;
  errorCode?: string;
  /** Raw error text as classified — drives overflow detection. */
  errorText?: string;
  /** Tool calls started during the attempt; non-zero blocks any replay. */
  toolExecutions?: number;
  /** Publishes the error the runner held back while a retry was possible. */
  flushError?(): void;
}

interface AgentRunner {
  /**
   * Runs one turn. Returns the attempt outcome so the caller can decide about a
   * provider retry; a runner that predates the fallback simply resolves void.
   */
  run(
    session: Session,
    prompt: string,
    existingMessages: Message[]
  ): Promise<AgentRunAttempt | void>;
  cancel(sessionId: string): void;
  clearSdkSession?(sessionId: string): void;
  clearAllSdkSessions?(): void;
  compact?(
    sessionId: string,
    customInstructions?: string
  ): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  } | null>;
  getContextUsage?(
    sessionId: string
  ): { tokens: number | null; contextWindow: number; percent: number | null } | null;
  /** Phase 6 control center: attach or clear the tool activity sink. */
  setActivityTracker?(tracker?: ActivityTracker): void;
  /** Phase 7 model routing: attach or clear the adaptive model resolver. */
  setModelResolver?(
    resolver?: (input: { sessionId: string; prompt: string; fallbackModel: string }) =>
      | string
      | undefined
  ): void;
  /** Phase 7 model routing: attach or clear the local benchmark sink. */
  setBenchmarkRecorder?(
    recorder?: (input: {
      modelId: string;
      prompt: string;
      success: boolean;
      latencyMs: number;
    }) => void
  ): void;
}

const WORKSPACE_MOUNT_VIRTUAL_PATH = '/mnt/workspace';
const TITLE_GENERATION_TIMEOUT_MS = 20000;

/** File extension for each inline image MIME type a paste can produce. */
const PASTED_IMAGE_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export class SessionManager {
  private db: DatabaseInstance;
  private sendToRenderer: (event: ServerEvent) => void;
  private pathResolver: PathResolver;
  private sandboxAdapter: SandboxAdapter;
  private agentRunner!: AgentRunner;
  private mcpManager: MCPManager;
  private pluginRuntimeService?: PluginRuntimeService;
  private extensionManager?: AgentRuntimeExtensionManager;
  /** Phase 6 control center: tool activity sink, injected after construction. */
  private activityTracker?: ActivityTracker;
  /** Resolves which skills the runner hands to the resource loader. */
  private skillsAdapter?: SkillsAdapter;
  /** Phase 6 control center: approval/blocker notifications, injected later. */
  private notificationCenter?: NotificationCenter;
  /** Phase 7 model routing: adaptive model selection, injected later. */
  private modelResolver?: (input: {
    sessionId: string;
    prompt: string;
    fallbackModel: string;
  }) => string | undefined;
  /** Phase 7 model routing: local benchmark sink, injected later. */
  private benchmarkRecorder?: (input: {
    modelId: string;
    prompt: string;
    success: boolean;
    latencyMs: number;
  }) => void;
  private activeSessions: Map<string, AbortController> = new Map();
  private promptQueues: Map<string, Array<{ prompt: string; content?: ContentBlock[] }>> =
    new Map();
  private pendingPermissions: Map<string, (result: PermissionResult) => void> = new Map();
  private pendingSudoPasswords: Map<
    string,
    { sessionId: string; resolve: (password: string | null) => void }
  > = new Map();
  private sandboxInitPromises: Map<string, Promise<void>> = new Map();
  private sessionTitleAttempts: Set<string> = new Set();
  private titleGenerationTokens: Map<string, symbol> = new Map();
  private messageCache: Map<string, Message[]> = new Map();
  private static readonly MAX_CACHE_SIZE = 100;
  private memoryManager?: MemoryManager;

  constructor(
    db: DatabaseInstance,
    sendToRenderer: (event: ServerEvent) => void,
    pluginRuntimeService?: PluginRuntimeService,
    extensionManager?: AgentRuntimeExtensionManager
  ) {
    this.db = db;
    this.sendToRenderer = (event) => {
      if (event.type === 'trace.step') {
        this.saveTraceStep(event.payload.sessionId, event.payload.step);
      }
      if (event.type === 'trace.update') {
        this.updateTraceStep(event.payload.stepId, event.payload.updates);
      }
      sendToRenderer(event);
    };
    this.pathResolver = new PathResolver();
    this.sandboxAdapter = getSandboxAdapter();
    this.pluginRuntimeService = pluginRuntimeService;
    this.extensionManager = extensionManager;

    // Initialize MCP Manager
    this.mcpManager = new MCPManager();
    this.initializeMCP();

    // Create agent runner based on current config
    this.createAgentRunner();

    log('[SessionManager] Initialized with persistent database and MCP support');
  }

  /**
   * Create agent runner based on current config
   * Can be called to recreate runner when config changes
   */
  private createAgentRunner(): void {
    this.agentRunner = this.createCoworkAgentRunner();
    log('[SessionManager] Using Open Cowork agent runner');
  }

  /**
   * Phase 6 control center: attach the activity feed. Safe to call before or
   * after the runner exists — the tracker is re-applied on every rebuild.
   */
  public setActivityTracker(tracker?: ActivityTracker): void {
    this.activityTracker = tracker;
    this.agentRunner?.setActivityTracker?.(tracker);
  }

  /** Phase 6 control center: attach the approval notification sink. */
  public setNotificationCenter(center?: NotificationCenter): void {
    this.notificationCenter = center;
  }

  /** Phase 7 model routing: attach the adaptive model resolver. */
  public setModelResolver(
    resolver?: (input: { sessionId: string; prompt: string; fallbackModel: string }) =>
      | string
      | undefined
  ): void {
    this.modelResolver = resolver;
    this.agentRunner?.setModelResolver?.(resolver);
  }

  /** Phase 7 model routing: attach the local benchmark sink. */
  public setBenchmarkRecorder(
    recorder?: (input: {
      modelId: string;
      prompt: string;
      success: boolean;
      latencyMs: number;
    }) => void
  ): void {
    this.benchmarkRecorder = recorder;
    this.agentRunner?.setBenchmarkRecorder?.(recorder);
  }

  private createCoworkAgentRunner(): CoworkAgentRunner {
    if (!this.memoryManager) {
      this.memoryManager = new MemoryManager(this.db.raw);
    }
    return new CoworkAgentRunner(
      {
        sendToRenderer: this.sendToRenderer,
        saveMessage: (message: Message) => this.saveMessage(message),
        ...(this.activityTracker ? { activityTracker: this.activityTracker } : {}),
        ...(this.modelResolver ? { modelResolver: this.modelResolver } : {}),
        ...(this.benchmarkRecorder ? { benchmarkRecorder: this.benchmarkRecorder } : {}),
        requestSudoPassword: (sessionId: string, toolUseId: string, command: string) =>
          this.requestSudoPassword(sessionId, toolUseId, command),
        requestPermission: (
          sessionId: string,
          toolUseId: string,
          toolName: string,
          input: Record<string, unknown>
        ) => this.requestPermission(sessionId, toolUseId, toolName, input),
      },
      this.pathResolver,
      this.mcpManager,
      this.pluginRuntimeService,
      this.skillsAdapter,
      this.extensionManager,
      this.memoryManager
    );
  }

  public getMemoryManager(): MemoryManager {
    if (!this.memoryManager) {
      this.memoryManager = new MemoryManager(this.db.raw);
    }
    return this.memoryManager;
  }

  /**
   * Notify that API config changed.
   * Model/apiKey/baseUrl changes are picked up per-query via configStore.getAll()
   * and hot-swapped via piSession.setModel(). No need to recreate the runner.
   */
  reloadConfig(): void {
    log('[SessionManager] API config changed — will apply on next query');
  }

  /**
   * Reinitialize MCP servers (call only when MCP config actually changes)
   */
  async reloadMCP(): Promise<void> {
    log('[SessionManager] Reloading MCP servers');
    await this.initializeMCP();
  }

  /**
   * Invalidate cached MCP servers config so the next query rebuilds tools.
   * Call after MCP server add/update/delete.
   */
  invalidateMcpServersCache(): void {
    if (this.agentRunner && 'invalidateMcpServersCache' in this.agentRunner) {
      (this.agentRunner as CoworkAgentRunner).invalidateMcpServersCache();
    }
  }

  /**
   * Invalidate skills setup so the next query re-links skills.
   * Call after skill install/uninstall/toggle.
   */
  invalidateSkillsSetup(): void {
    if (this.agentRunner && 'invalidateSkillsSetup' in this.agentRunner) {
      (this.agentRunner as CoworkAgentRunner).invalidateSkillsSetup();
    }
  }

  /**
   * Install the skills runtime adapter. SessionManager is constructed before
   * SkillsManager, so this is a setter rather than a constructor argument; the
   * adapter is remembered so a rebuilt runner keeps it.
   */
  setSkillsAdapter(adapter: SkillsAdapter): void {
    this.skillsAdapter = adapter;
    if (this.agentRunner && 'setSkillsAdapter' in this.agentRunner) {
      (this.agentRunner as CoworkAgentRunner).setSkillsAdapter(adapter);
    }
  }

  /**
   * Reinitialize sandbox adapter (call only when sandbox config changes)
   */
  async reloadSandbox(): Promise<void> {
    await this.reinitializeSandboxAsync();
  }

  /**
   * Reinitialize sandbox adapter asynchronously
   */
  private async reinitializeSandboxAsync(): Promise<void> {
    try {
      log('[SessionManager] Reinitializing sandbox adapter...');
      await reinitializeSandbox();
      this.sandboxAdapter = getSandboxAdapter();
      log('[SessionManager] Sandbox adapter reinitialized, mode:', this.sandboxAdapter.mode);
    } catch (error) {
      logError('[SessionManager] Failed to reinitialize sandbox:', error);
    }
  }

  /**
   * Initialize MCP servers from configuration
   */
  private async initializeMCP(): Promise<void> {
    try {
      const servers = mcpConfigStore.getEnabledServers();
      await this.mcpManager.initializeServers(servers);
      log(`[SessionManager] Initialized ${servers.length} MCP servers`);
    } catch (error) {
      logError('[SessionManager] Failed to initialize MCP servers:', error);
      this.sendToRenderer({
        type: 'error',
        payload: {
          message: `Failed to initialize MCP servers: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  /**
   * Get MCP manager instance
   */
  getMCPManager(): MCPManager {
    return this.mcpManager;
  }

  /**
   * Get sandbox adapter instance
   */
  getSandboxAdapter(): SandboxAdapter {
    return this.sandboxAdapter;
  }

  // Create and start a new session

  public queueMessage(sessionId: string, text: string): void {
    const session = this.loadSession(sessionId);
    if (!session) return;
    this.enqueuePrompt(session, text);
  }

  public steerAgent(sessionId: string, text: string): void {
    const session = this.loadSession(sessionId);
    if (!session) return;
    this.stopSession(sessionId);
    this.enqueuePrompt(session, text);
  }

  public getPendingMessage(sessionId: string): string | null {
    const queue = this.promptQueues.get(sessionId);
    if (queue && queue.length > 0) {
      return queue.map(i => i.prompt).join('\n');
    }
    return null;
  }

  public clearPendingMessage(sessionId: string): void {
    this.promptQueues.delete(sessionId);
  }

  async startSession(
    title: string,
    prompt: string,
    cwd?: string,
    allowedTools?: string[],
    content?: ContentBlock[],
    memoryEnabled?: boolean,
    projectId?: string
  ): Promise<Session> {
    log('[SessionManager] Starting new session:', title);

    // Boot may have deferred an external vault resolution off the critical
    // path. A session started in that window must see the resolved key, so it
    // waits — but only in that window: when idle this is a resolved promise.
    if (configStore.hasPendingExternalSecrets()) {
      await configStore.whenExternalSecretsSettled();
      await configStore.applyToEnv();
    }

    const session = this.createSession(title, cwd, allowedTools, memoryEnabled, projectId);

    // Save to database
    this.saveSession(session);

    // Start processing the prompt with content blocks
    this.enqueuePrompt(session, prompt, content);

    return session;
  }

  // Create a new session object
  private buildMountedPaths(cwd?: string): Session['mountedPaths'] {
    if (!cwd) {
      return [];
    }
    return [{ virtual: WORKSPACE_MOUNT_VIRTUAL_PATH, real: cwd }];
  }

  private createSession(
    title: string,
    cwd?: string,
    allowedTools?: string[],
    memoryEnabled?: boolean,
    projectId?: string
  ): Session {
    const now = Date.now();
    // Prefer frontend-provided cwd; fallback to env vars if provided
    const envCwd = process.env.COWORK_WORKDIR || process.env.WORKDIR || process.env.DEFAULT_CWD;
    const effectiveCwd = cwd || envCwd;
    const resolvedMemoryEnabled =
      typeof memoryEnabled === 'boolean'
        ? memoryEnabled
        : configStore.get('memoryEnabled') !== false;
    return {
      id: uuidv4(),
      title,
      status: 'idle',
      cwd: effectiveCwd,
      mountedPaths: this.buildMountedPaths(effectiveCwd),
      allowedTools: allowedTools || [
        'askuserquestion',
        'todowrite',
        'todoread',
        'webfetch',
        'websearch',
        'read',
        'write',
        'edit',
        'list_directory',
        'glob',
        'grep',
      ],
      memoryEnabled: resolvedMemoryEnabled,
      model: configStore.get('model') || undefined,
      projectId: projectId || undefined,
      createdAt: now,
      updatedAt: now,
    };
  }

  // Save session to database
  private saveSession(session: Session) {
    this.db.sessions.create({
      id: session.id,
      title: session.title,
      claude_session_id: session.claudeSessionId || null,
      openai_thread_id: session.openaiThreadId || null,
      status: session.status,
      cwd: session.cwd || null,
      mounted_paths: JSON.stringify(session.mountedPaths),
      allowed_tools: JSON.stringify(session.allowedTools),
      memory_enabled: session.memoryEnabled ? 1 : 0,
      model: session.model || null,
      project_id: session.projectId || null,
      config_set_id: session.configSetId || null,
      config_model_id: session.configModelId || null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
    });
  }

  // Load session from database
  public loadSession(sessionId: string): Session | null {
    const row = this.db.sessions.get(sessionId);
    if (!row) return null;

    let mountedPaths;
    try {
      mountedPaths = JSON.parse(row.mounted_paths);
    } catch (e) {
      logError('[SessionManager] Failed to parse mounted_paths:', e);
      mountedPaths = [];
    }

    let allowedTools;
    try {
      allowedTools = JSON.parse(row.allowed_tools);
    } catch (e) {
      logError('[SessionManager] Failed to parse allowed_tools:', e);
      allowedTools = [];
    }

    return {
      id: row.id,
      title: row.title,
      claudeSessionId: row.claude_session_id || undefined,
      openaiThreadId: row.openai_thread_id || undefined,
      status: row.status as Session['status'],
      cwd: row.cwd || undefined,
      mountedPaths,
      allowedTools,
      memoryEnabled: row.memory_enabled === 1,
      model: row.model || undefined,
      isPinned: row.is_pinned === 1,
      projectId: row.project_id || undefined,
      configSetId: row.config_set_id || null,
      configModelId: row.config_model_id || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Latest assistant text in a session, for machine consumers (A2A task
   * artifacts) that cannot subscribe to the renderer's event stream.
   * Returns null while the assistant has said nothing reportable yet.
   */
  public getLastAssistantText(sessionId: string): string | null {
    try {
      const rows = this.db.messages.getBySessionId(sessionId);
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (!row || row.role !== 'assistant') continue;
        const text = extractMessageText(row.content);
        if (text) return text;
      }
      return null;
    } catch (error) {
      logError('[SessionManager] Failed to read assistant text:', error);
      return null;
    }
  }

  // List all sessions
  listSessions(): Session[] {
    const rows = this.db.sessions.getAll();

    return rows.map((row) => {
      let mountedPaths;
      try {
        mountedPaths = JSON.parse(row.mounted_paths);
      } catch (e) {
        logError('[SessionManager] Failed to parse mounted_paths:', e);
        mountedPaths = [];
      }

      let allowedTools;
      try {
        allowedTools = JSON.parse(row.allowed_tools);
      } catch (e) {
        logError('[SessionManager] Failed to parse allowed_tools:', e);
        allowedTools = [];
      }

      return {
        id: row.id,
        title: row.title,
        claudeSessionId: row.claude_session_id || undefined,
        openaiThreadId: row.openai_thread_id || undefined,
        status: row.status as Session['status'],
        cwd: row.cwd || undefined,
        mountedPaths,
        allowedTools,
        memoryEnabled: row.memory_enabled === 1,
        model: row.model || undefined,
        isPinned: row.is_pinned === 1,
        projectId: row.project_id || undefined,
        configSetId: row.config_set_id || null,
        configModelId: row.config_model_id || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  // Continue an existing session
  async continueSession(
    sessionId: string,
    prompt: string,
    content?: ContentBlock[]
  ): Promise<void> {
    log('[SessionManager] Continuing session:', sessionId);

    const session = this.loadSession(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.enqueuePrompt(session, prompt, content);
  }

  async generateSessionTitleFromPrompt(prompt: string): Promise<string> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) {
      return 'New Session';
    }

    const generated = await this.withTimeout(
      this.generateTitleWithConfig(buildTitlePrompt(normalizedPrompt)),
      TITLE_GENERATION_TIMEOUT_MS,
      'session-title-preview'
    );
    const normalizedGenerated = normalizeGeneratedTitle(generated);
    return normalizedGenerated ?? getDefaultTitleFromPrompt(normalizedPrompt);
  }

  async generateScheduledTaskTitle(prompt: string): Promise<string> {
    const sessionTitle = await this.generateSessionTitleFromPrompt(prompt);
    return buildScheduledTaskTitle(sessionTitle);
  }

  /**
   * Ensure sandbox is initialized for the session's workspace
   */
  private async ensureSandboxInitialized(session: Session): Promise<void> {
    if (!session.cwd) {
      log('[SessionManager] No workspace directory, skipping sandbox init');
      return;
    }

    // Check if already initialized with this exact workspace
    if (this.sandboxAdapter.initialized && this.sandboxAdapter.workspacePath === session.cwd) {
      return;
    }

    // Check if initialization is already in progress
    const existingPromise = this.sandboxInitPromises.get(session.cwd);
    if (existingPromise) {
      await existingPromise;
      return;
    }

    // Initialize sandbox with workspace
    const initPromise = initializeSandbox({
      workspacePath: session.cwd,
      mainWindow: null, // Will show dialogs globally
    }).then(() => {
      /* void */
    });

    this.sandboxInitPromises.set(session.cwd, initPromise);

    try {
      await initPromise;
      log('[SessionManager] Sandbox initialized for workspace:', session.cwd);
      log('[SessionManager] Sandbox mode:', this.sandboxAdapter.mode);
    } catch (error) {
      logError('[SessionManager] Failed to initialize sandbox:', error);
      this.sendToRenderer({
        type: 'error',
        payload: {
          message: `Failed to initialize sandbox: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      // Continue anyway - sandbox adapter will fallback to native
    } finally {
      this.sandboxInitPromises.delete(session.cwd);
    }
  }

  // Helper: Copy files to session's .tmp directory and sync to sandbox if needed
  private async processFileAttachments(
    session: Session,
    content: ContentBlock[]
  ): Promise<ContentBlock[]> {
    const processedContent: ContentBlock[] = [];

    for (const block of content) {
      if (block.type === 'image') {
        // Pasted images arrive inline (base64). Persist them so the text-only
        // chat model can still "see" them via the analyze_image tool.
        processedContent.push(await this.persistPastedImage(session, block as ImageContent));
        continue;
      }
      if (block.type === 'file_attachment') {
        const fileBlock = block as FileAttachmentContent;

        try {
          // Create .tmp directory if it doesn't exist
          const tmpDir = path.join(session.cwd || process.cwd(), '.tmp');
          if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
            log('[SessionManager] Created .tmp directory:', tmpDir);
          }

          // Get source file path from the file attachment
          const sourcePath = (fileBlock.relativePath || '').trim(); // This is the full path from Electron
          // IMPORTANT: Use path.basename() to extract only the filename, not the full path
          const fallbackFilename = fileBlock.filename || sourcePath || `attachment-${Date.now()}`;
          const destFilename = path.basename(fallbackFilename);
          if (!destFilename) continue;
          const destPath = path.join(tmpDir, destFilename);
          let actualSize = 0;

          // Copy file to .tmp directory
          if (sourcePath && fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);

            // Get actual file size
            const stats = fs.statSync(destPath);
            actualSize = stats.size;

            log(
              '[SessionManager] Copied file:',
              sourcePath,
              '->',
              destPath,
              `(${actualSize} bytes)`
            );
          } else if (fileBlock.inlineDataBase64) {
            const buffer = Buffer.from(fileBlock.inlineDataBase64, 'base64');
            fs.writeFileSync(destPath, buffer);
            actualSize = buffer.length;
            log('[SessionManager] Wrote file from inline data:', destPath, `(${actualSize} bytes)`);
          } else {
            logError(
              '[SessionManager] Source file not found and inline data missing:',
              sourcePath || '(empty path)'
            );
            // Skip this file attachment
            continue;
          }

          // If sandbox is already initialized, sync the file to sandbox as well
          // This handles the case where user attaches files in subsequent messages
          const sandboxPath = SandboxSync.getSandboxPath(session.id);
          if (sandboxPath) {
            const sandboxRelativePath = `.tmp/${destFilename}`;
            log('[SessionManager] Syncing attached file to sandbox:', sandboxRelativePath);
            const syncResult = await SandboxSync.syncFileToSandbox(
              session.id,
              destPath,
              sandboxRelativePath
            );
            if (syncResult.success) {
              log('[SessionManager] File synced to sandbox:', syncResult.sandboxPath);
            } else {
              logError('[SessionManager] Failed to sync file to sandbox:', syncResult.error);
              // Continue anyway - file is in Windows .tmp, agent might still work via /mnt/
            }
          } else {
            // Check for Lima sandbox
            const { LimaSync } = await import('../sandbox/lima-sync');
            const limaSandboxPath = LimaSync.getSandboxPath(session.id);
            if (limaSandboxPath) {
              const sandboxRelativePath = `.tmp/${destFilename}`;
              log('[SessionManager] Syncing attached file to Lima sandbox:', sandboxRelativePath);
              const syncResult = await LimaSync.syncFileToSandbox(
                session.id,
                destPath,
                sandboxRelativePath
              );
              if (syncResult.success) {
                log('[SessionManager] File synced to Lima sandbox:', syncResult.sandboxPath);
              } else {
                logError('[SessionManager] Failed to sync file to Lima sandbox:', syncResult.error);
                // Continue anyway - file is in macOS .tmp, agent might still work via direct access
              }
            }
          }

          // Update the content block with the new relative path and actual size
          const relativePathFromCwd = path.join('.tmp', destFilename);
          const restFileBlock = { ...fileBlock };
          delete restFileBlock.inlineDataBase64;
          processedContent.push({
            ...restFileBlock,
            relativePath: relativePathFromCwd,
            size: actualSize,
          });
        } catch (error) {
          logError('[SessionManager] Error copying file:', error);
          this.sendToRenderer({
            type: 'error',
            payload: {
              message: `Failed to process file attachment: ${error instanceof Error ? error.message : String(error)}`,
            },
          });
          // Skip this file attachment
        }
      } else {
        // Keep other content blocks as-is
        processedContent.push(block);
      }
    }

    return processedContent;
  }

  /**
   * Persist an inline (pasted) image under the session's .tmp folder and return
   * the block enriched with its workspace-relative path. The image stays in the
   * block so the UI keeps rendering it; the path is what the analyze_image
   * (vision) tool reads, since the chat model is text-only. Best-effort: on any
   * failure the original block is returned unchanged rather than dropping it.
   */
  private async persistPastedImage(
    session: Session,
    imageBlock: ImageContent
  ): Promise<ImageContent> {
    try {
      const data = imageBlock.source?.data;
      if (!data) return imageBlock;
      const buffer = Buffer.from(data, 'base64');
      if (buffer.length === 0) return imageBlock;

      const extension = PASTED_IMAGE_EXTENSION[imageBlock.source.media_type] ?? 'png';
      const tmpDir = path.join(session.cwd || process.cwd(), '.tmp');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      const destFilename = `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
      const destPath = path.join(tmpDir, destFilename);
      fs.writeFileSync(destPath, buffer);

      const relativePath = `.tmp/${destFilename}`;
      await this.syncAttachmentToSandbox(session.id, destPath, relativePath);
      log('[SessionManager] Persisted pasted image:', relativePath, `(${buffer.length} bytes)`);
      return { ...imageBlock, relativePath };
    } catch (error) {
      logError('[SessionManager] Failed to persist pasted image:', error);
      return imageBlock;
    }
  }

  /**
   * Best-effort copy of an attachment into the active sandbox (WSL or Lima).
   * Non-fatal: the host copy remains usable when no sandbox is running.
   */
  private async syncAttachmentToSandbox(
    sessionId: string,
    hostPath: string,
    relativePath: string
  ): Promise<void> {
    try {
      if (SandboxSync.getSandboxPath(sessionId)) {
        const result = await SandboxSync.syncFileToSandbox(sessionId, hostPath, relativePath);
        if (!result.success) {
          logError('[SessionManager] Failed to sync attachment to WSL sandbox:', result.error);
        }
        return;
      }
      const { LimaSync } = await import('../sandbox/lima-sync');
      if (LimaSync.getSandboxPath(sessionId)) {
        const result = await LimaSync.syncFileToSandbox(sessionId, hostPath, relativePath);
        if (!result.success) {
          logError('[SessionManager] Failed to sync attachment to Lima sandbox:', result.error);
        }
      }
    } catch (error) {
      logError('[SessionManager] Attachment sandbox sync failed:', error);
    }
  }

  // Process a prompt using CoworkAgentRunner
  private async processPrompt(
    session: Session,
    prompt: string,
    content?: ContentBlock[]
  ): Promise<void> {
    const traceId = generateTraceId();
    return runWithLogContext({ sessionId: session.id, traceId }, async () => {
      logCtx('[SessionManager] Processing prompt for session:', session.id, 'traceId:', traceId);
      logCtx(
        '[SessionManager] Received content:',
        content
          ? JSON.stringify(
              content.map((c) => ({
                type: c.type,
                hasData: !!(c as { source?: { data?: unknown } }).source?.data,
              }))
            )
          : 'none'
      );

      // Ensure sandbox is initialized for this workspace
      await this.ensureSandboxInitialized(session);

      try {
        // Use provided content blocks or fall back to simple text
        let messageContent: ContentBlock[] =
          content && content.length > 0 ? content : [{ type: 'text', text: prompt } as TextContent];

        // Process file attachments - copy to .tmp directory
        messageContent = await this.processFileAttachments(session, messageContent);

        logCtx(
          '[SessionManager] Final message content types:',
          messageContent.map((c) => c.type)
        );

        // Build enhanced prompt with attachment information (files + images).
        // Images are announced by workspace path so the agent can call
        // analyze_image on them — the chat model itself cannot receive bytes.
        let enhancedPrompt = prompt;
        const fileAttachments = messageContent.filter(
          (c) => c.type === 'file_attachment'
        ) as FileAttachmentContent[];
        const imagePaths = messageContent
          .filter((c): c is ImageContent => c.type === 'image' && !!c.relativePath)
          .map((c) => c.relativePath as string);
        const attachmentHints = buildAttachmentPromptHints({
          files: fileAttachments.map((f) => ({
            filename: f.filename,
            relativePath: f.relativePath,
            size: f.size,
          })),
          images: imagePaths,
        });
        if (attachmentHints) {
          enhancedPrompt = `${prompt}\n\n${attachmentHints}`;
          logCtx('[SessionManager] Enhanced prompt with attachment info:', enhancedPrompt);
        }

        // Save user message to database for persistence
        const existingMessages = this.getMessages(session.id);
        const userMessage: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'user',
          content: messageContent, // Save full content including images and files
          timestamp: Date.now(),
        };
        this.saveMessage(userMessage);
        logCtx(
          '[SessionManager] User message saved:',
          userMessage.id,
          'with',
          messageContent.length,
          'content blocks'
        );
        const messagesForContext = [...existingMessages, userMessage];

        // Update session model to match current config (may have changed since session creation)
        const currentModel = configStore.get('model');
        if (currentModel && currentModel !== session.model) {
          session.model = currentModel;
          this.db.sessions.update(session.id, { model: currentModel });
          this.sendToRenderer({
            type: 'session.update',
            payload: { sessionId: session.id, updates: { model: currentModel } },
          });
        }

        // Run the agent. A rate limit / gateway failure that produced no tool
        // execution is replayed once on the next usable ConfigSet: the first
        // attempt already told the user what happened, so switching provider
        // is strictly better than leaving the turn dead.
        await this.runWithProviderFallback(session, enhancedPrompt, messagesForContext);

        if (this.extensionManager) {
          const stableMessages = this.getMessages(session.id);
          this.extensionManager
            .afterSessionRun({
              session,
              prompt: enhancedPrompt,
              messages: stableMessages,
            })
            .catch((error) =>
              logCtxError('[SessionManager] Runtime extension post-run hook failed:', error)
            );
        }

        // 标题生成不再与首轮对话并发，避免与主请求竞争同一上游配额/通道导致体感变慢。
        this.runSessionTitleGeneration(session, prompt, existingMessages).catch((err) =>
          logCtxError('[SessionManager] Title generation failed:', err)
        );
      } catch (error) {
        logCtxError('[SessionManager] Error processing prompt:', error);
        const errorText = error instanceof Error ? error.message : 'Unknown error';
        const alreadyReportedToUser = Boolean(
          error &&
          typeof error === 'object' &&
          (error as { alreadyReportedToUser?: boolean }).alreadyReportedToUser
        );
        if (!alreadyReportedToUser) {
          const assistantMessage: Message = {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: `**Error**: ${errorText}` }],
            timestamp: Date.now(),
          };
          this.saveMessage(assistantMessage);
          this.sendToRenderer({
            type: 'stream.message',
            payload: { sessionId: session.id, message: assistantMessage },
          });
        }
        this.sendToRenderer({
          type: 'error',
          payload: { message: errorText },
        });
      }
    }); // end runWithLogContext
  }

  /**
   * Run one turn, replaying it on the next usable ConfigSet when the first
   * attempt failed in a way that cannot have produced side effects.
   *
   * The decision itself lives in `provider-fallback` (pure, unit-tested); this
   * method only supplies the ConfigSet inventory and executes the retry. At most
   * one retry happens: a second failure is a real problem with the setup, not a
   * transient rate limit, and looping would multiply the user's bill.
   */
  private async runWithProviderFallback(
    session: Session,
    prompt: string,
    existingMessages: Message[]
  ): Promise<void> {
    const first = await this.agentRunner.run(session, prompt, existingMessages);
    if (!first?.retryable) {
      // A context-window overflow is not retryable by the generic policy (the
      // same prompt would fail identically elsewhere) — unless another
      // configured ConfigSet has a strictly larger effective window. That one
      // replay can genuinely succeed, so it gets the single retry instead of
      // the raw 400.
      const recovered = await this.retryOverflowOnLargerWindow(
        session,
        prompt,
        existingMessages,
        first
      );
      if (!recovered) {
        // Either the turn succeeded, or it failed in a way another provider
        // would hit too (auth, bad request) or that already produced side
        // effects. In every one of those cases the held-back error is the
        // final answer.
        // Optional call: legacy runners/mocks predate the retry contract.
        first?.flushError?.();
      }
      return;
    }

    const config = configStore.getAll();
    const candidates = buildFallbackCandidates({
      configSets: config.configSets,
      failedConfigSetId: config.activeConfigSetId,
      projectSet: (setId) => configStore.getConfigSetProjectedConfig(setId),
      hasUsableCredentials: (candidate) => configStore.hasUsableCredentialsForActiveSet(candidate),
    });

    const candidate = candidates[0];
    if (!candidate) {
      // No other provider is configured: the user needs to see the 429 rather
      // than an unexplained silence.
      first.flushError?.();
      return;
    }

    logCtx(
      '[SessionManager] Provider failure on the active set — retrying the turn on',
      candidate.label
    );
    // The retry's answer replaces the held-back error — do NOT flush it here.
    // Flushing now would publish the 429 banner right before the successful
    // answer. If the retry fails too, its own error is what the user reads;
    // otherwise the held error is simply discarded.
    // Persist the switch so the retry — and every later turn of the session —
    // uses the working provider instead of the exhausted one.
    configStore.switchSet({ id: candidate.configSetId });
    this.sendToRenderer({
      type: 'session.update',
      payload: {
        sessionId: session.id,
        updates: { model: candidate.config.model },
      },
    });
    session.model = candidate.config.model;
    this.db.sessions.update(session.id, { model: candidate.config.model });

    const second = await this.agentRunner.run(session, prompt, existingMessages);
    // No second fallback: a further failure is a real problem with the setup,
    // and looping would multiply the user's bill. Surface whatever it produced.
    second?.flushError?.();
  }

  /**
   * Replay an overflowed turn on the first ConfigSet with a strictly larger
   * effective window. Same safety contract as the provider fallback — zero
   * tool side effects, exactly one retry — plus a window comparison, because a
   * same-window replay would overflow identically and only double-bill.
   * Returns true when a recovery retry ran (its own error is then final).
   */
  private async retryOverflowOnLargerWindow(
    session: Session,
    prompt: string,
    existingMessages: Message[],
    first: AgentRunAttempt | void
  ): Promise<boolean> {
    if (
      !first ||
      first.ok ||
      first.errorCode !== 'upstream_400' ||
      (first.toolExecutions ?? 0) !== 0 ||
      !first.errorText ||
      !isContextOverflowError(first.errorText)
    ) {
      return false;
    }

    const config = configStore.getAll();
    const candidates = buildFallbackCandidates({
      configSets: config.configSets,
      failedConfigSetId: config.activeConfigSetId,
      projectSet: (setId) => configStore.getConfigSetProjectedConfig(setId),
      hasUsableCredentials: (candidate) =>
        configStore.hasUsableCredentialsForActiveSet(candidate),
    });
    if (candidates.length === 0) return false;

    const failedConfig = configStore.getConfigSetProjectedConfig(config.activeConfigSetId);
    const failedWindow = resolveEffectiveContextWindow({
      modelId: failedConfig?.model,
      configuredWindow: failedConfig?.contextWindow,
      fallbackWindow: 200_000,
    });
    const pick = selectOverflowFallback({
      failedWindow,
      candidates: candidates.map((candidate) => ({
        configSetId: candidate.configSetId,
        window: resolveEffectiveContextWindow({
          modelId: candidate.config.model,
          configuredWindow: candidate.config.contextWindow,
          fallbackWindow: 200_000,
        }),
      })),
    });
    if (!pick) return false;

    const target = candidates.find((candidate) => candidate.configSetId === pick.configSetId);
    if (!target) return false;

    logCtx(
      '[SessionManager] Context overflow on the active set — retrying the turn on larger-window set',
      target.label
    );
    // Persist the switch so the retry — and every later turn of the session —
    // uses the window that can actually hold the conversation.
    configStore.switchSet({ id: target.configSetId });
    this.sendToRenderer({
      type: 'session.update',
      payload: {
        sessionId: session.id,
        updates: { model: target.config.model },
      },
    });
    session.model = target.config.model;
    this.db.sessions.update(session.id, { model: target.config.model });

    const second = await this.agentRunner.run(session, prompt, existingMessages);
    // No second fallback: same single-retry budget as the provider path.
    second?.flushError?.();
    return true;
  }

  private async runSessionTitleGeneration(
    session: Session,
    prompt: string,
    existingMessages: Message[]
  ): Promise<void> {
    const token = Symbol(`title:${session.id}`);
    this.titleGenerationTokens.set(session.id, token);
    const shouldAbort = () => {
      if (this.titleGenerationTokens.get(session.id) !== token) {
        return true;
      }
      return !this.db.sessions.get(session.id);
    };
    const userMessageCount =
      existingMessages.filter((message) => message.role === 'user').length + 1;
    try {
      await maybeGenerateSessionTitle({
        sessionId: session.id,
        prompt,
        userMessageCount,
        currentTitle: session.title,
        hasAttempted: this.sessionTitleAttempts.has(session.id),
        generateTitle: async (titlePrompt) => {
          if (shouldAbort()) {
            return null;
          }
          const title = await this.withTimeout(
            this.generateTitleWithConfig(titlePrompt),
            TITLE_GENERATION_TIMEOUT_MS,
            session.id
          );
          return normalizeGeneratedTitle(title);
        },
        getLatestTitle: () => this.db.sessions.get(session.id)?.title ?? null,
        markAttempt: () => {
          this.sessionTitleAttempts.add(session.id);
        },
        updateTitle: async (title) => {
          if (shouldAbort()) {
            log('[SessionTitle] Skip update: session no longer active', session.id);
            return false;
          }
          const updated = this.updateSessionTitle(session.id, title);
          if (updated) {
            session.title = title;
          }
          return updated;
        },
        shouldAbort,
        log,
      });
    } catch (error) {
      logError('[SessionTitle] Unexpected error', session.id, error);
    } finally {
      if (this.titleGenerationTokens.get(session.id) === token) {
        this.titleGenerationTokens.delete(session.id);
      }
    }
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    sessionId: string
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        logError('[SessionTitle] Generation timed out', { sessionId, timeoutMs });
        resolve(null);
      }, timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          logError('[SessionTitle] Generation rejected', { sessionId, error });
          resolve(null);
        });
    });
  }

  private async generateTitleWithConfig(titlePrompt: string): Promise<string | null> {
    // Always use pi-ai SDK for title generation
    return normalizeGeneratedTitle(await generateTitleWithSdk(titlePrompt, configStore.getAll()));
  }

  private enqueuePrompt(session: Session, prompt: string, content?: ContentBlock[]): void {
    const queue = this.promptQueues.get(session.id) || [];
    queue.push({ prompt, content });
    this.promptQueues.set(session.id, queue);

    if (!this.activeSessions.has(session.id)) {
      this.processQueue(session).catch((err) => {
        logError('[SessionManager] Queue processing error:', err);
        this.sendToRenderer({
          type: 'error',
          payload: {
            message: `Failed to process message: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      });
    } else {
      log('[SessionManager] Session running, queued prompt:', session.id);
    }
  }

  private async processQueue(session: Session): Promise<void> {
    if (this.activeSessions.has(session.id)) return;

    const controller = new AbortController();
    this.activeSessions.set(session.id, controller);
    this.updateSessionStatus(session.id, 'running');

    try {
      // Outer loop: after the inner loop drains, re-check for items that
      // arrived while processPrompt was awaited. This keeps the session in
      // activeSessions the entire time, preventing enqueuePrompt from
      // spawning a duplicate processQueue during the gap that previously
      // existed between activeSessions.delete and the restart call.
      let shouldContinue = true;
      while (shouldContinue) {
        while (!controller.signal.aborted) {
          const queue = this.promptQueues.get(session.id);
          if (!queue || queue.length === 0) break;

          const item = queue.shift();
          if (!item) continue;

          const latestSession = this.loadSession(session.id);
          if (!latestSession) {
            log('[SessionManager] Session removed while processing queue:', session.id);
            return; // finally handles cleanup
          }

          await this.processPrompt(latestSession, item.prompt, item.content);

          if (controller.signal.aborted) return; // finally handles cleanup
        }

        // If aborted, exit immediately — finally handles cleanup.
        if (controller.signal.aborted) {
          shouldContinue = false;
          continue;
        }

        // Re-check: items may have been enqueued during the last processPrompt await.
        const pendingQueue = this.promptQueues.get(session.id);
        if (!pendingQueue || pendingQueue.length === 0) {
          shouldContinue = false;
          continue;
        }

        // Reload session before continuing with newly arrived prompts.
        const latestSession = this.loadSession(session.id);
        if (!latestSession) {
          this.promptQueues.delete(session.id);
          shouldContinue = false;
          continue;
        }
        session = latestSession;
        log('[SessionManager] Continuing queue with newly arrived prompts:', session.id);
      }
    } finally {
      // Only clean up here — no restart logic needed since the outer loop
      // already handles re-checking. activeSessions is only deleted once
      // there are truly no pending items remaining.
      this.activeSessions.delete(session.id);
      const queue = this.promptQueues.get(session.id);
      if (queue && queue.length === 0) {
        this.promptQueues.delete(session.id);
      }
      this.updateSessionStatus(session.id, 'idle');
    }
  }

  // Stop a running session
  stopSession(sessionId: string): void {
    log('[SessionManager] Stopping session:', sessionId);
    this.titleGenerationTokens.delete(sessionId);
    this.agentRunner.cancel(sessionId);
    // Cancel any pending sudo password requests for this session
    for (const [toolUseId, entry] of this.pendingSudoPasswords) {
      if (entry.sessionId === sessionId) {
        entry.resolve(null);
        this.pendingSudoPasswords.delete(toolUseId);
        this.sendToRenderer({ type: 'sudo.password.dismiss', payload: { toolUseId } });
      }
    }
    // Also abort any pending controller we tracked
    const controller = this.activeSessions.get(sessionId);
    if (controller) {
      controller.abort();
    }
    this.promptQueues.delete(sessionId);
    this.messageCache.delete(sessionId);
    this.updateSessionStatus(sessionId, 'idle');
  }

  // Delete a session
  async deleteSession(sessionId: string): Promise<void> {
    const existingSession = this.loadSession(sessionId);

    // Stop if running
    this.stopSession(sessionId);

    // Sync and cleanup sandbox if it exists for this session
    if (SandboxSync.hasSession(sessionId)) {
      log('[SessionManager] Cleaning up sandbox for session:', sessionId);
      try {
        await SandboxSync.syncAndCleanup(sessionId);
        log('[SessionManager] Sandbox cleanup complete for session:', sessionId);
      } catch (error) {
        logError('[SessionManager] Failed to cleanup sandbox:', error);
        // Continue with session deletion even if sandbox cleanup fails
      }
    }

    // Delete from database (messages will be deleted automatically via CASCADE)
    this.db.sessions.delete(sessionId);
    this.messageCache.delete(sessionId);
    this.sessionTitleAttempts.delete(sessionId);
    this.titleGenerationTokens.delete(sessionId);
    if (this.extensionManager) {
      await this.extensionManager.onSessionDeleted({
        sessionId,
        session: existingSession,
      });
    }
    forgetSessionPermissions(sessionId);

    log('[SessionManager] Session deleted:', sessionId);
  }

  async batchDeleteSessions(sessionIds: string[]): Promise<void> {
    const sessionsById = new Map(
      sessionIds.map((sessionId) => [sessionId, this.loadSession(sessionId)] as const)
    );
    // Stop sessions and clean up sandboxes first (async, cannot run inside SQLite transaction)
    for (const sessionId of sessionIds) {
      this.stopSession(sessionId);
      if (SandboxSync.hasSession(sessionId)) {
        try {
          await SandboxSync.syncAndCleanup(sessionId);
        } catch (error) {
          logError('[SessionManager] Failed to cleanup sandbox during batch delete:', error);
        }
      }
    }

    // Perform all SQLite deletions atomically
    this.db.raw.transaction(() => {
      for (const sessionId of sessionIds) {
        this.db.sessions.delete(sessionId);
        this.messageCache.delete(sessionId);
        this.sessionTitleAttempts.delete(sessionId);
        this.titleGenerationTokens.delete(sessionId);
        forgetSessionPermissions(sessionId);
      }
    })();

    if (this.extensionManager) {
      for (const sessionId of sessionIds) {
        await this.extensionManager.onSessionDeleted({
          sessionId,
          session: sessionsById.get(sessionId) || null,
        });
      }
    }

    log('[SessionManager] Batch deleted sessions:', sessionIds.length);
  }

  // Update session status
  private updateSessionStatus(sessionId: string, status: Session['status']): void {
    this.db.sessions.update(sessionId, { status, updated_at: Date.now() });

    this.sendToRenderer({
      type: 'session.status',
      payload: { sessionId, status },
    });
  }

  updateSessionTitle(sessionId: string, title: string): boolean {
    const existing = this.db.sessions.get(sessionId);
    if (!existing) {
      log('[SessionTitle] Skip title update for deleted session:', sessionId);
      return false;
    }
    const sanitizedTitle = title.trim() || 'Untitled Session';
    this.db.sessions.update(sessionId, { title: sanitizedTitle, updated_at: Date.now() });
    this.sendToRenderer({
      type: 'session.update',
      payload: { sessionId, updates: { title: sanitizedTitle } },
    });
    return true;
  }

  renameSession(sessionId: string, title: string): boolean {
    log('[SessionManager] Renaming session:', sessionId, 'to:', title);
    return this.updateSessionTitle(sessionId, title);
  }

  togglePinSession(sessionId: string, isPinned: boolean): boolean {
    const existing = this.db.sessions.get(sessionId);
    if (!existing) {
      logWarn('[SessionManager] Cannot pin/unpin non-existent session:', sessionId);
      return false;
    }
    this.db.sessions.update(sessionId, {
      is_pinned: isPinned ? 1 : 0,
      updated_at: Date.now(),
    });
    this.sendToRenderer({
      type: 'session.update',
      payload: { sessionId, updates: { isPinned } },
    });
    log(`[SessionManager] Session ${sessionId} pinned status set to: ${isPinned}`);
    return true;
  }

  /**
   * Pin (or clear) the SESSION-level settings override — the highest level of
   * the global -> project -> session ladder. Passing null for both clears the
   * override so the session falls back to its project, then to the global
   * active ConfigSet.
   *
   * The cached SDK session is dropped so the next query actually re-resolves
   * the provider/model instead of reusing the previous one.
   */
  setConfigOverride(
    sessionId: string,
    configSetId: string | null,
    modelId: string | null
  ): boolean {
    const existing = this.db.sessions.get(sessionId);
    if (!existing) {
      logWarn('[SessionManager] Cannot set config override on unknown session:', sessionId);
      return false;
    }
    const nextSetId = configSetId?.trim() || null;
    const nextModelId = modelId?.trim() || null;
    this.db.sessions.update(sessionId, {
      config_set_id: nextSetId,
      config_model_id: nextModelId,
      updated_at: Date.now(),
    });
    // A different provider/model must not be served by a cached SDK session.
    this.agentRunner?.clearSdkSession?.(sessionId);
    this.sendToRenderer({
      type: 'session.update',
      payload: {
        sessionId,
        updates: { configSetId: nextSetId, configModelId: nextModelId },
      },
    });
    log('[SessionManager] Session config override updated:', sessionId, nextSetId ?? 'inherit');
    return true;
  }

  // Update session's working directory
  // Also clears SDK session cache because Claude SDK sessions are bound to cwd
  updateSessionCwd(sessionId: string, cwd: string): void {
    if (this.activeSessions.has(sessionId)) {
      logWarn(
        '[SessionManager] CWD change requested while session running; stopping active run first',
        { sessionId, cwd }
      );
      this.stopSession(sessionId);
    }
    const mountedPaths = this.buildMountedPaths(cwd);
    // Clear claude_session_id in DB so next query creates a new SDK session
    // (Claude SDK sessions cannot change cwd mid-session)
    this.db.sessions.update(sessionId, {
      cwd,
      mounted_paths: JSON.stringify(mountedPaths),
      claude_session_id: null,
      openai_thread_id: null,
      updated_at: Date.now(),
    });

    // Also clear the in-memory SDK session cache
    if (this.agentRunner?.clearSdkSession) {
      this.agentRunner.clearSdkSession(sessionId);
    }

    this.sendToRenderer({
      type: 'session.update',
      payload: { sessionId, updates: { cwd, mountedPaths } },
    });

    log('[SessionManager] Session cwd updated:', sessionId, '->', cwd, '(SDK session cleared)');
  }

  clearAllCachedAgentSessions(): void {
    this.agentRunner?.clearAllSdkSessions?.();
  }

  /**
   * Manually trigger context compaction for a session.
   * Delegates to the agent runner's compact() method.
   */
  async compactSession(
    sessionId: string,
    customInstructions?: string
  ): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  } | null> {
    if (!this.agentRunner?.compact) {
      logWarn('[SessionManager] Agent runner does not support compact()');
      return null;
    }
    return this.agentRunner.compact(sessionId, customInstructions);
  }

  /**
   * Get current context usage for a session.
   * Delegates to the agent runner's getContextUsage() method.
   */
  getContextUsage(
    sessionId: string
  ): { tokens: number | null; contextWindow: number; percent: number | null } | null {
    if (!this.agentRunner?.getContextUsage) {
      return null;
    }
    return this.agentRunner.getContextUsage(sessionId);
  }

  // Save message to database
  saveMessage(message: Message): void {
    this.db.messages.create({
      id: message.id,
      session_id: message.sessionId,
      role: message.role,
      content: JSON.stringify(message.content),
      timestamp: message.timestamp,
      token_usage: message.tokenUsage ? JSON.stringify(message.tokenUsage) : null,
      execution_time_ms: message.executionTimeMs ?? null,
    });
    const cached = this.messageCache.get(message.sessionId);
    if (cached) {
      cached.push(message);
    } else {
      // Only evict when the cache could actually grow (i.e. the session is
      // not cached yet). Evicting on every saveMessage call is wrong because
      // the Map size didn't increase — we just appended to an existing array —
      // and the oldest entry could be the very session we just updated.
      if (this.messageCache.size > SessionManager.MAX_CACHE_SIZE) {
        const firstKey = this.messageCache.keys().next().value;
        if (firstKey) this.messageCache.delete(firstKey);
      }
      this.messageCache.set(message.sessionId, [message]);
    }

    log('[SessionManager] Message saved:', message.id, 'role:', message.role);
  }

  // Get messages for a session
  getMessages(sessionId: string): Message[] {
    const cached = this.messageCache.get(sessionId);
    if (cached) {
      return [...cached];
    }

    const rows = this.db.messages.getBySessionId(sessionId);
    const messages = rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role as Message['role'],
      content: this.normalizeContent(row.content),
      timestamp: row.timestamp,
      tokenUsage: row.token_usage ? JSON.parse(row.token_usage) : undefined,
      executionTimeMs: row.execution_time_ms ?? undefined,
    }));
    this.messageCache.set(sessionId, messages);
    return [...messages];
  }

  private normalizeContent(raw: string): ContentBlock[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as ContentBlock[];
      }
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        typeof (parsed as { type: unknown }).type === 'string'
      ) {
        return [parsed as ContentBlock];
      }
      if (typeof parsed === 'string') {
        return [{ type: 'text', text: parsed } as TextContent];
      }
      return [{ type: 'text', text: String(parsed) } as TextContent];
    } catch {
      return [{ type: 'text', text: raw } as TextContent];
    }
  }

  getTraceSteps(sessionId: string): TraceStep[] {
    return this.db.traceSteps.getBySessionId(sessionId).map((row) =>
      this.toTraceStep(row)
    );
  }

  /**
   * Steps of a single agent run. A session accumulates one trace per turn, so
   * a report about "the run the user is watching" must be able to select that
   * run instead of every step the session has ever produced.
   */
  getRunTraceSteps(sessionId: string, runId: string): TraceStep[] {
    return this.db.traceSteps.getByRunId(sessionId, runId).map((row) => this.toTraceStep(row));
  }

  private toTraceStep(row: TraceStepRow): TraceStep {
    const parseToolInput = (value: string | null): Record<string, unknown> | undefined => {
      if (!value) return undefined;
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    };
    return {
      id: row.id,
      runId: row.run_id ?? undefined,
      type: row.type as TraceStep['type'],
      status: row.status as TraceStep['status'],
      title: row.title,
      content: row.content || undefined,
      toolName: row.tool_name || undefined,
      toolInput: parseToolInput(row.tool_input),
      toolOutput: row.tool_output || undefined,
      isError: row.is_error === 1 ? true : undefined,
      timestamp: row.timestamp,
      duration: row.duration ?? undefined,
    };
  }

  // Handle permission response
  handlePermissionResponse(toolUseId: string, result: PermissionResult): void {
    const resolver = this.pendingPermissions.get(toolUseId);
    if (resolver) {
      resolver(result);
      this.pendingPermissions.delete(toolUseId);
    }
  }

  // Request permission for a tool
  async requestPermission(
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PermissionResult> {
    return new Promise((resolve) => {
      // Phase 6 control center: an approval request is exactly the "the agent
      // needs a human" event the notification center exists for. The title is
      // the technical subject (tool name); the renderer supplies the label.
      const notification = this.notificationCenter?.notify({
        sessionId,
        kind: 'approval',
        title: toolName,
        ...(summarizeToolActivityDetail(input)
          ? { detail: summarizeToolActivityDetail(input) }
          : {}),
      });
      const acknowledge = () => {
        if (notification) {
          this.notificationCenter?.acknowledge(notification.id);
        }
      };
      const timeoutId = setTimeout(() => {
        this.pendingPermissions.delete(toolUseId);
        acknowledge();
        resolve('deny');
        this.sendToRenderer({ type: 'permission.dismiss', payload: { toolUseId } });
      }, 60_000);
      this.pendingPermissions.set(toolUseId, (result: PermissionResult) => {
        clearTimeout(timeoutId);
        acknowledge();
        resolve(result);
      });
      this.sendToRenderer({
        type: 'permission.request',
        payload: { toolUseId, toolName, input, sessionId },
      });
    });
  }

  // Request sudo password from the user
  async requestSudoPassword(
    sessionId: string,
    toolUseId: string,
    command: string
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingSudoPasswords.delete(toolUseId);
        resolve(null);
        this.sendToRenderer({ type: 'sudo.password.dismiss', payload: { toolUseId } });
      }, 60_000);
      this.pendingSudoPasswords.set(toolUseId, {
        sessionId,
        resolve: (password: string | null) => {
          clearTimeout(timeout);
          resolve(password);
        },
      });
      this.sendToRenderer({
        type: 'sudo.password.request',
        payload: { toolUseId, command, sessionId },
      });
    });
  }

  // Handle sudo password response from renderer
  handleSudoPasswordResponse(toolUseId: string, password: string | null): void {
    const entry = this.pendingSudoPasswords.get(toolUseId);
    if (entry) {
      entry.resolve(password);
      this.pendingSudoPasswords.delete(toolUseId);
    }
  }

  private saveTraceStep(sessionId: string, step: TraceStep): void {
    this.db.traceSteps.create({
      id: step.id,
      session_id: sessionId,
      run_id: step.runId ?? null,
      type: step.type,
      status: step.status,
      title: step.title,
      content: step.content ?? null,
      tool_name: step.toolName ?? null,
      tool_input: step.toolInput ? JSON.stringify(step.toolInput) : null,
      tool_output: step.toolOutput ?? null,
      is_error: step.isError ? 1 : null,
      timestamp: step.timestamp,
      duration: step.duration ?? null,
    });
  }

  private updateTraceStep(stepId: string, updates: Partial<TraceStep>): void {
    const rowUpdates: Partial<TraceStepRow> = {};
    if (updates.type !== undefined) rowUpdates.type = updates.type;
    if (updates.status !== undefined) rowUpdates.status = updates.status;
    if (updates.title !== undefined) rowUpdates.title = updates.title;
    if (updates.content !== undefined) rowUpdates.content = updates.content;
    if (updates.toolName !== undefined) rowUpdates.tool_name = updates.toolName;
    if (updates.toolInput !== undefined) {
      rowUpdates.tool_input = updates.toolInput ? JSON.stringify(updates.toolInput) : null;
    }
    if (updates.toolOutput !== undefined) rowUpdates.tool_output = updates.toolOutput;
    if (updates.isError !== undefined) rowUpdates.is_error = updates.isError ? 1 : 0;
    if (updates.timestamp !== undefined) rowUpdates.timestamp = updates.timestamp;
    if (updates.duration !== undefined) rowUpdates.duration = updates.duration;

    this.db.traceSteps.update(stepId, rowUpdates);
  }
}
