/**
 * @module main/agent/agent-runner
 *
 * AI query execution engine.
 *
 * Responsibilities:
 * - Runs AI conversations via the Open Cowork agent SDK (createAgentSession)
 * - Routes providers via pi-ai SDK for model resolution
 * - Bridges MCP tools into SDK ToolDefinition format
 * - Streams responses back as ServerEvents (stream.message, stream.partial, trace.step)
 * - Skills injection, system prompt assembly, permission handling
 *
 * Dependencies: session-manager, mcp-manager, config-store, skills-manager
 */
import { type AgentSession as PiAgentSession } from '@mariozechner/pi-coding-agent';
import { getSharedAuthStorage } from './shared-auth';
import { getPiAgentInternals } from './pi-agent-access';
import { getSharedProjectStore } from '../projects/project-store';
import { assembleContextualPrompt } from './contextual-prompt';
import { buildPiSessionTools } from './pi-session-tools';
import { createPiSession, type CachedPiSession } from './create-pi-session';
import { ToolActivityRecorder } from './tool-activity-recorder';
import type { ActivityTracker } from './activity-tracker';
import { reusePiSession } from './reuse-pi-session';
import {
  evictCachedPiSession,
  hasSessionContextChanged,
  resolvePiSessionRecreateReason,
} from './pi-session-lifecycle';
import { resolveProjectContext, type ProjectContextResolution } from '../projects/project-context';
import {
  buildDraftDetailText,
  decideTwoStage,
  mergeTokenUsage,
  runTwoStagePipeline,
  shouldArmTwoStage,
  type TwoStageResult,
} from '../projects/two-stage-pipeline';
import { runPiAiOneShot } from './sdk-one-shot';
import { installPiPayloadHook } from './openai-payload-sanitizer';
import {
  initSandboxSession,
  resolveSandboxBackend,
  syncSandboxChangesToHost,
} from './agent-runner-sandbox-session';
import { createStreamLivenessWatcher } from './stream-liveness';
import { registerRunSignal, unregisterRunSignal } from './run-abort-registry';
import { buildMcpServersConfig, type McpServersCache } from './mcp-servers-config';
import { buildCoworkAppendPrompt } from './runtime-config-summary';
import { setupSkillsDirectories } from './skills-directory-setup';
import { logSessionStreamEvent, type SessionEventLoggingDeps } from './session-event-logging';
import {
  handlePiSessionEvent,
  type PiSessionEventContext,
  type PiSessionEventState,
} from './session-event-handler';
import type { Session, Message, TraceStep, ServerEvent, ContentBlock } from '../../shared/types';
import { resolveSettingsLadder } from '../../shared/settings-levels';
import { v4 as uuidv4 } from 'uuid';
import { PathResolver } from '../sandbox/path-resolver';
import { MCPManager } from '../mcp/mcp-manager';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import {
  log,
  logWarn,
  logError,
  logCtx,
  logCtxWarn,
  logCtxError,
  logTiming,
} from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { app } from 'electron';
import { setMaxListeners } from 'node:events';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import { pathConverter } from '../sandbox/wsl-bridge';
import { safeStringify, summarizeMessageForLog, toErrorText } from './agent-runner-formatting';
import {
  getBundledNodePaths,
  resolveBundledPythonBinDir,
  resolveBundledToolsBinDir,
} from './bundled-binaries';
import {
  getBundledPathHints as buildBundledPathHints,
  getBuiltinSkillsPath as resolveBuiltinSkillsPath,
  getAppAgentDir as resolveAppAgentDir,
  getRuntimeSkillsDir as resolveRuntimeSkillsDir,
  getConfiguredGlobalSkillsDir as resolveConfiguredGlobalSkillsDir,
  syncUserSkillsToAppDir as syncUserSkills,
  syncConfiguredSkillsToRuntimeDir as syncConfiguredSkills,
  legacySkillPaths,
  copyDirectorySync as copyDirectoryTree,
} from './skills-paths';
import {
  installPermissionHook as installPermissionHookImpl,
  installModsHooks as installModsHooksImpl,
} from './agent-hooks';
import { getDefaultShell } from '../utils/shell-resolver';
import { PluginRuntimeService } from '../skills/plugin-runtime-service';
import type { SkillsAdapter } from '../skills/skills-adapter';
import { AgentRuntimeExtensionManager } from '../extensions/agent-runtime-extension-manager';
import { configStore } from '../config/config-store';
import { normalizeOpenAICompatibleBaseUrl } from '../config/auth-utils';
import {
  buildTerminalErrorEmissionDetails,
  buildTerminalErrorMessage,
  classifyTerminalError,
  TIMEOUT_ERROR_MESSAGE_TEXT,
  resolveAbortDisposition,
  shouldPreserveExistingTrace,
  toUserFacingErrorText,
  type TerminalErrorCode,
} from './agent-runner-message-end';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from './pi-model-resolution';
import { shouldFallbackToProvider } from './provider-fallback';
import { buildPiSessionRuntimeSignature } from './pi-session-runtime';
import { buildAbortUserMessage } from './agent-runner-loop-guard';
import { createLoopGuardController } from './loop-guard-controller';
import { fetchOllamaModelInfo } from '../config/ollama-api';
import { EliteCodingIntelligence } from './elite-coding-intelligence';
import { SkillSynthesizer } from '../skills/skill-synthesizer';
import type { MemoryManager } from '../memory/memory-manager';
import { AdaptiveStrategyEngine } from './adaptive-strategy-engine';
import { ActivePreferenceLearner } from '../memory/active-preference-learner';

// Virtual workspace path shown to the model (hides real sandbox path)
const VIRTUAL_WORKSPACE_PATH = '/workspace';

/**
 * Resolve the project context of a session (instructions, reference files,
 * pinned ConfigSet). Never throws: an uninitialized database (unit tests,
 * headless startup order) degrades to an empty context — a project link must
 * never take a session down with it.
 */
function resolveProjectContextForRunner(sessionId: string): ProjectContextResolution {
  try {
    return resolveProjectContext(sessionId, getSharedProjectStore());
  } catch {
    // Degraded context: no project, single-model mode, no system-prompt block.
    return {
      project: undefined,
      configSetId: null,
      configModelId: null,
      pipelineMode: 'single',
      draftConfigSetId: null,
      draftModelId: null,
      refineConfigSetId: null,
      refineModelId: null,
      systemPromptBlock: '',
    };
  }
}

/**
 * One-time enrichment of process.env.PATH for build (production) mode.
 *
 * In dev mode, Electron inherits the user's full shell PATH, so Skill commands
 * like `python3` and `node` just work. In build mode, `process.env.PATH` is
 * minimal (often just `/usr/bin:/bin`).
 *
 * This function:
 * 1. Restores the user's login-shell PATH (safe: uses execFileSync, not execSync)
 * 2. Prepends bundled Node, Python, and tools bin dirs (highest priority)
 * 3. Deduplicates all entries
 * 4. Writes the result back to `process.env.PATH`
 *
 * Called once before the first `createCodingTools()` — subsequent calls are no-ops.
 */
let pathEnriched = false;

async function enrichProcessPathForBuild(): Promise<void> {
  if (pathEnriched) return;
  pathEnriched = true;

  if (!app.isPackaged) {
    log('[CoworkAgentRunner] Dev mode — skipping PATH enrichment');
    return;
  }

  const platform = process.platform;
  const delimiter = platform === 'win32' ? ';' : ':';
  const currentPaths = (process.env.PATH || '').split(delimiter).filter((p: string) => p.trim());

  // 1. Restore user's login-shell PATH
  let shellPaths: string[] = [];
  if (platform === 'darwin' || platform === 'linux') {
    try {
      const shell = getDefaultShell();
      const output = (
        execFileSync(shell, ['-l', '-c', 'echo $PATH'], {
          encoding: 'utf-8',
          timeout: 5000,
          env: { ...process.env, HOME: os.homedir() },
        }) as string
      ).trim();
      if (output) {
        shellPaths = output.split(':').filter((p: string) => p.trim());
        log(`[CoworkAgentRunner] Restored ${shellPaths.length} paths from login shell`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[CoworkAgentRunner] Could not restore shell PATH: ${message}`);
    }
  } else if (platform === 'win32') {
    try {
      const output = (
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            "[Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')",
          ],
          { encoding: 'utf-8', timeout: 5000 }
        ) as string
      ).trim();
      if (output) {
        shellPaths = output.split(';').filter((p: string) => p.trim());
        log(`[CoworkAgentRunner] Restored ${shellPaths.length} paths from Windows registry`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[CoworkAgentRunner] Could not restore Windows PATH: ${message}`);
    }
  }

  // 2. Collect bundled bin directories (highest priority)
  const bundledDirs: string[] = [];

  const nodePaths = getBundledNodePaths();
  if (nodePaths) {
    bundledDirs.push(path.dirname(nodePaths.node));
  }

  const pythonBinDir = resolveBundledPythonBinDir();
  if (pythonBinDir) {
    bundledDirs.push(pythonBinDir);
  }

  const toolsBinDir = resolveBundledToolsBinDir();
  if (toolsBinDir) {
    bundledDirs.push(toolsBinDir);
  }

  // 3. Merge: bundled (highest) → shell → current process, deduplicate
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const p of [...bundledDirs, ...shellPaths, ...currentPaths]) {
    const normalized = platform === 'win32' ? p.toLowerCase() : p;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(p);
    }
  }

  process.env.PATH = merged.join(delimiter);
  log(
    `[CoworkAgentRunner] Enriched process.env.PATH for build mode: ${bundledDirs.length} bundled + ${shellPaths.length} shell + ${currentPaths.length} process → ${merged.length} total`
  );
}

