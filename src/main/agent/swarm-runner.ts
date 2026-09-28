/**
 * @module main/agent/swarm-runner
 *
 * Real executor for the multi-agent swarm: each DAG task runs in its own
 * pi-coding-agent session, confined to the session workspace.
 *
 * - Profile resolution: criticality tier (dynamic) > per-role override >
 *   sub-agents configSet > inherited active profile (default — zero surprise).
 *   Criticality is structural: a task other tasks depend on is on the critical
 *   path and can use a stronger profile than a terminal task.
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
import { buildWebTools } from './web-tools';
import { buildSubAgentDelegationTool } from './background-delegations';
import { SubAgentGate } from './sub-agent-gate';
import { proposeSkill } from '../skills/skill-proposals';
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
import type {
  AgentRole,
  AgentTask,
  SubAgentRunResult,
  SubAgentRunnerFn,
} from './multi-agent-coordinator';
import { buildCorrectiveContext } from './cross-verification';
import { resolveSubAgentCompactionSettings } from './compaction-policy';
import { shouldRetryOnContextOverflow } from './context-overflow';
import {
  buildAskTeammateTool,
  buildTeammateResponder,
  ASK_TEAMMATE_TRIGGER_RULE,
} from './teammate-tool';
import {
  drainTeammate,
  getTeammateExchanges,
  getTeammateTeam,
  markTeammateBoundary,
  registerTeammate,
  unregisterTeammate,
  MAX_TEAMMATE_CALLS_PER_TASK,
  type TeammateExchange,
} from './teammate-bus';

/** Every role that can exist in a swarm plan — the teammate targets. */
const TEAMMATE_ROLES: AgentRole[] = ['architect', 'developer', 'reviewer', 'security'];

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

type SubAgentProfileSource = 'criticality' | 'role' | 'configSet' | 'inherited';

