/**
 * @module main/agent/swarm-runner
 *
 * Real executor for the multi-agent swarm: each DAG task runs in its own
 * pi-coding-agent session, confined to the session workspace.
 *
 * - Profile resolution: per-role override > sub-agents configSet > inherited
 *   active profile (default — zero surprise).
 * - Guardrails: per-task timeout, bounded concurrency, and a path-confinement
 *   hook that blocks any tool call whose target escapes the workspace.
 * - bash is deliberately NOT provided to sub-agents: a free-form shell
 *   cannot be reliably confined without an OS sandbox.
 * - Fallback: exactly one retry with the active profile when the configured
 *   sub-agent model fails (rate limit, timeout, provider error).
 */

import * as fs from 'fs';
// Type-only: erased at compile time; the runtime value is loaded lazily.
import type * as ts from 'typescript';
import * as path from 'path';
import {
  createAgentSession,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { Model, Api } from '@mariozechner/pi-ai';
import type { AgentTool, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { AuthStorage, ModelRegistry } from './shared-auth';
import { normalizeOpenAICompatibleBaseUrl } from '../config/auth-utils';
import {
  configStore,
  normalizeSubAgentsConfig,
  type ApiConfigSet,
  type AppConfig,
  type SubAgentRoleKey,
  type SubAgentsConfig,
} from '../config/config-store';
import { isPathWithinRoot } from '../tools/path-containment';
import { log, logError, logWarn } from '../utils/logger';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  inferPiApi,
  resolvePiModelString,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from './pi-model-resolution';
import type { AgentTask, SubAgentRunResult, SubAgentRunnerFn } from './multi-agent-coordinator';

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

export type SubAgentProfileSource = 'role' | 'configSet' | 'inherited';

export interface ResolvedSubAgentProfile {
  /** Derived AppConfig the sub-agent session must run with. */
  config: AppConfig;
  source: SubAgentProfileSource;
  /** Human-readable model label used in logs and results. */
  label: string;
}

function profileFromSelection(
  appConfig: AppConfig,
  set: ApiConfigSet,
  modelId: string | undefined,
  source: SubAgentProfileSource
): ResolvedSubAgentProfile {
  const profile = set.profiles[set.activeProfileKey];
  // The selection may pin a specific model inside the set; without one the
  // set's active model is used.
  const effectiveModel = (modelId?.trim() || profile?.model || '').trim();
  const derived: AppConfig = {
    ...appConfig,
    provider: set.provider,
    customProtocol: set.customProtocol,
    apiKey: profile?.apiKey ?? '',
    baseUrl: profile?.baseUrl,
    model: effectiveModel,
    contextWindow: profile?.contextWindow,
    maxTokens: profile?.maxTokens,
  };
  return {
    config: derived,
    source,
    label: `${set.id}/${effectiveModel || set.provider}`,
  };
}

/**
 * Resolve the profile a sub-agent task must run with:
 * per-role override > sub-agents configSet > inherited active profile.
 * Unknown configSet ids degrade to inheritance with a warning.
 */
export function resolveSubAgentProfile(
  role: string,
  appConfig: AppConfig
): ResolvedSubAgentProfile {
  const subAgents = appConfig.subAgents ?? normalizeSubAgentsConfig(undefined);

  const roleSelection = subAgents.perRole[role as SubAgentRoleKey];
  if (roleSelection?.configSetId) {
    const set = appConfig.configSets.find((s) => s.id === roleSelection.configSetId);
    if (set) {
      return profileFromSelection(appConfig, set, roleSelection.modelId, 'role');
    }
    logWarn(`[SwarmRunner] Per-role configSet "${roleSelection.configSetId}" not found; falling back`);
  }

  if (subAgents.configSetId) {
    const set = appConfig.configSets.find((s) => s.id === subAgents.configSetId);
    if (set) {
      return profileFromSelection(appConfig, set, subAgents.modelId, 'configSet');
    }
    logWarn(`[SwarmRunner] Sub-agent configSet "${subAgents.configSetId}" not found; inheriting`);
  }

  // Inherited profile: a global modelId may still pin a different model on it.
  if (subAgents.modelId?.trim()) {
    const modelId = subAgents.modelId.trim();
    return {
      config: { ...appConfig, model: modelId },
      source: 'inherited',
      label: `active/${modelId}`,
    };
  }

  return {
    config: appConfig,
    source: 'inherited',
    label: `active/${appConfig.model || appConfig.provider}`,
  };
}

// ---------------------------------------------------------------------------
// Model resolution (registry lookup + synthetic fallback, sdk-one-shot pattern)
// ---------------------------------------------------------------------------

function resolveSubAgentModel(config: AppConfig): Model<Api> {
  const modelString = resolvePiModelString({
    provider: config.provider,
    customProtocol: config.customProtocol,
    model: config.model,
  });
  const keyProvider = config.customProtocol || config.provider || 'anthropic';
  const routeProtocol = resolvePiRouteProtocol(config.provider, config.customProtocol);
  const rawBaseUrl = config.baseUrl?.trim() || undefined;
  const effectiveBaseUrl =
    routeProtocol === 'openai' && config.provider !== 'ollama'
      ? normalizeOpenAICompatibleBaseUrl(rawBaseUrl) || rawBaseUrl
      : rawBaseUrl;

  const registryModel = resolvePiRegistryModel(modelString, {
    configProvider: keyProvider,
    customBaseUrl: effectiveBaseUrl,
    rawProvider: config.provider || 'anthropic',
    customProtocol: config.customProtocol,
  });
  if (registryModel) {
    return registryModel;
  }

  // Synthetic fallback for custom/relay models absent from the pi-ai registry.
  const synthetic = resolveSyntheticPiModelFallback({
    rawModel: config.model,
    resolvedModelString: modelString,
    rawProvider: config.provider,
    routeProtocol,
    baseUrl: effectiveBaseUrl,
  });
  const api = effectiveBaseUrl ? inferPiApi(routeProtocol) : undefined;
  const syntheticModel = applyPiModelRuntimeOverrides(
    buildSyntheticPiModel(
      synthetic.modelId,
      synthetic.provider,
      routeProtocol,
      effectiveBaseUrl || '',
      api
    ),
    {
      configProvider: keyProvider,
      customBaseUrl: effectiveBaseUrl,
      rawProvider: config.provider || 'anthropic',
      customProtocol: config.customProtocol,
    }
  );
  logWarn('[SwarmRunner] Model not in pi-ai registry, using synthetic:', modelString);
  return syntheticModel;
}

// ---------------------------------------------------------------------------
// Confinement + modified-file collection
// ---------------------------------------------------------------------------

const PATH_TOOL_NAMES = new Set(['read', 'write', 'edit', 'find', 'grep', 'ls']);
const WRITE_TOOL_NAMES = new Set(['write', 'edit']);

interface ToolCallShape {
  toolName: string;
  args: unknown;
}

/**
 * Resolve to the REAL filesystem path, following symlinks for existing
 * entries; for not-yet-existing paths, resolve the nearest existing ancestor
 * so a write through a symlinked directory is still caught. Lexical
 * resolution alone lets a workspace symlink escape the confinement.
 */
export function resolveRealPathWithin(root: string, raw: string): string {
  const abs = path.resolve(root, raw);
  let probe = abs;
  const missing: string[] = [];
  for (;;) {
    try {
      let real = fs.realpathSync(probe);
      // Re-append the not-yet-existing tail so a new file keeps its full path.
      for (const part of missing.reverse()) {
        real = path.join(real, part);
      }
      return real;
    } catch {
      missing.push(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) {
        return abs; // reached the filesystem root: nothing exists to follow
      }
      probe = parent;
    }
  }
}

/** Real (symlink-resolved) workspace root; falls back to the raw path. */
function resolveRealRoot(cwd: string): string {
  try {
    return fs.realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

/** Resolved absolute path when the call targets a file path inside the workspace. */
export function extractConfinedToolPath(
  root: string,
  toolName: string,
  args: unknown
): { resolved: string; raw: string } | null {
  if (!PATH_TOOL_NAMES.has(toolName)) {
    return null;
  }
  const raw = (args as { path?: unknown } | null | undefined)?.path;
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  const resolved = resolveRealPathWithin(root, raw);
  return { resolved, raw };
}

/**
 * Before-tool-call hook confining every path-bearing tool call to the
 * sub-agent workspace. Returns a block decision for calls that escape it.
 */
export function buildConfinementHook(
  cwd: string
): (call: ToolCallShape) => Promise<{ block: boolean; reason?: string } | void> {
  const root = resolveRealRoot(cwd);
  return async (call: ToolCallShape) => {
    const target = extractConfinedToolPath(root, call.toolName, call.args);
    if (!target) {
      return undefined;
    }
    if (!isPathWithinRoot(target.resolved, root)) {
      logWarn(
        `[SwarmRunner] Blocked ${call.toolName} escaping the sub-agent workspace:`,
        target.raw
      );
      return {
        block: true,
        reason: `Blocked: "${target.raw}" escapes the sub-agent workspace`,
      };
    }
    return undefined;
  };
}

/** Record a modified file path when the event is a confined write/edit. */
export function collectModifiedPath(
  cwd: string,
  toolName: string,
  args: unknown
): string | null {
  const root = resolveRealRoot(cwd);
  if (!WRITE_TOOL_NAMES.has(toolName)) {
    return null;
  }
  const target = extractConfinedToolPath(root, toolName, args);
  if (!target || !isPathWithinRoot(target.resolved, root)) {
    return null;
  }
  return target.resolved;
}

/**
 * Wrap a coding tool so any path-bearing call escaping the workspace is
 * refused by the tool itself — independent of session-level hooks, which
 * the child session may not support (setBeforeToolCall is absent in this
 * SDK version, as the real headless run proved).
 */
// `any` mirrors the SDK's own alias: createAgentSession takes tools as
// `type Tool = AgentTool<any>`, and only that variance accepts the concrete
// per-tool parameter schemas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = AgentTool<any>;

export function withConfinement(tool: AnyTool, cwd: string): AnyTool {
  const hook = buildConfinementHook(cwd);
  return {
    ...tool,
    execute: async (
      toolCallId: string,
      // Mirrors the SDK alias (params: any) — see AnyTool above.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      params: any,
      signal?: AbortSignal,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onUpdate?: AgentToolUpdateCallback<any>
    ) => {
      const decision = await hook({ toolName: tool.name, args: params });
      if (decision?.block) {
        return {
          content: [
            {
              type: 'text',
              text:
                decision.reason ||
                'Blocked: this path escapes the sub-agent workspace. Work inside the workspace only.',
            },
          ],
          details: undefined,
        };
      }
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

// ---------------------------------------------------------------------------
// Post-task syntax verification
// ---------------------------------------------------------------------------

export interface SyntaxIssue {
  file: string;
  line: number;
  message: string;
}

let tsModulePromise: Promise<typeof import('typescript')> | null = null;
function getTypescript(): Promise<typeof import('typescript')> {
  if (!tsModulePromise) {
    tsModulePromise = import('typescript');
  }
  return tsModulePromise;
}

/**
 * Parse every modified TS/JS file and report SYNTAX-level diagnostics only
 * (confined, no execution, no bash). Non-TS files are skipped.
 */
export async function checkModifiedFilesSyntax(
  modifiedFiles: string[],
  getTs: () => Promise<typeof import('typescript')> = getTypescript
): Promise<SyntaxIssue[]> {
  const issues: SyntaxIssue[] = [];
  for (const file of modifiedFiles) {
    if (!/\.(ts|tsx|js|jsx)$/i.test(file)) continue;
    try {
      if (!fs.existsSync(file)) {
        issues.push({ file, line: 0, message: 'File missing after task' });
        continue;
      }
      const ts = await getTs();
      const content = fs.readFileSync(file, 'utf-8');
      const ext = path.extname(file).toLowerCase();
      const kind =
        ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.jsx' ? ts.ScriptKind.JSX : ext === '.js' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
      // parseDiagnostics is an internal but stable SourceFile property; the
      // public checker API would require a full Program for syntax-only checks.
      const parseDiagnostics = (sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] })
        .parseDiagnostics;
      for (const diag of parseDiagnostics.slice(0, 5)) {
        if (diag.start === undefined) continue;
        issues.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(diag.start).line + 1,
          message: ts.flattenDiagnosticMessageText(diag.messageText, ' '),
        });
      }
    } catch (error) {
      issues.push({ file, line: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Guardrails: bounded concurrency + per-task timeout
// ---------------------------------------------------------------------------

/** FIFO semaphore bounding how many sub-agents run at once. */
export class TaskSlotLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  get activeCount(): number {
    return this.active;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    // The slot was transferred by release(): active already reflects it.
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Slot transfer: the freed slot goes straight to the next waiter,
      // keeping active unchanged so no slot is double-counted.
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

export class SubAgentTaskTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`Sub-agent "${label}" timed out after ${timeoutMs}ms`);
  }
}

/**
 * Race the work against a timeout; the AbortSignal lets the real session
 * launcher stop in-flight calls when the deadline wins.
 */
export async function withTaskTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting so the race surfaces the typed timeout; the
      // abort then stops the in-flight session calls.
      reject(new SubAgentTaskTimeoutError(label, timeoutMs));
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
  });
  const workPromise = work(controller.signal);
  // The losing racer must never surface as an unhandled rejection.
  workPromise.catch(() => undefined);
  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Real session launcher (pattern: subagent-extension spawn_subagent)
// ---------------------------------------------------------------------------

export interface SubAgentSessionArgs {
  task: AgentTask;
  context: string;
  config: AppConfig;
  cwd: string;
  label: string;
  signal?: AbortSignal;
}

export interface SubAgentSessionResult {
  output: string;
  modifiedFiles: string[];
}

function buildChildSystemPrompt(task: AgentTask): string {
  return [
    'You are a focused sub-agent inside a collaborative multi-agent swarm.',
    `Your role: ${task.role}. Task title: ${task.title}.`,
    'Complete the task using only the provided file tools and return ONLY the result.',
    'Do not ask questions. Do not access or modify anything outside the workspace.',
    '',
    '## Task',
    task.prompt,
  ].join('\n');
}

async function launchSubAgentSession(
  args: SubAgentSessionArgs
): Promise<SubAgentSessionResult> {
  const model = resolveSubAgentModel(args.config);

  // Isolated AuthStorage per sub-agent: profiles running in parallel never
  // overwrite each other's credentials in a shared store.
  const authStorage = AuthStorage.create();
  const apiKey = args.config.apiKey?.trim();
  const modelString = resolvePiModelString({
    provider: args.config.provider,
    customProtocol: args.config.customProtocol,
    model: args.config.model,
  });
  const parts = modelString.split('/');
  const keyProvider = parts.length >= 2 ? parts[0] : args.config.provider || 'anthropic';
  if (apiKey) {
    authStorage.setRuntimeApiKey(keyProvider, apiKey);
    if (model.provider !== keyProvider) {
      authStorage.setRuntimeApiKey(model.provider, apiKey);
    }
  }
  const modelRegistry = new ModelRegistry(authStorage);

  // No bash tool: a free-form shell cannot be reliably confined without an
  // OS sandbox, and the swarm requires writes to stay inside the workspace.
  // Every tool is additionally confined by a wrapper refusing paths that
  // escape the workspace.
  const tools = [
    createReadTool(args.cwd),
    createWriteTool(args.cwd),
    createEditTool(args.cwd),
    createFindTool(args.cwd),
    createGrepTool(args.cwd),
    createLsTool(args.cwd),
  ].map((tool) => withConfinement(tool, args.cwd));

  const childSystemPrompt = buildChildSystemPrompt(args.task);
  const resourceLoader = new DefaultResourceLoader({
    cwd: args.cwd,
    appendSystemPrompt: childSystemPrompt,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model,
    authStorage,
    modelRegistry,
    tools,
    customTools: [],
    sessionManager: PiSessionManager.inMemory(),
    settingsManager: PiSettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    }),
    resourceLoader,
    cwd: args.cwd,
  });

  // Confinement hook: block every path-bearing call escaping the workspace.
  const piSession = session as unknown as {
    setBeforeToolCall?: (
      hook: (call: { toolName: string; args: unknown }) => Promise<
        { block: boolean; reason?: string } | void
      >
    ) => void;
    abort?: () => Promise<void> | void;
    dispose?: () => void;
  };
  if (typeof piSession.setBeforeToolCall === 'function') {
    piSession.setBeforeToolCall(buildConfinementHook(args.cwd));
  } else {
    // Tool-level confinement (withConfinement) remains active regardless —
    // this hook would only be an additional, session-level layer.
    logWarn('[SwarmRunner] Session-level confinement hook unavailable — tool-level confinement active');
  }

  const modifiedFiles = new Set<string>();
  let finalText = '';
  const root = path.resolve(args.cwd);

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_end') {
      const messages = (event as { messages?: unknown[] }).messages || [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i] as { role?: string; content?: unknown } | undefined;
        if (msg && msg.role === 'assistant' && Array.isArray(msg.content)) {
          finalText = (msg.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === 'text' && b.text)
            .map((b) => b.text)
            .join('');
          break;
        }
      }
    }
    if (event.type === 'tool_execution_start') {
      const e = event as { toolName?: string; args?: unknown };
      const modified = collectModifiedPath(root, e.toolName || '', e.args);
      if (modified) {
        modifiedFiles.add(modified);
      }
    }
  });

  try {
    const promptParts = [args.task.prompt];
    if (args.context && args.context.trim()) {
      promptParts.push('', '## Context from upstream agents', args.context);
    }

    const abortPromise = args.signal
      ? new Promise<never>((_resolve, reject) => {
          if (args.signal?.aborted) {
            reject(new Error('Sub-agent aborted'));
            return;
          }
          args.signal?.addEventListener('abort', () => reject(new Error('Sub-agent aborted')), {
            once: true,
          });
        })
      : null;

    const racers: Promise<unknown>[] = [session.prompt(promptParts.join('\n'))];
    if (abortPromise) {
      racers.push(abortPromise);
    }
    await Promise.race(racers);
  } finally {
    unsubscribe();
    try {
      const abortResult = piSession.abort?.();
      if (abortResult && typeof abortResult === 'object' && 'then' in abortResult) {
        await Promise.race([abortResult, new Promise<void>((r) => setTimeout(r, 5000))]);
      }
    } catch {
      // abort may throw if the session already completed — safe to ignore
    }
    piSession.dispose?.();
  }

  return { output: finalText, modifiedFiles: [...modifiedFiles] };
}