// Shared pi-ai auth storage — created once, reused across sessions.

/**
 * Phase 7 model routing: what the runner needs to ask for an adaptive model
 * decision. The callback returns a model id, or undefined to keep the
 * configured model.
 */
export interface AgentModelResolutionInput {
  sessionId: string;
  prompt: string;
  /** Model that would be used without adaptive routing. */
  fallbackModel: string;
}

/** One finished run, reported so Phase 7 can build a local benchmark. */
export interface AgentRunBenchmarkInput {
  modelId: string;
  prompt: string;
  success: boolean;
  latencyMs: number;
}

/**
 * Outcome of a single run attempt, returned so the caller can decide whether a
 * retry on another provider is safe. `retryable` is deliberately narrow: it is
 * true only for a rate limit / gateway / network failure that produced no tool
 * execution, which is the one case where replaying the turn cannot duplicate a
 * side effect. `errorCode` lets the caller route without re-parsing the message.
 */
export interface AgentRunResult {
  /** True when the turn completed without a terminal error. */
  ok: boolean;
  /** Machine-readable failure kind, or undefined on success. */
  errorCode?: TerminalErrorCode;
  /** Raw error text as classified, useful for logging. */
  errorText?: string;
  /** True when this failure may be replayed on another provider. */
  retryable: boolean;
  /** Tool calls started during the attempt; non-zero blocks any replay. */
  toolExecutions: number;
  /**
   * Publish the error that was held back for this turn. The caller invokes it
   * when it decides not to retry, so a failure is either replaced by a
   * successful answer or shown exactly once — never both. Idempotent.
   */
  flushError(): void;
}

interface AgentRunnerOptions {
  sendToRenderer: (event: ServerEvent) => void;
  saveMessage?: (message: Message) => void;
  /** Phase 6 control center: records tool executions in the activity feed. */
  activityTracker?: ActivityTracker;
  /** Phase 7 model routing: adaptive model selection for this run. */
  modelResolver?: (input: AgentModelResolutionInput) => string | undefined;
  /** Phase 7 model routing: local evidence recorded after every run. */
  benchmarkRecorder?: (input: AgentRunBenchmarkInput) => void;
  requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  requestPermission?: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<'allow' | 'deny' | 'allow_always'>;
}

/**
 * CoworkAgentRunner - Uses @mariozechner/pi-coding-agent SDK
 *
 * Environment variables should be set before running:
 *   ANTHROPIC_BASE_URL=https://openrouter.ai/api
 *   ANTHROPIC_AUTH_TOKEN=your_openrouter_api_key
 *   ANTHROPIC_API_KEY="" (must be empty)
 */
export class CoworkAgentRunner {
  private sendToRenderer: (event: ServerEvent) => void;
  private saveMessage?: (message: Message) => void;
  private requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  private requestPermission?: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<'allow' | 'deny' | 'allow_always'>;
  private pathResolver: PathResolver;
  private mcpManager?: MCPManager;
  private _pluginRuntimeService?: PluginRuntimeService;
  private _skillsAdapter?: SkillsAdapter;
  private extensionManager?: AgentRuntimeExtensionManager;
  private activityTracker?: ActivityTracker;
  private modelResolver?: (input: AgentModelResolutionInput) => string | undefined;
  private benchmarkRecorder?: (input: AgentRunBenchmarkInput) => void;
  private activeControllers: Map<string, AbortController> = new Map();
  /**
   * Run id (one per user turn) stamped onto every trace step the turn emits.
   * Steps are keyed by session in the UI, so without this a step from a turn
   * that finished ten messages ago is indistinguishable from a live one.
   */
  private activeRunIds: Map<string, string> = new Map();
  private piSessions: Map<string, CachedPiSession> = new Map();
  private toolDisplayNameCache: Map<string, string> = new Map();
  private static readonly MAX_CACHED_SESSIONS = 50;

  // Per-instance caches — invalidated when the underlying config changes.
  private _mcpServersCache: McpServersCache | null = null;
  private _skillsSetupDone = false;
  private skillSynthesizer?: SkillSynthesizer;
  private memoryManager?: MemoryManager;

  /**
   * Clear SDK session cache for a session
   * Called when session's cwd changes - SDK sessions are bound to cwd
   */
  clearSdkSession(sessionId: string): void {
    const cached = this.piSessions.get(sessionId);
    if (cached) {
      try {
        cached.session.dispose();
      } catch (e) {
        logWarn('[CoworkAgentRunner] dispose error:', e);
      }
      this.piSessions.delete(sessionId);
      log('[CoworkAgentRunner] Disposed pi session for:', sessionId);
    }
  }

  clearAllSdkSessions(): void {
    for (const sessionId of Array.from(this.piSessions.keys())) {
      this.clearSdkSession(sessionId);
    }
  }

  /** Call after the user installs / removes a skill so the next query re-links everything. */
  invalidateSkillsSetup(): void {
    this._skillsSetupDone = false;
  }

  /**
   * Install the adapter that decides which skill directories the resource loader
   * receives. Wired after construction because SkillsManager is created later
   * than SessionManager, which owns the runner.
   */
  setSkillsAdapter(adapter: SkillsAdapter | undefined): void {
    this._skillsAdapter = adapter;
    this._skillsSetupDone = false;
  }

  /** Call after the user changes MCP server config so the next query rebuilds mcpServers. */
  invalidateMcpServersCache(): void {
    this._mcpServersCache = null;
    // Sessions stay alive — MCP tools are rebuilt each query via buildMcpCustomTools()
    log('[CoworkAgentRunner] MCP servers cache invalidated — tools will rebuild on next query');
  }

  // TODO: Credentials should be served via a secure MCP tool or IPC channel,
  // not injected as plaintext into the system prompt. The getCredentialsPrompt()
  // method was removed to eliminate credential leakage risk.

  private async resolveSkillPaths(sessionId?: string): Promise<string[]> {
    const basePaths = this._skillsAdapter
      ? this._skillsAdapter.getSkillPaths()
      : legacySkillPaths();
    const mergedPaths = new Set(
      basePaths.filter((item): item is string => Boolean(item && fs.existsSync(item)))
    );
    const appliedPlugins: Array<{ name: string; path: string }> = [];

    if (this._pluginRuntimeService) {
      try {
        const runtimePlugins = await this._pluginRuntimeService.getEnabledRuntimePlugins();
        for (const plugin of runtimePlugins) {
          if (!plugin.componentsEnabled.skills || plugin.componentCounts.skills <= 0) {
            continue;
          }
          const runtimeSkillsPath = path.join(plugin.runtimePath, 'skills');
          if (!fs.existsSync(runtimeSkillsPath)) {
            continue;
          }
          mergedPaths.add(runtimeSkillsPath);
          appliedPlugins.push({ name: plugin.name, path: runtimeSkillsPath });
        }
      } catch (error) {
        logWarn('[CoworkAgentRunner] Failed to resolve runtime plugin skill paths:', error);
      }
    }

    if (sessionId && appliedPlugins.length > 0) {
      this.sendToRenderer({
        type: 'plugins.runtimeApplied',
        payload: { sessionId, plugins: appliedPlugins },
      });
    }

    return Array.from(mergedPaths);
  }

  /**
   * Generate bundled executable path hints for production mode system prompt.
   * In dev mode returns empty string (user PATH already works).
   * This is a defense-in-depth layer — even if PATH enrichment works, explicit
   * paths help the model avoid ambiguity when Skills reference bare commands.
   */
  private getBundledPathHints(): string {
    return buildBundledPathHints();
  }

  /** Get the built-in skills directory (shipped with the app). */
  private getBuiltinSkillsPath(): string {
    return resolveBuiltinSkillsPath();
  }

  private getAppAgentDir(): string {
    return resolveAppAgentDir();
  }

  private getRuntimeSkillsDir(): string {
    return resolveRuntimeSkillsDir();
  }

  private getConfiguredGlobalSkillsDir(): string {
    return resolveConfiguredGlobalSkillsDir();
  }

  private syncUserSkillsToAppDir(appSkillsDir: string): void {
    syncUserSkills(appSkillsDir);
  }