interface ResolvedSubAgentProfile {
  /** Derived AppConfig the sub-agent session must run with. */
  config: AppConfig;
  source: SubAgentProfileSource;
  /** Human-readable model label used in logs and results. */
  label: string;
  /** Role persona display name (undefined = generic role name). */
  personaName?: string;
  /** Role system prompt — ADDED to project/agent instructions (complement). */
  systemPrompt?: string;
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
 * criticality tier (when configured and known) > per-role override >
 * sub-agents configSet > inherited active profile.
 *
 * @param criticalPath Structural criticality of the task (true = other tasks
 * depend on it). When a matching `subAgents.criticality` tier is configured it
 * wins, so the same DAG can route blocking work to a strong model and terminal
 * work to an economical one. Undefined keeps the static per-role behaviour.
 *
 * Unknown configSet ids degrade to the next level with a warning.
 */
export function resolveSubAgentProfile(
  role: string,
  appConfig: AppConfig,
  criticalPath?: boolean
): ResolvedSubAgentProfile {
  const subAgents = appConfig.subAgents ?? normalizeSubAgentsConfig(undefined);

  // Dynamic criticality tier first — the whole point is to NOT be limited to a
  // model fixed per named role.
  if (typeof criticalPath === 'boolean') {
    const tier = criticalPath ? subAgents.criticality?.critical : subAgents.criticality?.economical;
    if (tier?.configSetId) {
      const set = appConfig.configSets.find((s) => s.id === tier.configSetId);
      if (set) {
        const resolved = profileFromSelection(appConfig, set, tier.modelId, 'criticality');
        return {
          ...resolved,
          personaName: tier.personaName,
          systemPrompt: tier.systemPrompt,
        };
      }
      logWarn(`[SwarmRunner] Criticality configSet "${tier.configSetId}" not found; falling back`);
    }
  }

  const roleSelection = subAgents.perRole[role as SubAgentRoleKey];
  if (roleSelection?.configSetId) {
    const set = appConfig.configSets.find((s) => s.id === roleSelection.configSetId);
    if (set) {
      const resolved = profileFromSelection(appConfig, set, roleSelection.modelId, 'role');
      return {
        ...resolved,
        personaName: roleSelection.personaName,
        systemPrompt: roleSelection.systemPrompt,
      };
    }
    logWarn(
      `[SwarmRunner] Per-role configSet "${roleSelection.configSetId}" not found; falling back`
    );
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
function resolveRealPathWithin(root: string, raw: string): string {
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
function extractConfinedToolPath(
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
export function collectModifiedPath(cwd: string, toolName: string, args: unknown): string | null {
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

interface SyntaxIssue {
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
async function checkModifiedFilesSyntax(
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
        ext === '.tsx'
          ? ts.ScriptKind.TSX
          : ext === '.jsx'
            ? ts.ScriptKind.JSX
            : ext === '.js'
              ? ts.ScriptKind.JS
              : ts.ScriptKind.TS;
      const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
      // parseDiagnostics is an internal but stable SourceFile property; the
      // public checker API would require a full Program for syntax-only checks.
      const parseDiagnostics = (
        sourceFile as unknown as { parseDiagnostics: readonly ts.Diagnostic[] }
      ).parseDiagnostics;
      for (const diag of parseDiagnostics.slice(0, 5)) {
        if (diag.start === undefined) continue;
        issues.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(diag.start).line + 1,
          message: ts.flattenDiagnosticMessageText(diag.messageText, ' '),
        });
      }
    } catch (error) {
      issues.push({
        file,
        line: 0,
        message: error instanceof Error ? error.message : String(error),
      });
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

  /**
   * Take a slot, waiting for one when the local swarm budget is exhausted.
   *
   * A queued holder that is cancelled while waiting drops out of the queue
   * instead of being handed a slot it will never use — otherwise the slot
   * transfer in release() keeps handing out capacity to a dead run, and the
   * coordinator's `Promise.all` never settles.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Sub-agent aborted');
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: () => void = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        cleanup();
        reject(new Error('Sub-agent aborted'));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
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
  /** Idle timeout: the session is aborted after this much time without events. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Live progress hook (tool calls) — used by async delegations. */
  onEvent?: (step: SubAgentToolStep) => void;
  /** Hierarchy depth: 0 = main agent's direct sub-agents, 2 = hard cap. */
  depth?: number;
  /** Origin session id (for tracking children in the delegations registry). */
  rootSessionId?: string;
  /** Role persona display name (from the per-role profile). */
  personaName?: string;
  /** Role system prompt — ADDED to project/agent instructions (complement). */
  systemPrompt?: string;
  /** Parent's global-gate slot handle — a synchronous child borrows it. */
  gateSlot?: { release(): void; reacquire(): Promise<void> };
}

/** One observed tool call inside a sub-agent session. */
export interface SubAgentToolStep {
  toolName: string;
  at: number;
}

export interface SubAgentSessionResult {
  output: string;
  modifiedFiles: string[];
  /** Cumulative token usage of the session, when the provider reports it. */
  tokenUsage?: { input: number; output: number };
  /** Teammate questions ASKED by this session (team mode only), with cost. */
  teammateExchanges?: TeammateExchange[];
}

export function buildChildSystemPrompt(task: AgentTask): string {
  const lines = [
    'You are a focused sub-agent inside a collaborative multi-agent swarm.',
    `Your role: ${task.role}. Task title: ${task.title}.`,
    'Complete the task using only the provided file tools and return ONLY the result.',
    // Team mode ONLY swaps this one line: without it the prompt is byte-for-byte
    // the classic one, so a default swarm's prompt and cost are unchanged.
    task.teamMode
      ? 'Do not ask the human questions. Do not access or modify anything outside the workspace.'
      : 'Do not ask questions. Do not access or modify anything outside the workspace.',
  ];
  if (task.teamMode) {
    lines.push(
      '',
      '## Teammates (opt-in team mode)',
      'You may call ask_teammate at most ' +
        `${MAX_TEAMMATE_CALLS_PER_TASK} times to ask ONE other sub-agent of this swarm a question you are BLOCKED on, when nothing you can read or infer lets you continue.`,
      ASK_TEAMMATE_TRIGGER_RULE,
      'One question, one answer: there is no dialogue, and a follow-up counts as a second question. If no answer arrives within 30 seconds, continue with your best judgment and state the assumption in your final report.'
    );
  }
  lines.push('', '## Task', task.prompt);
  return lines.join('\n');
}

/** Extract the assistant text of one message, if any. */
function extractAssistantText(msg: unknown): string {
  const message = msg as { role?: string; content?: unknown } | undefined;
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return (message.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('');
}

/**
 * The PROPOSAL-ONLY skill tool every sub-agent carries. It can never activate
 * anything: it hands a static markdown draft to the skill-proposals store,
 * which parks it in a pending directory a human must approve (Skill doctor).
 * There is NO counterpart for proposing tools or executable code — tools stay
 * fixed, audited and confined.
 */
export function buildProposeSkillTool(): import('@mariozechner/pi-coding-agent').ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Type } = require('@sinclair/typebox') as typeof import('@sinclair/typebox');
  return {
    name: 'propose_skill',
    label: 'Propose a reusable skill (pending human approval)',
    description:
      'Propose a new SKILL as STATIC, PROCEDURAL markdown instructions (SKILL.md front-matter + guidance) when you identify a pattern worth reusing. ' +
      'The draft lands in a PENDING proposals directory — it is NOT active and will NEVER run automatically; a human reviews it in the Skill doctor screen. ' +
      'This is for documentation/playbooks ONLY: never executable code, never tool definitions.',
    parameters: Type.Object({
      name: Type.String({
        description:
          'kebab-case skill name, 3-64 chars, lowercase letters/digits/dashes (used as the directory name)',
      }),
      description: Type.String({
        description: 'One-sentence description of what the skill covers and when to use it',
      }),
      content: Type.String({
        description:
          'Full SKILL.md content. MUST start with YAML front-matter ("---\nname: ...\ndescription: ...\n---") followed by procedural guidance in markdown.',
      }),
      rationale: Type.Optional(
        Type.String({
          description: 'Why this pattern is worth reusing (shown to the human reviewer)',
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        name?: string;
        description?: string;
        content?: string;
        rationale?: string;
      };
      if (!args.name || !args.description || !args.content) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'propose_skill requires name, description and content.',
            },
          ],
          details: {},
        };
      }
      const result = proposeSkill({
        name: args.name,
        description: args.description,
        content: args.content,
        proposedBy: 'sub-agent',
        rationale: args.rationale,
      });
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Proposal rejected: ${result.error}` }],
          details: { ok: false },
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Skill proposal recorded as "${result.name}" (draft v${result.version}). ` +
              'It is PENDING — inactive until a human approves it in the Skill doctor screen. ' +
              'It will never run automatically. Mention in your report that you proposed this skill.',
          },
        ],
        details: { ok: true, name: result.name, version: result.version },
      };
    },
  };
}