// ---------------------------------------------------------------------------
// Runner assembly
// ---------------------------------------------------------------------------

export interface SwarmRunnerOptions {
  /** Workspace every sub-agent is confined to. */
  cwd: string;
  /** Config source; defaults to the app config store. */
  getConfig?: () => AppConfig;
  /** Session launcher; overridable for tests. */
  launchSession?: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
}

interface TaskGuardrails {
  timeoutMs: number;
  maxConcurrent: number;
}

function resolveGuardrails(config: AppConfig): TaskGuardrails {
  const subAgents: SubAgentsConfig = config.subAgents ?? normalizeSubAgentsConfig(undefined);
  return { timeoutMs: subAgents.timeoutMs, maxConcurrent: subAgents.maxConcurrent };
}

/**
 * After a successful task with modified files, verify the syntax of every
 * changed TS/JS file and allow ONE corrective re-run with the same profile.
 */
async function finalizeTaskResult(
  task: AgentTask,
  context: string,
  result: SubAgentSessionResult,
  modelLabel: string,
  usedFallback: boolean,
  usedConfig: AppConfig,
  launchSession: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>,
  cwd: string,
  timeoutMs: number
): Promise<SubAgentRunResult> {
  let output = result.output;
  let modifiedFiles = result.modifiedFiles;
  let syntaxIssues = await checkModifiedFilesSyntax(modifiedFiles);

  if (syntaxIssues.length > 0) {
    const listed = syntaxIssues.map((i) => `${i.file}:${i.line} — ${i.message}`).join('\n');
    logWarn(`[SwarmRunner] ${task.role} introduced syntax errors; one corrective re-run`);
    const retry = await withTaskTimeout(
      (signal) =>
        launchSession({
          task,
          context:
            `${context}\n\n## Your previous changes introduced syntax errors — fix them\n${listed}\n\n` +
            'Re-apply the changes correctly using write/edit inside the workspace.',
          config: usedConfig,
          cwd,
          label: modelLabel,
          signal,
        }) as unknown as Promise<SubAgentSessionResult>,
      timeoutMs,
      `${task.role}:${task.id}:syntax-fix`
    );
    // The retry receives the same profile; restore it from the label owner by
    // re-running with the original config through a fresh launcher call.
    output = retry.output;
    modifiedFiles = retry.modifiedFiles;
    syntaxIssues = await checkModifiedFilesSyntax(modifiedFiles);
  }

  return {
    output,
    modifiedFiles,
    usedFallback,
    modelUsed: modelLabel,
    syntaxIssues: syntaxIssues.length
      ? syntaxIssues.map((i) => `${i.file}:${i.line} ${i.message}`)
      : undefined,
  };
}