  private syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir: string): void {
    syncConfiguredSkills(runtimeSkillsDir);
  }

  private copyDirectorySync(source: string, target: string): void {
    copyDirectoryTree(source, target);
  }

  constructor(
    options: AgentRunnerOptions,
    pathResolver: PathResolver,
    mcpManager?: MCPManager,
    pluginRuntimeService?: PluginRuntimeService,
    skillsAdapter?: SkillsAdapter,
    extensionManager?: AgentRuntimeExtensionManager,
    memoryManager?: MemoryManager
  ) {
    this.sendToRenderer = options.sendToRenderer;
    this.saveMessage = options.saveMessage;
    this.requestSudoPassword = options.requestSudoPassword;
    this.requestPermission = options.requestPermission;
    this.pathResolver = pathResolver;
    this.mcpManager = mcpManager;
    this._pluginRuntimeService = pluginRuntimeService;
    this._skillsAdapter = skillsAdapter;
    this.extensionManager = extensionManager;
    this.memoryManager = memoryManager;
    this.activityTracker = options.activityTracker;
    this.modelResolver = options.modelResolver;

    log('[CoworkAgentRunner] Initialized with Open Cowork agent SDK');
    log('[CoworkAgentRunner] Skills enabled: settingSources=[user, project], Skill tool enabled');
    if (mcpManager) {
      log('[CoworkAgentRunner] MCP support enabled');
    }
  }

  private installPermissionHook(piSession: PiAgentSession, sessionId: string): void {
    installPermissionHookImpl({
      piSession,
      sessionId,
      requestPermission: this.requestPermission,
      getToolDisplayName: (name) => this.getToolDisplayName(name),
    });
  }

  private installModsHooks(piSession: PiAgentSession, sessionId: string): void {
    installModsHooksImpl(piSession, sessionId);
  }

  /**
   * Install the SDK's outgoing-payload hook on a freshly created session.
   * Extracted from run() so the payload policy lives in a tested module:
   *  - Ollama: inject `num_ctx` on every request (unchanged behaviour);
   *  - OpenAI-compatible relays: drop non-standard `thinking` content parts
   *    that make them answer 422 on the second turn of a tool-using exchange.
   */
  private installPayloadHook(
    piSession: PiAgentSession,
    sessionId: string,
    options: {
      provider?: string;
      customProtocol?: string;
      baseUrl?: string;
      modelId?: string;
      contextWindow?: number;
    }
  ): void {
    const isOllama = options.provider === 'ollama';
    const ollamaNumCtx = isOllama ? options.contextWindow || 128000 : undefined;
    const installation = installPiPayloadHook(getPiAgentInternals(piSession), {
      endpoint: {
        provider: options.provider,
        customProtocol: options.customProtocol,
        baseUrl: options.baseUrl,
        modelId: options.modelId,
      },
      sanitizeThinking: options.customProtocol === 'openai' || options.provider === 'openai',
      ollamaNumCtx,
    });

    if (!installation.installed) {
      if (isOllama && installation.reason === 'no-hook') {
        logWarn(
          '[CoworkAgentRunner] SDK agent does not expose _onPayload — skipping Ollama num_ctx patch'
        );
      }
      return;
    }

    if (typeof ollamaNumCtx === 'number') {
      this.piSessions.get(sessionId)!.ollamaNumCtx = { value: ollamaNumCtx };
    }
    log(
      '[CoworkAgentRunner] Payload hook installed:',
      isOllama ? 'ollama num_ctx=' + ollamaNumCtx : 'no num_ctx',
      '| strips thinking parts:',
      installation.stripsThinking
    );
  }

  private getToolDisplayName(toolName: string): string {
    const cached = this.toolDisplayNameCache.get(toolName);
    if (cached) {
      return cached;
    }

    let displayName = toolName;
    if (!toolName.startsWith('mcp__')) {
      this.toolDisplayNameCache.set(toolName, displayName);
      return displayName;
    }

    const mcpTool = this.mcpManager?.getTool(toolName);
    if (mcpTool?.originalName) {
      displayName = mcpTool.originalName;
    } else {
      const match = toolName.match(/^mcp__(.+?)__(.+)$/);
      displayName = match?.[2] || toolName;
    }

    this.toolDisplayNameCache.set(toolName, displayName);
    return displayName;
  }

  /** Phase 6 control center: swap the activity sink (or clear it). */
  public setActivityTracker(tracker?: ActivityTracker): void {
    this.activityTracker = tracker;
  }

  /** Phase 7 model routing: swap the adaptive model resolver (or clear it). */
  public setModelResolver(
    resolver?: (input: AgentModelResolutionInput) => string | undefined
  ): void {
    this.modelResolver = resolver;
  }

  /** Phase 7 model routing: swap the local benchmark sink (or clear it). */
  public setBenchmarkRecorder(
    recorder?: (input: AgentRunBenchmarkInput) => void
  ): void {
    this.benchmarkRecorder = recorder;
  }

  /**
   * Resolve current model string from runtime config, optionally deferring to
   * the Phase 7 adaptive router.
   */
  private getCurrentModelString(
    preferredModel?: string,
    routing?: { sessionId: string; prompt: string; allowAdaptive: boolean }
  ): string {
    const routeModel = preferredModel?.trim();
    const configuredModel = configStore.get('model')?.trim();
    const fallback = routeModel || configuredModel || 'anthropic/claude-sonnet-4-6';
    const routed = routing?.allowAdaptive
      ? this.modelResolver?.({
          sessionId: routing.sessionId,
          prompt: routing.prompt,
          fallbackModel: fallback,
        })?.trim()
      : undefined;
    if (routed) {
      logCtx('[CoworkAgentRunner] Current model:', routed);
      logCtx('[CoworkAgentRunner] Model source:', 'modelRouting');
      return routed;
    }
    logCtx('[CoworkAgentRunner] Current model:', fallback);
    logCtx(
      '[CoworkAgentRunner] Model source:',
      routeModel ? 'runtimeRoute.model' : configuredModel ? 'configStore.model' : 'default'
    );
    return fallback;
  }

  async run(
    session: Session,
    prompt: string,
    existingMessages: Message[]
  ): Promise<AgentRunResult> {
    const runStartTime = Date.now();
    logCtx('[CoworkAgentRunner] run() started');

    // Counts tool calls independently of the control center: the recorder above
    // is optional, and a provider fallback that read a missing recorder as
    // "zero tools" would replay a turn whose side effects already landed.
    let startedToolExecutions = 0;
    const bumpToolCount = (): void => {
      startedToolExecutions += 1;
    };
    // Set by the catch block when an exception escapes the try; the early
    // returns inside the try build their result directly.
    let runResult: AgentRunResult | undefined;
    // A terminal error held back while the caller decides whether to replay the
    // turn on another provider. Publishing it now would leave a stale 429 banner
    // in the transcript right next to the answer the retry produces. It stays
    // local to this run (no instance field) so concurrent sessions can never
    // cross-flush each other's held error.
    let pendingTerminalError:
      | { messageText: string; errorCode: TerminalErrorCode }
      | undefined;
    // Publishes the held-back error. The session manager calls this when it
    // cannot retry, so the user always ends up with exactly one message
    // describing what happened — never a banner followed by a success.
    const flushPendingTerminalError = (): void => {
      if (!pendingTerminalError) {
        return;
      }
      const { messageText, errorCode } = pendingTerminalError;
      pendingTerminalError = undefined;
      this.sendMessage(session.id, {
        id: uuidv4(),
        sessionId: session.id,
        role: 'assistant',
        content: [{ type: 'text', text: messageText }],
        timestamp: Date.now(),
        isError: true,
        errorCode,
      });
    };

    const controller = new AbortController();
    try {
      // SDK 会在同一 AbortSignal 上挂载较多监听器，放开上限避免无意义告警干扰排错。
      setMaxListeners(0, controller.signal);
    } catch {
      // 旧运行时不支持 EventTarget 调整监听上限时忽略即可。
    }
    this.activeControllers.set(session.id, controller);
    // Every trace step this turn emits is stamped with a run id, so a step can
    // be attributed to the turn that produced it rather than to the session,
    // which accumulates steps for every turn it has ever served.
    const runId = uuidv4();
    this.activeRunIds.set(session.id, runId);
    // Long-running tools (the swarm) resolve the cancel handle from the
    // registry at execution time, because the cached tool set outlives the
    // turn that built it. See run-abort-registry.ts.
    registerRunSignal(session.id, controller.signal);

    // Phase 6 control center: tool executions are mirrored into the activity
    // feed. One recorder per run keeps the toolCallId mapping session-scoped.
    // The recorder is optional (no control center), so the fallback policy gets
    // its tool count from `bumpToolCount`, which is wired unconditionally.
    const toolActivity = this.activityTracker
      ? new ToolActivityRecorder(this.activityTracker, session.id)
      : undefined;
    // Phase 7: the model that actually ran, reported to the benchmark sink in
    // the finally block. Hoisted because it is resolved inside the try.
    let usedModelString: string | undefined;

    // Sandbox isolation state (defined outside try for finally access)
    let sandboxPath: string | null = null;
    let useSandboxIsolation = false;

    // Helper to convert real sandbox paths back to virtual workspace paths in output
    // Cache the compiled regex to avoid recompilation on every call
    let sandboxPathRegex: RegExp | null = null;
    const sanitizeOutputPaths = (content: string): string => {
      if (!sandboxPath || !useSandboxIsolation) return content;
      if (!sandboxPathRegex) {
        sandboxPathRegex = new RegExp(sandboxPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      }
      // Replace real sandbox path with virtual workspace path
      return content.replace(sandboxPathRegex, VIRTUAL_WORKSPACE_PATH);
    };

    const thinkingStepId = uuidv4();
    let abortedByTimeout = false;
    // Set to true when the loop-guard unilaterally aborts (hash_abort / freq_abort).
    // The catch block consults this flag to avoid overwriting the 'error' trace
    // status that handleLoopGuardDecision has already published.
    let abortedByLoopGuard = false;
    // Set to true when the provider emits a terminal stream error mid-turn.
    // The catch block consults this flag to avoid overwriting the published
    // 'Request failed' trace state with a generic 'Cancelled' update.
    let abortedByStreamError = false;
    // Hoisted to run() scope so the finally block can evict the SDK session
    // after any terminal error (400, stream error, empty response, etc.).
    let terminalErrorText: string | undefined;

    try {
      this.pathResolver.registerSession(session.id, session.mountedPaths);
      logTiming('pathResolver.registerSession', runStartTime);

      // Note: User message is now added by the frontend immediately for better UX
      // No need to send it again from backend

      // Send initial thinking trace
      this.sendTraceStep(session.id, {
        id: thinkingStepId,
        type: 'thinking',
        status: 'running',
        title: 'Processing request...',
        timestamp: Date.now(),
      });
      logTiming('sendTraceStep (thinking)', runStartTime);

      // Use session's cwd - each session has its own working directory
      const workingDir = session.cwd || undefined;
      logCtx('[CoworkAgentRunner] Working directory:', workingDir || '(none)');

      // Initialize the isolated sandbox session (project files + skills) when
      // WSL/Lima is active. The orchestration lives in
      // agent-runner-sandbox-session so it is unit-testable without a VM; only
      // the platform decision stays here.
      const sandbox = getSandboxAdapter();
      const sandboxInit = await initSandboxSession({
        sessionId: session.id,
        workingDir,
        backend: resolveSandboxBackend({
          isWsl: sandbox.isWSL,
          wslDistro: sandbox.wslStatus?.distro,
          isLima: sandbox.isLima,
          limaInstanceRunning: sandbox.limaStatus?.instanceRunning,
          hasWorkingDir: Boolean(workingDir),
        }),
        getBuiltinSkillsPath: () => this.getBuiltinSkillsPath(),
        getRuntimeSkillsDir: () => this.getRuntimeSkillsDir(),
        syncUserSkills: (runtimeSkillsDir) => this.syncUserSkillsToAppDir(runtimeSkillsDir),
        syncConfiguredSkills: (runtimeSkillsDir) =>
          this.syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir),
        toVmPath: (hostPath) => pathConverter.toWSL(hostPath),
        notify: (status) => this.sendToRenderer({ type: 'sandbox.sync', payload: status }),
      });
      sandboxPath = sandboxInit.sandboxPath;
      useSandboxIsolation = sandboxInit.useSandboxIsolation;

      // Check if current user message includes images
      const lastUserMessage =
        existingMessages.length > 0 ? existingMessages[existingMessages.length - 1] : null;

      logCtx('[CoworkAgentRunner] Total messages:', existingMessages.length);

      const hasImages =
        lastUserMessage?.content.some((c) => (c as { type?: string }).type === 'image') || false;
      if (hasImages) {
        log('[CoworkAgentRunner] User message contains images');
      }

      logTiming('before pi-ai model resolution', runStartTime);

      // Project context for this session: instructions + reference files are
      // injected in the system prompt (first query), and a project may pin its
      // own ConfigSet instead of the globally active one.
      const projectContext = resolveProjectContextForRunner(session.id);

      // ── Two-stage pipeline (project opt-in) ──────────────────────────
      // A project can chain two models: a fast "draft" model produces the
      // first pass (it owns ALL tool execution), then a separate "refine"
      // model reviews and polishes the text. Only the refined answer is
      // presented; the draft stays available as a collapsible detail.
      //
      // The arming decision is made BEFORE the draft runs so the live draft
      // stream can be withheld. Trivial exchanges never arm the pipeline: the
      // extra call has to be earned. When the pipeline is off or unarmed the
      // code below is exactly the historical single-model path.
      const pipelineRefineConfig = projectContext.refineConfigSetId
        ? configStore.getConfigSetProjectedConfig(
            projectContext.refineConfigSetId,
            projectContext.refineModelId ?? undefined
          ) || configStore.getAll()
        : undefined;
      const pipelineArmDecision = shouldArmTwoStage({
        mode: projectContext.pipelineMode,
        userRequest: prompt,
        hasRefineModel: Boolean(pipelineRefineConfig),
      });
      const twoStageArmed = pipelineArmDecision.run;
      if (projectContext.pipelineMode === 'two-stage' && !twoStageArmed) {
        log(
          '[CoworkAgentRunner] Two-stage pipeline not armed:',
          pipelineArmDecision.reason,
          '— falling back to single-model behavior'
        );
      }

      // Settings ladder: global -> project -> session. Both the ConfigSet and
      // the model can be overridden at a higher level; a level that pins an
      // unknown set id is ignored as a whole (with a warning) instead of being
      // half-applied. The same pure resolver backs the UI panel, so what the
      // user sees is exactly what runs here.
      const globalConfig = configStore.getAll();
      const settingsLadder = resolveSettingsLadder({
        global: {
          activeConfigSetId: globalConfig.activeConfigSetId,
          configSets: globalConfig.configSets,
        },
        project: projectContext.project
          ? {
              id: projectContext.project.id,
              name: projectContext.project.name,
              configSetId: projectContext.project.configSetId,
              modelId: projectContext.project.modelId,
            }
          : null,
        session: { configSetId: session.configSetId, modelId: session.configModelId },
      });
      for (const warning of settingsLadder.warnings) {
        logCtxWarn(
          '[CoworkAgentRunner] Settings ladder warning:',
          warning.code,
          warning.level,
          warning.value ?? ''
        );
      }

      // Resolve model via pi-ai — the ladder's winner. In two-stage mode the
      // project's draft slot selects the model that produces the first pass.
      const effectiveConfigSetId = twoStageArmed
        ? projectContext.draftConfigSetId
        : settingsLadder.configSetId || null;
      const effectiveConfigModelId = twoStageArmed
        ? projectContext.draftModelId
        : settingsLadder.model || null;
      const runtimeConfig =
        (effectiveConfigSetId
          ? configStore.getConfigSetProjectedConfig(
              effectiveConfigSetId,
              effectiveConfigModelId ?? undefined
            )
          : undefined) || globalConfig;
      // An explicit project or session choice is a human decision and always
      // wins; adaptive routing only fills the global-only default slot.
      const modelString = this.getCurrentModelString(runtimeConfig.model, {
        sessionId: session.id,
        prompt,
        allowAdaptive: twoStageArmed
          ? false
          : !settingsLadder.hasExplicitConfigSet && !settingsLadder.hasExplicitModel,
      });
      usedModelString = modelString;
      const configProtocol = resolvePiRouteProtocol(
        runtimeConfig.provider,
        runtimeConfig.customProtocol
      );

      // Normalize base URL for OpenAI-compatible providers (strips copy-pasted endpoint suffixes)
      const rawBaseUrl = runtimeConfig.baseUrl?.trim() || undefined;
      const effectiveBaseUrl =
        configProtocol === 'openai' && runtimeConfig.provider !== 'ollama'
          ? normalizeOpenAICompatibleBaseUrl(rawBaseUrl) || rawBaseUrl
          : rawBaseUrl;

      let usedSyntheticModel = false;
      let piModel = resolvePiRegistryModel(modelString, {
        configProvider: configProtocol,
        customBaseUrl: effectiveBaseUrl,
        rawProvider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
      });

      if (!piModel) {
        usedSyntheticModel = true;
        // Synthetic fallback: construct a Model for unknown/custom models
        const synthetic = resolveSyntheticPiModelFallback({
          rawModel: runtimeConfig.model,
          resolvedModelString: modelString,
          rawProvider: runtimeConfig.provider,
          routeProtocol: configProtocol,
          baseUrl: effectiveBaseUrl,
        });
        piModel = buildSyntheticPiModel(
          synthetic.modelId,
          synthetic.provider,
          configProtocol,
          effectiveBaseUrl,
          undefined,
          undefined,
          runtimeConfig.contextWindow,
          runtimeConfig.maxTokens
        );
        // Apply the same runtime overrides (developer role compat, base URL, API downgrade)
        // that resolvePiRegistryModel applies to registry models
        piModel = applyPiModelRuntimeOverrides(piModel, {
          configProvider: configProtocol,
          customBaseUrl: effectiveBaseUrl,
          rawProvider: runtimeConfig.provider,
          customProtocol: runtimeConfig.customProtocol,
        });
        logCtxWarn(
          '[CoworkAgentRunner] Model not in pi-ai registry, using synthetic model:',
          modelString,
          '→',
          piModel.api
        );
      }
      logCtx('[CoworkAgentRunner] Resolved pi-ai model:', piModel.provider, piModel.id);

      // For Ollama: query actual context window from /api/show if user hasn't configured one
      const provider = runtimeConfig.provider || 'anthropic';
      if (provider === 'ollama' && !runtimeConfig.contextWindow) {
        const ollamaBaseUrl =
          piModel.baseUrl || runtimeConfig.baseUrl || 'http://localhost:11434/v1';
        const ollamaInfo = await fetchOllamaModelInfo({
          baseUrl: ollamaBaseUrl,
          model: piModel.id,
          apiKey: runtimeConfig.apiKey,
        });
        if (ollamaInfo.contextWindow) {
          log(
            '[CoworkAgentRunner] Ollama /api/show reported contextWindow:',
            ollamaInfo.contextWindow,
            '(was:',
            piModel.contextWindow,
            ')'
          );
          piModel = { ...piModel, contextWindow: ollamaInfo.contextWindow };
        }
      }

      // Send context window info to renderer for UI display
      this.sendToRenderer({
        type: 'session.contextInfo',
        payload: {
          sessionId: session.id,
          contextWindow: piModel.contextWindow || 128000,
        },
      });

      // Set up API keys via AuthStorage
      const authStorage = getSharedAuthStorage();
      const apiKey = runtimeConfig.apiKey?.trim();
      if (apiKey) {
        // Map our config provider to pi-ai provider name
        const piProvider =
          provider === 'custom' ? runtimeConfig.customProtocol || 'anthropic' : provider;
        authStorage.setRuntimeApiKey(piProvider, apiKey);
        // Also set the key for the model's native provider (e.g., when using
        // google/gemini via openrouter, pi-ai looks up "google" not "openrouter")
        if (piModel.provider !== piProvider) {
          authStorage.setRuntimeApiKey(piModel.provider, apiKey);
          log('[CoworkAgentRunner] Set runtime API key for model provider:', piModel.provider);
        }
        log('[CoworkAgentRunner] Set runtime API key for config provider:', piProvider);
      } else {
        if (provider === 'ollama') {
          log(
            '[CoworkAgentRunner] Ollama configured without explicit API key; relying on OpenAI-compatible placeholder/env auth path',
            safeStringify({
              provider,
              modelProvider: piModel.provider,
              modelId: piModel.id,
              baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
            })
          );
        } else {
          logWarn('[CoworkAgentRunner] No API key configured for provider:', provider);
        }
      }

      // baseUrl is now embedded in the model object via resolvePiModel()
      logCtx('[CoworkAgentRunner] Model baseUrl:', piModel.baseUrl, 'api:', piModel.api);

      logTiming('after pi-ai model resolution', runStartTime);

      // the agent SDK handles path sandboxing via its own tools
      const imageCapable = true; // pi-ai models generally support images; let the model handle unsupported cases
      const effectiveCwd =
        useSandboxIsolation && sandboxPath ? sandboxPath : workingDir || process.cwd();

      // Use app-specific Claude config directory to avoid conflicts with user settings
      // SDK uses CLAUDE_CONFIG_DIR to locate skills
      const userAgentDir = this.getAppAgentDir();

      // Skills directory setup: only run on the first query per runner instance.
      // Symlinks and directories are stable across queries; re-running every time
      // wastes ~10-30 syscalls per query for no benefit. Call invalidateSkillsSetup()
      // to force a re-run after the user installs or removes a skill.
      if (!this._skillsSetupDone) {
        // Set flag at start to prevent re-entrant calls from concurrent queries
        this._skillsSetupDone = true;
        setupSkillsDirectories({
          appAgentDir: userAgentDir,
          runtimeSkillsDir: this.getRuntimeSkillsDir(),
          builtinSkillsPath: this.getBuiltinSkillsPath(),
          copyDirectorySync: (source, target) => this.copyDirectorySync(source, target),
          syncUserSkillsToAppDir: (appSkillsDir) => this.syncUserSkillsToAppDir(appSkillsDir),
          syncConfiguredSkillsToRuntimeDir: (runtimeSkillsDir) =>
            this.syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir),
        });
      }

      // Build available skills section dynamically — now handled by pi's DefaultResourceLoader
      // via additionalSkillPaths. No custom prompt building needed.

      log('[CoworkAgentRunner] App agent dir:', userAgentDir);
      log('[CoworkAgentRunner] User working directory:', workingDir);

      logTiming('before building conversation context', runStartTime);

      // pi-ai handles auth and model routing natively — no proxy, no env overrides needed.
      logCtx('[CoworkAgentRunner] Using pi-ai native routing for:', piModel.provider, piModel.id);

      // Resolve thinking level early — needed for session reuse check below
      const enableThinking = configStore.get('enableThinking') ?? false;
      logCtx('[CoworkAgentRunner] Enable thinking mode:', enableThinking);
      type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
      const thinkingLevel: PiThinkingLevel = enableThinking ? 'medium' : 'off';
      const sessionRuntimeSignature = buildPiSessionRuntimeSignature({
        configProvider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
        modelProvider: piModel.provider,
        modelApi: piModel.api,
        modelBaseUrl: piModel.baseUrl,
        effectiveCwd,
        apiKey,
      });
      const skillPaths = await this.resolveSkillPaths(session.id);
      const skillsSignature = JSON.stringify(skillPaths);
      log('[CoworkAgentRunner] Skill paths for pi ResourceLoader:', skillPaths);

      // Build contextual prompt — if reusing an existing SDK session, the SDK
      // already has conversation history so we only pass the new prompt.
      // For cold starts (new SDK session with existing DB history), we inject
      // a token-budgeted summary of recent history as a preamble.
      let cachedSession = this.piSessions.get(session.id);
      if (cachedSession) {
        // Runtime wiring and skill paths are creation-time state too; the
        // lifecycle module owns the check order and the per-reason log wording.
        const recreateReason = resolvePiSessionRecreateReason(cachedSession, {
          runtimeSignature: sessionRuntimeSignature,
          skillsSignature,
        });
        if (recreateReason) {
          evictCachedPiSession(this.piSessions, session.id, recreateReason);
          cachedSession = undefined;
        }
      }

      const extensionResult = this.extensionManager
        ? await this.extensionManager.beforeSessionRun({
            session,
            prompt,
            existingMessages,
            isColdStart: !cachedSession,
          })
        : {
            promptPrefix: undefined,
            customTools: [],
            memoryEnabled: false,
            refreshSession: false,
            systemContext: undefined,
          };
      const memoryEnabled = extensionResult.memoryEnabled === true;
      // SDK tools/system prompt are creation-time state. Rebuild before history
      // reconstruction, including the first disabled turn after an enabled run.
      if (cachedSession && hasSessionContextChanged(cachedSession, extensionResult)) {
        evictCachedPiSession(this.piSessions, session.id, 'context');
        cachedSession = undefined;
      }

      const contextualPrompt = await assembleContextualPrompt({
        prompt,
        existingMessages,
        contextWindow: piModel.contextWindow || 128000,
        provider,
        sessionId: session.id,
        isColdStart: !cachedSession,
        extensionPromptPrefix: extensionResult.promptPrefix,
        openjev: runtimeConfig.openjev,
      });

      logTiming('before building MCP servers config', runStartTime);

      // Build MCP servers configuration for SDK
      // IMPORTANT: SDK uses tool names in format: mcp__<ServerKey>__<toolName>
      const mcpConfigResult = buildMcpServersConfig({
        deps: {
          mcpManager: this.mcpManager,
          configStore: mcpConfigStore,
          getBundledNodePaths,
        },
        imageCapable,
        cache: this._mcpServersCache,
      });
      this._mcpServersCache = mcpConfigResult.cache;

      logTiming('after building MCP servers config', runStartTime);

      const coworkAppendPrompt = buildCoworkAppendPrompt({
        config: {
          modelId: piModel.id,
          provider,
          contextWindow: piModel.contextWindow,
          maxTokens: piModel.maxTokens,
          thinkingEnabled: enableThinking,
          sandboxEnabled: runtimeConfig.sandboxEnabled,
          memoryEnabled: runtimeConfig.memoryEnabled,
        },
        workspace: {
          sandboxIsolated: useSandboxIsolation,
          sandboxPath,
          workingDir,
          virtualWorkspacePath: VIRTUAL_WORKSPACE_PATH,
        },
        coworkInstructions: runtimeConfig.coworkInstructions,
        elitePrompt: EliteCodingIntelligence.getElitePrompt(),
        strategicPrompt: AdaptiveStrategyEngine.getStrategicPrompt(),
        bundledPathHints: this.getBundledPathHints(),
        extensionSystemContext: extensionResult.systemContext,
        projectSystemPromptBlock: projectContext.systemPromptBlock,
        userPreferences: memoryEnabled
          ? this.memoryManager?.formatUserPreferencesForContext() || ''
          : '',
        errorPatterns: memoryEnabled
          ? this.memoryManager?.formatErrorPatternsForContext(prompt) || ''
          : '',
        projectResumption: memoryEnabled
          ? this.memoryManager?.formatProjectResumptionContext(session.id) || ''
          : '',
      });

      logTiming('before agent session creation', runStartTime);

      // Create or reuse agent session
      // Bridge MCP tools and the agent meta-tools (skill proposals, eval
      // harness, AST helpers…) into the agent SDK. No dynamic tool loading:
      // the registry that evaluated agent-written code was removed.
      const { customTools, wrappedTools } = await buildPiSessionTools({
        mcpManager: this.mcpManager,
        sessionId: session.id,
        cwd: effectiveCwd,
        extensionCustomTools: extensionResult.customTools || [],
        tavilyApiKey: runtimeConfig.tavilyApiKey || process.env.TAVILY_API_KEY || '',
        braveApiKey: runtimeConfig.braveApiKey || process.env.BRAVE_API_KEY || '',
        requestSudoPassword: this.requestSudoPassword,
        enrichProcessPath: enrichProcessPathForBuild,
      });

      // Diagnostic: log tools being passed to SDK (helps debug Ollama tool use)
      logCtx(`[CoworkAgentRunner] Session reuse check: cached=${!!cachedSession}`);
      logCtx(`[CoworkAgentRunner] Model=${piModel.id}, thinkingLevel=${thinkingLevel}`);
      log(
        `[CoworkAgentRunner] Built-in tools (${wrappedTools.length}): ${wrappedTools.map((t: { name?: string; type?: string }) => t.name || t.type).join(', ')}`
      );
      log(
        `[CoworkAgentRunner] Custom tools (${customTools.length}): ${customTools.map((t) => t.name).join(', ')}`
      );

      let piSession: PiAgentSession;
      if (cachedSession) {
        piSession = await reusePiSession({
          cachedSession,
          sessionId: session.id,
          piModel,
          thinkingLevel,
          runStartTime,
        });
      } else {
        piSession = await createPiSession({
          session,
          piModel,
          thinkingLevel,
          authStorage,
          cwd: effectiveCwd,
          skillPaths,
          coworkAppendPrompt,
          provider,
          customProtocol: runtimeConfig.customProtocol,
          effectiveBaseUrl,
          tools: wrappedTools,
          customTools,
          runtimeSignature: sessionRuntimeSignature,
          skillsSignature,
          sessionContextSignature: extensionResult.sessionContextSignature,
          sessions: this.piSessions,
          maxCachedSessions: CoworkAgentRunner.MAX_CACHED_SESSIONS,
          installPermissionHook: (target) => this.installPermissionHook(target, session.id),
          installModsHooks: (target) => this.installModsHooks(target, session.id),
          installPayloadHook: (target, options) =>
            this.installPayloadHook(target, session.id, options),
        });
        logTiming('agent session created', runStartTime);
      }

      // Set up event handler to bridge agent SDK events → our ServerEvent protocol

      // Accumulate streamed text deltas in case message_end.content is empty (pi SDK streaming behaviour)
      let streamedText = '';
      let compactionStepId: string | undefined;
      let hasEmittedError = false;
      // Two-stage pipeline buffers: when armed, the draft's terminal text-only
      // message is withheld here instead of being presented as the answer.
      let pipelineDraftMessage: Message | undefined;
      let pipelineDraftText = '';
      const promptStartedAt = Date.now();

      // ── Loop guard: protect against runaway tool-call loops ──
      // (e.g. gemini-3.1-pro with thinking=off has been observed producing hundreds
      //  of empty-text + single-tool-call responses in a single turn)
      const { loopGuard, handleDecision: handleLoopGuardDecision } = createLoopGuardController({
        piSession,
        isAborted: () => controller.signal.aborted,
        emitAbort: (decision) => {
          // Always surface the loop-guard explanation, even if an earlier error
          // already set hasEmittedError — the user must see why the session
          // stopped. Mark the flag afterward to suppress duplicate generic-error
          // chatter from later paths in this turn.
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: buildAbortUserMessage(decision) }],
            timestamp: Date.now(),
          });
          hasEmittedError = true;
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'error',
            title: 'Stopped: tool-call loop detected',
          });
        },
        markAbortedByLoopGuard: () => {
          abortedByLoopGuard = true;
        },
        abort: () => controller.abort(),
      });

      // Stream liveness: warn on a slow Ollama cold start, cancel that warning on
      // the first event, abort after the inactivity window and count event
      // types for diagnostics. The policy lives in stream-liveness; the effects
      // (trace updates, abort, logging) stay here.
      // The two windows are configurable and deliberately different: the
      // inactivity window governs waiting on the model, while the much longer
      // ceiling governs a tool that is actually running (and therefore silent).
      const streamTimeout = {
        activityTimeoutMs: runtimeConfig.streamTimeout?.activityTimeoutMs ?? 5 * 60 * 1000,
        toolExecutionCeilingMs:
          runtimeConfig.streamTimeout?.toolExecutionCeilingMs ?? 15 * 60 * 1000,
      };
      const streamLiveness = createStreamLivenessWatcher({
        provider,
        promptStartedAt,
        isAborted: () => controller.signal.aborted,
        onColdStartWaiting: () => {
          this.sendTraceUpdate(session.id, thinkingStepId, {
            title: 'Waiting for model to load into memory...',
          });
        },
        onFirstStreamEvent: ({ eventType, latencyMs }) => {
          this.sendTraceUpdate(session.id, thinkingStepId, {
            title: 'Processing request...',
          });
          if (provider === 'ollama') {
            log(
              '[CoworkAgentRunner] Ollama first stream event received',
              safeStringify({
                sessionId: session.id,
                eventType,
                modelId: piModel.id,
                modelProvider: piModel.provider,
                baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
                latencyMs,
              })
            );
          }
        },
        onActivityTimeout: () => {
          logWarn(
            `[CoworkAgentRunner] Prompt timed out (no activity for ${Math.round(
              streamTimeout.activityTimeoutMs / 1000
            )}s), aborting`
          );
          abortedByTimeout = true;
          controller.abort();
        },
        activityTimeoutMs: streamTimeout.activityTimeoutMs,
        toolExecutionCeilingMs: streamTimeout.toolExecutionCeilingMs,
        onToolExecutionTimeout: (toolLabel) => {
          logWarn(
            `[CoworkAgentRunner] Tool "${toolLabel}" exceeded the ` +
              `${Math.round(streamTimeout.toolExecutionCeilingMs / 1000)}s ceiling, aborting`
          );
          abortedByTimeout = true;
          controller.abort();
        },
      });

      const emitTerminalError = (errorText: string, options: { abort?: boolean } = {}): void => {
        terminalErrorText = errorText;

        // Causal memory: record the terminal failure pattern so future
        // sessions with a matching problem receive it as known-error context.
        try {
          const normalized = errorText.replace(/\s+/g, ' ').trim().slice(0, 300);
          if (normalized.length >= 8) {
            this.memoryManager?.recordErrorPattern(
              normalized,
              'session-terminal-error',
              '',
              session.id
            );
          }
        } catch (memoryErr) {
          // Memory must never break the run
          logWarn('[CoworkAgentRunner] Failed to record error pattern:', memoryErr);
        }

        const emission = buildTerminalErrorEmissionDetails({
          errorText,
          streamedText,
        });

        const partialText = emission.partialText ? sanitizeOutputPaths(emission.partialText) : '';
        const messageText = buildTerminalErrorMessage(errorText, partialText);
        streamedText = '';
        this.sendToRenderer({
          type: 'stream.partial',
          payload: { sessionId: session.id, delta: '' },
        });

        if (!hasEmittedError) {
          hasEmittedError = true;
          // A rate limit / gateway failure with no tool side effect may still be
          // replayed on another provider by the session manager. Persisting the
          // error now would leave a stale 429 banner in the transcript next to
          // the answer the retry produces, so the message is held back and
          // flushed only when the turn ends without a retry.
          pendingTerminalError = {
            messageText,
            errorCode: classifyTerminalError(errorText),
          };
        }

        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'error',
          title: 'Request failed',
        });

        if (options.abort && !controller.signal.aborted) {
          try {
            // Mark BEFORE calling abort() so AbortError handling preserves the
            // 'Request failed' state instead of treating this as a user cancel.
            abortedByStreamError = true;
            controller.abort();
          } catch (abortErr) {
            logWarn('[CoworkAgentRunner] stream-error abort failed:', abortErr);
          }
        }
      };

      const sessionEventLoggingDeps: SessionEventLoggingDeps = {
        telemetry: streamLiveness,
        stringify: safeStringify,
        summarizeMessage: summarizeMessageForLog,
      };

      const piSessionEventState: PiSessionEventState = {
        getStreamedText: () => streamedText,
        setStreamedText: (text) => {
          streamedText = text;
        },
        isTwoStageArmed: () => twoStageArmed,
        stashPipelineDraft: (message, text) => {
          pipelineDraftMessage = message;
          pipelineDraftText = text;
        },
        getCompactionStepId: () => compactionStepId,
        setCompactionStepId: (id) => {
          compactionStepId = id;
        },
      };

      const piSessionEventContext: PiSessionEventContext = {
        sessionId: session.id,
        provider,
        model: { id: piModel.id, provider: piModel.provider, api: piModel.api },
        usedSyntheticModel,
        isAborted: () => controller.signal.aborted,
        telemetry: streamLiveness,
        loopGuard,
        handleLoopGuardDecision,
        state: piSessionEventState,
        sendPartial: (delta) => this.sendPartial(session.id, delta),
        sendToRenderer: (rendererEvent) => this.sendToRenderer(rendererEvent),
        sendTraceStep: (step) => this.sendTraceStep(session.id, step),
        sendTraceUpdate: (stepId, updates) => this.sendTraceUpdate(session.id, stepId, updates),
        sendMessage: (message) => this.sendMessage(session.id, message),
        getToolDisplayName: (toolName) => this.getToolDisplayName(toolName),
        emitTerminalError,
        sanitizeOutputPaths: (content) => sanitizeOutputPaths(content),
        toolActivity,
        onToolExecutionStart: bumpToolCount,
        reportProtocolLeak: (detail) => {
          logCtxWarn(
            `[CoworkAgentRunner] Raw agent-protocol markup leaked as text (${detail.fragmentCount} fragment(s)) — renderer quarantines display, cold-start strips replay. Sample:`,
            detail.sample
          );
          try {
            this.memoryManager?.recordErrorPattern(
              'model leaked raw tool-calling protocol markup (<tool_use>/<turn>) as plain text instead of structured tool calls',
              'The model degraded after an upstream failure and imitated the conversation transcript format. Display is quarantined automatically; if this recurs, recreate the session or switch model/protocol.',
              'Avoid re-sending the leaked markup to the model; rely on native tool_calls only.',
              session.id
            );
          } catch (memoryErr) {
            logWarn('[CoworkAgentRunner] Failed to record protocol-leak pattern:', memoryErr);
          }
        },
      };

      const unsubscribe = piSession.subscribe((event) => {
        try {
          if (controller.signal.aborted) return;

          // Reset activity timeout on meaningful events
          streamLiveness.resetActivityTimeout();

          logSessionStreamEvent(event, sessionEventLoggingDeps);

          handlePiSessionEvent(event, piSessionEventContext);
        } catch (subscribeErr) {
          logError('[CoworkAgentRunner] Error in subscribe callback:', subscribeErr);
          if (compactionStepId) {
            this.sendTraceUpdate(session.id, compactionStepId, {
              status: 'error',
              title: 'Error during context compaction',
            });
            compactionStepId = undefined;
          }
          if (!hasEmittedError) {
            hasEmittedError = true;
            const errorText = toUserFacingErrorText(toErrorText(subscribeErr));
            this.sendMessage(session.id, {
              id: uuidv4(),
              sessionId: session.id,
              role: 'assistant',
              content: [{ type: 'text', text: `**Error**: ${errorText}` }],
              timestamp: Date.now(),
            });
          }
        }
      });

      // Execute the prompt — unsubscribe in finally to prevent event listener leak
      try {
        streamLiveness.resetActivityTimeout();
        if (provider === 'ollama') {
          log(
            '[CoworkAgentRunner] Starting Ollama prompt',
            safeStringify({
              sessionId: session.id,
              modelId: piModel.id,
              modelProvider: piModel.provider,
              baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
              usedSyntheticModel,
              hasExplicitApiKey: Boolean(apiKey),
              thinkingLevel,
            })
          );
        }
        const promptResult = await piSession.prompt(contextualPrompt);
        log(
          '[CoworkAgentRunner] prompt() returned:',
          JSON.stringify(promptResult ?? 'void').substring(0, 1000)
        );
      } finally {
        try {
          unsubscribe();
        } catch (e) {
          logWarn('[CoworkAgentRunner] unsubscribe error:', e);
        }
        streamLiveness.dispose();
      }

      logTiming('agent prompt completed', runStartTime);

      // If the SDK swallowed the AbortError and returned void, detect timeout here
      if (controller.signal.aborted && abortedByTimeout) {
        logCtx('[CoworkAgentRunner] Aborted due to timeout (detected after prompt returned)');
        const errorMsg: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: TIMEOUT_ERROR_MESSAGE_TEXT,
            },
          ],
          timestamp: Date.now(),
          isError: true,
          errorCode: 'timeout',
        };
        this.sendMessage(session.id, errorMsg);
        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'error',
          title: 'Request timed out',
        });
        return this.buildRunResult({
          errorCode: 'timeout',
          terminalErrorText,
          startedToolExecutions,
          aborted: true,
          flushError: flushPendingTerminalError,
        });
      }
      // If the SDK swallowed the AbortError after a loop-guard abort, preserve
      // the 'error' trace status that handleLoopGuardDecision already published.
      // The user-facing message and trace step are already set; do not overwrite
      // them with the default "Task completed" below.
      const abortDisposition = resolveAbortDisposition({
        abortedByTimeout,
        abortedByLoopGuard,
        abortedByStreamError,
      });
      if (controller.signal.aborted && shouldPreserveExistingTrace(abortDisposition)) {
        logCtx(
          `[CoworkAgentRunner] Aborted by ${abortDisposition === 'loop_guard' ? 'loop guard' : 'stream error'} (detected after prompt returned)`
        );
        return this.buildRunResult({
          errorCode: classifyTerminalError(terminalErrorText ?? 'stream_error'),
          terminalErrorText,
          startedToolExecutions,
          aborted: true,
          flushError: flushPendingTerminalError,
        });
      }

      // ── Two-stage pipeline finalization ───────────────────────────────
      // The draft pass is complete and did not error: decide whether the
      // refine pass earns its cost, then present the finalized answer. A
      // refine failure releases the draft — one fallback attempt, never a
      // silent block (same contract as sub-agent fallback).
      if (twoStageArmed && pipelineDraftMessage && !terminalErrorText) {
        const draftMessage = pipelineDraftMessage;
        const draftLabel = `${piModel.provider}/${piModel.id}`;
        const refineLabel = pipelineRefineConfig
          ? `${pipelineRefineConfig.provider}/${pipelineRefineConfig.model}`
          : 'active profile';
        const decision = decideTwoStage({
          mode: projectContext.pipelineMode,
          userRequest: prompt,
          hasRefineModel: Boolean(pipelineRefineConfig),
          draftText: pipelineDraftText,
        });

        // The draft is never lost: it lands in the session log (persisted with
        // the trace steps) with the model that produced it.
        this.sendTraceStep(session.id, {
          id: `pipeline-draft-${Date.now()}`,
          type: 'thinking',
          status: 'completed',
          title: `Brouillon (étape 1/2) · ${draftLabel}`,
          content: pipelineDraftText,
          timestamp: Date.now(),
        });

        const refineStepId = `pipeline-refine-${Date.now()}`;
        this.sendTraceStep(session.id, {
          id: refineStepId,
          type: 'thinking',
          status: decision.run ? 'running' : 'completed',
          title: decision.run
            ? `Relecture et finition (étape 2/2) · ${refineLabel}`
            : `Relecture ignorée · ${decision.reason}`,
          timestamp: Date.now(),
        });

        let pipelineResult: TwoStageResult = {
          finalText: pipelineDraftText,
          usedFallback: false,
        };
        if (decision.run && pipelineRefineConfig) {
          const refineConfig = pipelineRefineConfig;
          pipelineResult = await runTwoStagePipeline({
            decision,
            userRequest: prompt,
            draftText: pipelineDraftText,
            refine: async ({ systemPrompt, prompt: refinePrompt }) => {
              const oneShot = await runPiAiOneShot(refinePrompt, systemPrompt, refineConfig, {
                signal: controller.signal,
              });
              return { text: oneShot.text, usage: oneShot.usage };
            },
          });
        }

        if (pipelineResult.usedFallback) {
          // Refine failed: release the draft unchanged and say so out loud.
          logWarn(
            '[CoworkAgentRunner] Two-stage refine failed, releasing draft:',
            pipelineResult.refineError
          );
          this.sendTraceUpdate(session.id, refineStepId, {
            status: 'error',
            title: `Relecture échouée — brouillon conservé · ${pipelineResult.refineError ?? 'unknown error'}`,
          });
          this.sendMessage(session.id, { ...draftMessage, id: uuidv4(), timestamp: Date.now() });
        } else if (decision.run) {
          // Refined answer: the draft moves into a collapsible detail block so
          // it stays reachable without ever being presented as the answer.
          this.sendTraceUpdate(session.id, refineStepId, {
            status: 'completed',
            title: `Version finalisée (étape 2/2) · ${refineLabel}`,
            content: pipelineResult.finalText,
          });
          const finalContent: ContentBlock[] = [
            ...draftMessage.content.filter((block) => block.type === 'thinking'),
            {
              type: 'thinking',
              thinking: buildDraftDetailText({
                draftText: pipelineDraftText,
                draftLabel,
                refineLabel,
              }),
            },
            { type: 'text', text: sanitizeOutputPaths(pipelineResult.finalText) },
          ];
          this.sendMessage(session.id, {
            ...draftMessage,
            id: uuidv4(),
            content: finalContent,
            // Cost transparency: the finalized message reports BOTH passes.
            tokenUsage: mergeTokenUsage(draftMessage.tokenUsage, pipelineResult.usage),
            timestamp: Date.now(),
          });
        } else {
          // Not worth a second pass (trivial request / short draft): the draft
          // IS the answer, presented exactly like single-model mode.
          this.sendMessage(session.id, { ...draftMessage, id: uuidv4(), timestamp: Date.now() });
        }
      }

      // Complete - update the initial thinking step
      this.sendTraceUpdate(session.id, thinkingStepId, {
        status: terminalErrorText ? 'error' : 'completed',
        title: terminalErrorText ? 'Request failed' : 'Task completed',
      });

      // Closed Learning Loop (Hermes-inspired):
      // On successful task completion, trigger autonomous skill evaluation in background.
      if (!terminalErrorText && !controller.signal.aborted) {
        const globalSkillsDir = this.getConfiguredGlobalSkillsDir();
        const rawDb = (this.memoryManager as unknown as { db?: import('better-sqlite3').Database })
          ?.db;
        if (!this.skillSynthesizer) {
          this.skillSynthesizer = new SkillSynthesizer(globalSkillsDir, rawDb);
        } else {
          this.skillSynthesizer.setBaseSkillsDir(globalSkillsDir);
          if (rawDb) this.skillSynthesizer.setDatabase(rawDb);
        }
        // Non-blocking background evaluation
        this.skillSynthesizer
          .evaluateAndSynthesize(prompt, existingMessages, false)
          .then((res) => {
            if (res?.created) {
              this.invalidateSkillsSetup();
              this.sendTraceStep(session.id, {
                id: uuidv4(),
                type: 'thinking',
                status: 'completed',
                title: `✨ Proposed new skill: ${res.name} (v${res.version || 1}) — pending your approval in Skill doctor`,
                timestamp: Date.now(),
              });
            }
          })
          .catch((err) => {
            logWarn('[CoworkAgentRunner] Background skill synthesis error:', err);
          });

        // Active Dialectic Learning (Hermes / Honcho inspired):
        // Automatically extract habits, preferences, and style conventions from the turn.
        // Only when memory is enabled at global AND session level — mirrors MemoryExtension gates.
        if (
          this.memoryManager &&
          memoryEnabled &&
          configStore.get('memoryEnabled') !== false &&
          session.memoryEnabled
        ) {
          const learner = new ActivePreferenceLearner(this.memoryManager);
          learner
            .extractAndRecord(
              existingMessages,
              () => configStore.get('memoryEnabled') !== false && session.memoryEnabled
            )
            .then((count) => {
              if (count > 0) {
                this.sendTraceStep(session.id, {
                  id: uuidv4(),
                  type: 'thinking',
                  status: 'completed',
                  title: `🧠 Memorized ${count} user preference(s)`,
                  timestamp: Date.now(),
                });
              }
            })
            .catch((err) => {
              logWarn('[CoworkAgentRunner] Background preference learning error:', err);
            });

          // Long-term project context: update the LLM summary after each turn (background)
          this.memoryManager
            .autoUpdateProjectContextAsync(session.id, existingMessages, session.cwd || '')
            .catch((err) => {
              logWarn('[CoworkAgentRunner] Background project context update error:', err);
            });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const abortDisposition = resolveAbortDisposition({
          abortedByTimeout,
          abortedByLoopGuard,
          abortedByStreamError,
        });
        if (abortDisposition === 'timeout') {
          logCtx('[CoworkAgentRunner] Aborted due to timeout');
          const errorMsg: Message = {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: TIMEOUT_ERROR_MESSAGE_TEXT,
              },
            ],
            timestamp: Date.now(),
            isError: true,
            errorCode: 'timeout',
          };
          this.sendMessage(session.id, errorMsg);
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'error',
            title: 'Request timed out',
          });
        } else if (abortDisposition === 'loop_guard') {
          // Loop guard already published the user-facing assistant message and
          // an 'error' trace step with the loop-detected title. Do NOT overwrite
          // them here with a 'completed/Cancelled' state.
          logCtx('[CoworkAgentRunner] Aborted by loop guard');
        } else if (abortDisposition === 'stream_error') {
          // Stream-error handling already published the user-facing assistant
          // message and the 'Request failed' trace state. Preserve them.
          logCtx('[CoworkAgentRunner] Aborted by stream error');
          // Invalidate the cached SDK session so the next retry does a clean
          // cold start. Reusing a session whose AbortController is already
          // triggered causes the upstream to reject the next request with 400.
          evictCachedPiSession(this.piSessions, session.id, 'stream-error');
        } else {
          logCtx('[CoworkAgentRunner] Aborted by user');
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'completed',
            title: 'Cancelled',
          });
        }
        // A turn the user cancelled, that timed out, or that the loop guard
        // stopped is never replayed. A stream error is different: the abort
        // there is the runner's own doing *because* the provider failed (see
        // emitTerminalError with {abort: true}), so a 429 surfaced that way —
        // terminalErrorText set, no tools run — stays retryable.
        const userStop = abortDisposition === 'user' || abortDisposition === 'timeout';
        runResult = this.buildRunResult({
          errorCode:
            terminalErrorText && !userStop
              ? classifyTerminalError(terminalErrorText)
              : abortDisposition === 'timeout'
                ? 'timeout'
                : undefined,
          terminalErrorText,
          startedToolExecutions,
          aborted: userStop,
          flushError: flushPendingTerminalError,
        });
      } else {
        logCtxError('[CoworkAgentRunner] Error:', error);

        // Hold back when this failure could be replayed on another provider —
        // the caller flushes it if no retry happens. Publish immediately only
        // for errors that can never be retried (auth, bad request, turns that
        // already ran tools), so behaviour for those paths is unchanged.
        const thrownText = toErrorText(error);
        const thrownCode = classifyTerminalError(thrownText);
        const retryableThrown = shouldFallbackToProvider({
          errorCode: thrownCode,
          toolExecutions: startedToolExecutions,
          aborted: controller.signal.aborted,
        });
        if (retryableThrown) {
          pendingTerminalError = {
            messageText: `**Error**: ${toUserFacingErrorText(thrownText)}`,
            errorCode: thrownCode,
          };
        } else {
          const errorText = toUserFacingErrorText(thrownText);
          const errorMsg: Message = {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: `**Error**: ${errorText}` }],
            timestamp: Date.now(),
          };
          this.sendMessage(session.id, errorMsg);
        }

        this.sendTraceStep(session.id, {
          id: uuidv4(),
          type: 'thinking',
          status: 'error',
          title: 'Error occurred',
          timestamp: Date.now(),
        });

        // Mark so session-manager doesn't report again
        if (error instanceof Error) {
          (error as Error & { alreadyReportedToUser?: boolean }).alreadyReportedToUser = true;
        }
        // An exception that escapes the try is a terminal failure of the
        // attempt. Classify the raw text so the caller can still retry a
        // rate limit that surfaced as a thrown provider error.
        runResult = this.buildRunResult({
          errorCode: thrownCode,
          terminalErrorText: thrownText,
          startedToolExecutions,
          aborted: controller.signal.aborted,
          flushError: flushPendingTerminalError,
        });
      }
    } finally {
      // Close activities the provider never completed (abort, stream error,
      // crash) so the control center never shows a stuck "running" tool.
      toolActivity?.cancelRunning('The run ended before this tool call completed.');

      // Phase 7: record local evidence for this run so routing gets better with
      // use. Telemetry never breaks the loop, so failures are logged and dropped.
      if (usedModelString) {
        try {
          this.benchmarkRecorder?.({
            modelId: usedModelString,
            prompt,
            success:
              !controller.signal.aborted &&
              !terminalErrorText &&
              !abortedByTimeout &&
              !abortedByLoopGuard &&
              !abortedByStreamError,
            latencyMs: Date.now() - runStartTime,
          });
        } catch (benchmarkError) {
          logWarn('[CoworkAgentRunner] Benchmark recording failed:', benchmarkError);
        }
      }

      this.activeControllers.delete(session.id);
      // Guarded for the same reason as unregisterRunSignal: if the next turn
      // already started, its run id must survive this turn's late cleanup.
      if (this.activeRunIds.get(session.id) === runId) {
        this.activeRunIds.delete(session.id);
      }
      unregisterRunSignal(session.id, controller.signal);
      this.pathResolver.unregisterSession(session.id);

      // If a terminal error was emitted (400, timeout, stream error) AND the SDK
      // session wasn't already evicted in the catch block above, evict it now.
      // A session that has seen a fatal error may have an inconsistent internal
      // state (message history partially written, abort signal fired, etc.).
      // Forcing a cold start on the next retry is safer than reusing it.
      if (terminalErrorText) {
        evictCachedPiSession(this.piSessions, session.id, 'terminal-error');
      }

      // Sync changes from sandbox back to the host OS (but don't cleanup - the
      // sandbox persists). The orchestration lives in
      // agent-runner-sandbox-session so it is unit-testable without a VM; only the
      // platform lookup and the user-facing wording stay here.
      await syncSandboxChangesToHost({
        sessionId: session.id,
        useSandboxIsolation,
        sandboxPath,
        getPlatform: () => {
          const adapter = getSandboxAdapter();
          return { isWsl: adapter.isWSL, isLima: adapter.isLima };
        },
        onWarning: (text) =>
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: `**Warning**: ${text}` }],
            timestamp: Date.now(),
          }),
      });
    }

    // A turn that fell through the try without an early return still needs its
    // result: either a clean completion or the terminal error that was emitted
    // above. The catch block sets it when an exception escapes.
    return (
      runResult ??
      this.buildRunResult({
        errorCode: terminalErrorText
          ? classifyTerminalError(terminalErrorText)
          : undefined,
        terminalErrorText,
        startedToolExecutions,
        aborted: controller.signal.aborted,
        flushError: flushPendingTerminalError,
      })
    );
  }

  /**
   * Assemble the outcome of one run attempt. Kept in one place so `run()` and
   * its early returns can never disagree about what counts as retryable — the
   * decision is delegated to the shared fallback policy rather than recomputed.
   */
  private buildRunResult(input: {
    errorCode?: TerminalErrorCode;
    terminalErrorText?: string;
    startedToolExecutions: number;
    aborted: boolean;
    flushError: () => void;
  }): AgentRunResult {
    const ok = !input.errorCode;
    return {
      ok,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.terminalErrorText ? { errorText: input.terminalErrorText } : {}),
      retryable: input.errorCode
        ? shouldFallbackToProvider({
            errorCode: input.errorCode,
            toolExecutions: input.startedToolExecutions,
            aborted: input.aborted,
          })
        : false,
      toolExecutions: input.startedToolExecutions,
      flushError: input.flushError,
    };
  }

  /**
   * Manually trigger context compaction for a session.
   * Delegates to the SDK's AgentSession.compact() method.
   *
   * @returns CompactionResult if successful, null if no session cached
   */
  async compact(
    sessionId: string,
    customInstructions?: string
  ): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  } | null> {
    const cached = this.piSessions.get(sessionId);
    if (!cached) {
      logWarn('[CoworkAgentRunner] No cached pi session for compact:', sessionId);
      return null;
    }
    log('[CoworkAgentRunner] Manual compact triggered for session:', sessionId);
    try {
      const result = await cached.session.compact(customInstructions);
      log(
        '[CoworkAgentRunner] Manual compact completed:',
        JSON.stringify({
          summaryLen: result.summary.length,
          tokensBefore: result.tokensBefore,
        })
      );
      const compactionDetails = result.details as
        | { readFiles?: string[]; modifiedFiles?: string[] }
        | undefined;
      this.sendToRenderer({
        type: 'compaction.result',
        payload: {
          sessionId,
          summary: result.summary,
          tokensBefore: result.tokensBefore,
          isManual: true,
          readFiles: compactionDetails?.readFiles || [],
          modifiedFiles: compactionDetails?.modifiedFiles || [],
        },
      });
      return result;
    } catch (err) {
      logError('[CoworkAgentRunner] compact error:', err);
      return null;
    }
  }

  /**
   * Get current context usage for a session.
   * Delegates to the SDK's AgentSession.getContextUsage() method.
   *
   * @returns ContextUsage { tokens, contextWindow, percent } or null
   */
  getContextUsage(
    sessionId: string
  ): { tokens: number | null; contextWindow: number; percent: number | null } | null {
    const cached = this.piSessions.get(sessionId);
    if (!cached) {
      return null;
    }
    try {
      const usage = cached.session.getContextUsage();
      log('[CoworkAgentRunner] getContextUsage:', sessionId, JSON.stringify(usage));
      return usage ?? null;
    } catch (err) {
      logError('[CoworkAgentRunner] getContextUsage error:', err);
      return null;
    }
  }

  cancel(sessionId: string): void {
    const controller = this.activeControllers.get(sessionId);
    if (controller) controller.abort();
  }

  private sendTraceStep(sessionId: string, step: TraceStep): void {
    log(`[Trace] ${step.type}: ${step.title}`);
    // Stamped here rather than at each call site: a step emitted by the event
    // handler deep in the SDK adapter must land with the same run id as one
    // emitted directly by this runner.
    const runId = this.activeRunIds.get(sessionId);
    const stamped = runId && !step.runId ? { ...step, runId } : step;
    this.sendToRenderer({ type: 'trace.step', payload: { sessionId, step: stamped } });
  }

  private sendTraceUpdate(sessionId: string, stepId: string, updates: Partial<TraceStep>): void {
    log(`[Trace] Update step ${stepId}:`, updates);
    this.sendToRenderer({ type: 'trace.update', payload: { sessionId, stepId, updates } });
  }

  private sendMessage(sessionId: string, message: Message): void {
    // Save message to database for persistence
    if (this.saveMessage) {
      this.saveMessage(message);
    }
    // Send to renderer for UI update
    this.sendToRenderer({ type: 'stream.message', payload: { sessionId, message } });
  }

  private sendPartial(sessionId: string, delta: string): void {
    this.sendToRenderer({ type: 'stream.partial', payload: { sessionId, delta } });
  }
}