async function launchSubAgentSession(args: SubAgentSessionArgs): Promise<SubAgentSessionResult> {
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
  // escape the workspace. Web tools (search/fetch) are stateless and not
  // fs-bound: research delegations need them.
  const tools = [
    createReadTool(args.cwd),
    createWriteTool(args.cwd),
    createEditTool(args.cwd),
    createFindTool(args.cwd),
    createGrepTool(args.cwd),
    createLsTool(args.cwd),
  ].map((tool) => withConfinement(tool, args.cwd));

  // RECURSIVE delegation: a sub-agent below the hard depth cap (2) gets its
  // own subordinate tool. It borrows the parent's global-gate slot while the
  // child runs (no deadlock), and the child inherits the SAME workspace.
  const depth = args.task.depth ?? 0;
  const subAgentDelegationTool =
    args.rootSessionId && depth < 2
      ? [
          buildSubAgentDelegationTool({
            rootSessionId: args.rootSessionId,
            cwd: args.cwd,
            depth,
            parentTaskId: args.task.id,
          }),
        ].map((tool) => ({
          ...tool,
          execute: async (...cbArgs: Parameters<typeof tool.execute>) => {
            args.gateSlot?.release();
            try {
              return await tool.execute(...cbArgs);
            } finally {
              await args.gateSlot?.reacquire();
            }
          },
        }))
      : [];

  // OPT-IN team mode: register this sub-agent as an answerable teammate and
  // hand it the `ask_teammate` tool. When team mode is off, `teammateTools` is
  // an empty array — the tool palette, the system prompt and the model-call
  // cost of the run stay exactly those of the classic DAG.
  const teamId = args.task.teamId;
  const team = args.task.teamMode && teamId ? getTeammateTeam(teamId) : null;
  let liveText = '';
  if (team) {
    registerTeammate(team, {
      role: args.task.role,
      taskId: args.task.id,
      responder: buildTeammateResponder({
        task: args.task,
        config: args.config,
        getContext: () => liveText,
      }),
    });
  }
  const teammateTools = team
    ? [
        buildAskTeammateTool({
          team,
          role: args.task.role,
          taskId: args.task.id,
          targetRoles: TEAMMATE_ROLES.filter((role) => role !== args.task.role),
        }),
      ]
    : [];

  // Role persona + system prompt are ADDED to project/agent instructions —
  // a complement (like project_context alongside AGENTS.md), never a replace.
  const rolePrompt = args.systemPrompt?.trim() || '';
  const personaName = args.personaName?.trim() || '';
  const roleSystemPrompt = [
    personaName ? `You are "${personaName}", the ${args.task.role} of this swarm.` : '',
    rolePrompt,
  ]
    .filter(Boolean)
    .join('\n\n');
  const childSystemPrompt = [buildChildSystemPrompt(args.task), roleSystemPrompt]
    .filter(Boolean)
    .join('\n\n');
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
    customTools: [
      ...buildWebTools({
        tavilyApiKey: args.config.tavilyApiKey || '',
        braveApiKey: args.config.braveApiKey || '',
      }),
      ...subAgentDelegationTool,
      ...teammateTools,
      // Proposal-only skill drafting (static markdown, human-gated) — every
      // sub-agent carries it; it can never activate or execute anything.
      buildProposeSkillTool(),
    ],
    sessionManager: PiSessionManager.inMemory(),
    settingsManager: PiSettingsManager.inMemory({
      // A sub-agent used to run with compaction hard-disabled, so reading a
      // few files overflowed its window and the task failed for good. The
      // shared policy keeps context management on unless the model is too small
      // to summarise usefully.
      compaction: resolveSubAgentCompactionSettings({
        contextWindow: model.contextWindow,
        provider: model.provider,
      }),
      retry: { enabled: true, maxRetries: 1 },
    }),
    resourceLoader,
    cwd: args.cwd,
  });

  // Confinement hook: block every path-bearing call escaping the workspace.
  const piSession = session as unknown as {
    setBeforeToolCall?: (
      hook: (call: {
        toolName: string;
        args: unknown;
      }) => Promise<{ block: boolean; reason?: string } | void>
    ) => void;
    abort?: () => Promise<void> | void;
    dispose?: () => void;
  };
  if (typeof piSession.setBeforeToolCall === 'function') {
    piSession.setBeforeToolCall(buildConfinementHook(args.cwd));
  } else {
    // Tool-level confinement (withConfinement) remains active regardless —
    // this hook would only be an additional, session-level layer.
    logWarn(
      '[SwarmRunner] Session-level confinement hook unavailable — tool-level confinement active'
    );
  }

  const modifiedFiles = new Set<string>();
  let finalText = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let sawUsage = false;
  const root = path.resolve(args.cwd);

  // Activity-based idle timeout: every session event (streaming deltas, tool
  // calls, message ends) resets the timer, so a slow-but-progressing task is
  // never killed mid-stream; a silent/hung session is aborted after idleMs.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleReject: ((err: Error) => void) | undefined;
  const idlePromise = new Promise<never>((_, reject) => {
    idleReject = reject;
  });
  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => idleReject?.(new SubAgentTaskTimeoutError(args.label, args.timeoutMs)),
      args.timeoutMs
    );
    idleTimer.unref?.();
  };
  touch();

  const unsubscribe = session.subscribe((event) => {
    touch();
    if (event.type === 'message_end') {
      // In-memory sessions never persist messages, so usage has to be
      // cumulated here or it disappears with the session.
      const msg = (event as { message?: unknown }).message;
      const usage = normalizeSubAgentUsage(msg);
      if (usage) {
        inputTokens += usage.input;
        outputTokens += usage.output;
        sawUsage = true;
      }
      const text = extractAssistantText(msg);
      if (text) liveText = text;
    }
    if (event.type === 'agent_end') {
      const messages = (event as { messages?: unknown[] }).messages || [];
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const text = extractAssistantText(messages[i]);
        if (text) {
          finalText = text;
          liveText = text;
          break;
        }
      }
    }
    if (event.type === 'tool_execution_start') {
      const e = event as { toolName?: string; args?: unknown };
      try {
        args.onEvent?.({ toolName: e.toolName || 'unknown', at: Date.now() });
      } catch {
        // A throwing progress hook must never break the sub-agent session.
      }
      const modified = collectModifiedPath(root, e.toolName || '', e.args);
      if (modified) {
        modifiedFiles.add(modified);
      }
    }
    if (event.type === 'tool_execution_end' && team) {
      // A finished action is the target's boundary: answer any teammate blocked
      // on this sub-agent WITHOUT interrupting its own reasoning.
      markTeammateBoundary(team, args.task.id);
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

    const racers: Promise<unknown>[] = [session.prompt(promptParts.join('\n')), idlePromise];
    if (abortPromise) {
      racers.push(abortPromise);
    }
    await Promise.race(racers);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    unsubscribe();
    if (team) {
      // Last boundary: answer questions that arrived just before the task
      // ended, then stop being answerable. A failing drain must never break
      // the task teardown.
      try {
        await drainTeammate(team, args.task.id);
      } catch {
        // Nothing to propagate: the asker already got its timeout fallback.
      }
      unregisterTeammate(team, args.task.id);
    }
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

  // Cost attribution: only the questions ASKED by this task are charged to it,
  // so each exchange is counted exactly once across the whole plan.
  const teammateExchanges = team
    ? getTeammateExchanges(team).filter((exchange) => exchange.fromTaskId === args.task.id)
    : [];

  return {
    output: finalText,
    modifiedFiles: [...modifiedFiles],
    tokenUsage: sawUsage ? { input: inputTokens, output: outputTokens } : undefined,
    ...(teammateExchanges.length ? { teammateExchanges } : {}),
  };
}

/** Accept the provider usage shapes seen on message_end messages. */
function normalizeSubAgentUsage(msg: unknown): { input: number; output: number } | undefined {
  if (!msg || typeof msg !== 'object') {
    return undefined;
  }
  const usage = (msg as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const raw = usage as {
    input?: unknown;
    output?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    inputTokens?: unknown;
    outputTokens?: unknown;
  };
  const input = raw.input ?? raw.input_tokens ?? raw.inputTokens;
  const output = raw.output ?? raw.output_tokens ?? raw.outputTokens;
  if (typeof input !== 'number' || typeof output !== 'number') {
    return undefined;
  }
  return { input, output };
}

// ---------------------------------------------------------------------------
// Runner assembly
// ---------------------------------------------------------------------------

interface SwarmRunnerOptions {
  /** Workspace every sub-agent is confined to. */
  cwd: string;
  /** Config source; defaults to the app config store. */
  getConfig?: () => AppConfig;
  /** Session launcher; overridable for tests. */
  launchSession?: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
  /** Concurrency cap override (default: sub-agents maxConcurrent). */
  maxConcurrentOverride?: number;
  /** Idle timeout override in ms (default: sub-agents timeoutMs). */
  timeoutMsOverride?: number;
  /** GLOBAL hierarchy semaphore — acquired around every sub-agent session. */
  gate?: SubAgentGate;
  /** Origin session id, propagated so recursive children can report to it. */
  rootSessionId?: string;
  /**
   * Per-task cancellation signal + live-progress hook, consulted when the
   * session is launched (used by async delegations for cancel/monitoring).
   */
  taskExtras?: (task: AgentTask) => {
    signal?: AbortSignal;
    onEvent?: (step: SubAgentToolStep) => void;
  };
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
 * Take the global hierarchy slot, reporting whether one was actually held so
 * the caller can release it when the local limiter rejects on the same cancel.
 */
async function acquireGate(gate: SubAgentGate, signal?: AbortSignal): Promise<boolean> {
  await gate.acquire(signal);
  return true;
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
  const teammateExchanges: TeammateExchange[] = [...(result.teammateExchanges ?? [])];
  const usage = { input: 0, output: 0 };
  let sawUsage = false;
  const addUsage = (u?: { input: number; output: number }) => {
    if (!u) return;
    usage.input += u.input;
    usage.output += u.output;
    sawUsage = true;
  };
  addUsage(result.tokenUsage);
  let syntaxIssues = await checkModifiedFilesSyntax(modifiedFiles);

  if (syntaxIssues.length > 0) {
    const listed = syntaxIssues.map((i) => `${i.file}:${i.line} — ${i.message}`).join('\n');
    logWarn(`[SwarmRunner] ${task.role} introduced syntax errors; one corrective re-run`);
    const retry = await withTaskTimeout(
      (signal) =>
        launchSession({
          task,
          context: `${context}\n\n${buildCorrectiveContext({
            reason: 'Your previous changes introduced syntax errors — fix them',
            details: listed,
            instruction: 'Re-apply the changes correctly using write/edit inside the workspace.',
          })}`,
          config: usedConfig,
          cwd,
          label: modelLabel,
          timeoutMs,
          signal,
        }) as unknown as Promise<SubAgentSessionResult>,
      timeoutMs,
      `${task.role}:${task.id}:syntax-fix`
    );
    // The retry receives the same profile; restore it from the label owner by
    // re-running with the original config through a fresh launcher call.
    output = retry.output;
    modifiedFiles = retry.modifiedFiles;
    addUsage(retry.tokenUsage);
    if (retry.teammateExchanges?.length) {
      teammateExchanges.push(...retry.teammateExchanges);
    }
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
    tokenUsage: sawUsage ? usage : undefined,
    ...(teammateExchanges.length ? { teammateExchanges } : {}),
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
  const limiter = new TaskSlotLimiter(
    options.maxConcurrentOverride ?? resolveGuardrails(getConfig()).maxConcurrent
  );

  return async (
    task: AgentTask,
    context: string,
    signal?: AbortSignal
  ): Promise<SubAgentRunResult> => {
    const appConfig = getConfig();
    const baseGuardrails = resolveGuardrails(appConfig);
    const timeoutMs = options.timeoutMsOverride ?? baseGuardrails.timeoutMs;
    const profile = resolveSubAgentProfile(task.role, appConfig, task.criticalPath);
    // The plan-level signal (third argument) takes precedence over the
    // per-task extras: it is the one the coordinator owns, so a user cancel
    // reaches the session even when no taskExtras factory is configured.
    const extras = {
      ...(options.taskExtras?.(task) ?? {}),
      ...(signal ? { signal } : {}),
    };
    const taskSignal = extras.signal;
    const personaFields = {
      ...(profile.personaName ? { personaName: profile.personaName } : {}),
      ...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
    };

    // GLOBAL hierarchical semaphore first (all levels combined), then the
    // local swarm limiter. Either acquire can reject on cancel, so each slot
    // that was actually taken is released on the way out — the try/finally
    // below only covers what it opened.
    const gateHeld = options.gate ? await acquireGate(options.gate, taskSignal) : false;
    try {
      await limiter.acquire(taskSignal);
    } catch (error) {
      if (gateHeld) options.gate?.release();
      throw error;
    }
    log(`[SwarmRunner] ${task.role} starting with model "${profile.label}"`);
    try {
      try {
        const result = await launchSession({
          task,
          context,
          config: profile.config,
          cwd: options.cwd,
          label: profile.label,
          timeoutMs,
          ...(options.rootSessionId ? { rootSessionId: options.rootSessionId } : {}),
          ...(extras.signal ? { signal: extras.signal } : {}),
          ...(extras.onEvent ? { onEvent: extras.onEvent } : {}),
          ...personaFields,
          ...(options.gate
            ? {
                gateSlot: {
                  release: () => options.gate!.release(),
                  reacquire: () => options.gate!.acquire(taskSignal),
                },
              }
            : {}),
        });
        return await finalizeTaskResult(
          task,
          context,
          result,
          profile.label,
          false,
          profile.config,
          launchSession,
          options.cwd,
          timeoutMs
        );
      } catch (error) {
        // A user cancellation must surface as cancelled — NOT be masked by
        // the model fallback retry (which would resurrect the aborted run).
        if (extras.signal?.aborted) throw error;
        if (profile.source === 'inherited') {
          logError(`[SwarmRunner] Task ${task.role} failed on model "${profile.label}":`, error);
          throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        // A context overflow replayed against a model with the same (or a
        // smaller) window fails identically: the task re-reads the same files
        // into a fresh session and overflows at the same point. Retrying would
        // bill the user twice for an outcome that is already decided. Only a
        // strictly larger window is worth the second attempt.
        const overflow = shouldRetryOnContextOverflow({
          error,
          sourceWindow: profile.config.contextWindow,
          fallbackWindow: appConfig.contextWindow,
        });
        if (!overflow.retry) {
          logError(
            `[SwarmRunner] Task ${task.role} overflowed the context window on "${profile.label}" ` +
              `(${reason}) — skipping the model fallback, which cannot recover from this`,
            error
          );
          throw error;
        }
        // Exactly one fallback attempt — never a retry loop.
        const activeLabel = `active/${appConfig.model || appConfig.provider}`;
        logWarn(
          `[SwarmRunner] Sub-agent model "${profile.label}" failed (${reason}) — ` +
            `falling back to "${activeLabel}"`
        );
        const result = await launchSession({
          task,
          context,
          config: appConfig,
          cwd: options.cwd,
          label: activeLabel,
          timeoutMs,
          ...(options.rootSessionId ? { rootSessionId: options.rootSessionId } : {}),
          ...(extras.signal ? { signal: extras.signal } : {}),
          ...(extras.onEvent ? { onEvent: extras.onEvent } : {}),
          ...(options.gate
            ? {
                gateSlot: {
                  release: () => options.gate!.release(),
                  reacquire: () => options.gate!.acquire(taskSignal),
                },
              }
            : {}),
        });
        return await finalizeTaskResult(
          task,
          context,
          result,
          activeLabel,
          true,
          appConfig,
          launchSession,
          options.cwd,
          timeoutMs
        );
      }
    } finally {
      limiter.release();
      // Only release a gate slot we actually hold: acquireGate may have
      // rejected without ever incrementing it.
      if (gateHeld) options.gate?.release();
    }
  };
}