/**
 * Build the real SubAgentRunnerFn wired into the coordinator. Each task:
 * resolves its profile, acquires a concurrency slot, runs its own agent
 * session under a per-task timeout, and falls back exactly once to the
 * active profile if the configured sub-agent model fails.
 */
export function createSwarmRunner(options: SwarmRunnerOptions): SubAgentRunnerFn {
  const getConfig = options.getConfig ?? (() => configStore.getAll());
  const launchSession = options.launchSession ?? launchSubAgentSession;
  const limiter = new TaskSlotLimiter(resolveGuardrails(getConfig()).maxConcurrent);

  return async (task: AgentTask, context: string): Promise<SubAgentRunResult> => {
    const appConfig = getConfig();
    const { timeoutMs } = resolveGuardrails(appConfig);
    const profile = resolveSubAgentProfile(task.role, appConfig);

    await limiter.acquire();
    log(`[SwarmRunner] ${task.role} starting with model "${profile.label}"`);
    try {
      try {
        const result = await withTaskTimeout(
          (signal) =>
            launchSession({
              task,
              context,
              config: profile.config,
              cwd: options.cwd,
              label: profile.label,
              signal,
            }),
          timeoutMs,
          `${task.role}:${task.id}`
        );
        return await finalizeTaskResult(task, context, result, profile.label, false, profile.config, launchSession, options.cwd, timeoutMs);
      } catch (error) {
        if (profile.source === 'inherited') {
          logError(`[SwarmRunner] Task ${task.role} failed on model "${profile.label}":`, error);
          throw error;
        }
        // Exactly one fallback attempt — never a retry loop.
        const reason = error instanceof Error ? error.message : String(error);
        const activeLabel = `active/${appConfig.model || appConfig.provider}`;
        logWarn(
          `[SwarmRunner] Sub-agent model "${profile.label}" failed (${reason}) — ` +
            `falling back to "${activeLabel}"`
        );
        const result = await withTaskTimeout(
          (signal) =>
            launchSession({
              task,
              context,
              config: appConfig,
              cwd: options.cwd,
              label: activeLabel,
              signal,
            }),
          timeoutMs,
          `${task.role}:${task.id}:fallback`
        );
        return await finalizeTaskResult(task, context, result, activeLabel, true, appConfig, launchSession, options.cwd, timeoutMs);
      }
    } finally {
      limiter.release();
    }
  };
}