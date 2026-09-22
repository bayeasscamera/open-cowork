/**
 * @module main/agent/background-delegations
 *
 * Asynchronous delegation with FULL autonomy: the main agent hands ONE
 * self-contained task to a background sub-agent and keeps working. The
 * sub-agent never asks questions back: it works with what it was given and
 * reports every assumption it had to make. On completion it produces a
 * STRUCTURED REPORT (summary / findings / assumptions / limits / modified
 * files) that is:
 *   - injected into the main session at the user's next turn (once), and
 *   - kept readable in the dedicated tracking view (IPC backgroundTasks.*).
 *
 * The tracking view gets live progress: every tool call the sub-agent makes
 * is streamed as an 'background.task' progress event and buffered per task.
 *
 * Actions: cancel (aborts the real sub-agent session via AbortSignal — not
 * a UI-only flag), retry (re-launches the same prompt as a new delegation),
 * delete (drops history entries; completed results keep being injected only
 * while undelivered).
 *
 * Dedicated settings (separate from the swarm's subAgents section): default
 * ConfigSet+model, idle timeout, max concurrent delegations, notifications.
 *
 * Reuses createSwarmRunner for the actual session: per-role profile
 * resolution, workspace confinement, idle timeout, model fallback — only
 * the await is dropped, plus the cancel signal and progress hook.
 * BackgroundJobRegistry is NOT reused: it tracks spawned processes
 * (pid/log/exit), not in-process agent sessions; the atomic-JSON
 * persistence pattern is shared.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { AgentTask, AgentRole, SubAgentRunnerFn } from './multi-agent-coordinator';
import { SubAgentGate } from './sub-agent-gate';
import {
  createSwarmRunner,
  type SubAgentSessionArgs,
  type SubAgentSessionResult,
  type SubAgentToolStep,
} from './swarm-runner';
import { sendToRenderer } from '../events/renderer-sender';
import {
  CROSS_VERIFICATION_COST,
  buildResearchCrossCheckPrompt,
  buildResearchCrossCheckResult,
  parseResearchContradictions,
  type CrossVerificationResult,
} from './cross-verification';
import { groupResearchByTopic, sharesResearchTopic } from './research-topic';
import { EmbeddingCache, groupByEmbedding } from './embedding-grouping';
import { MemoryLLMClient, type MemoryLLMClientLike } from '../memory/memory-llm-client';
import { log, logError, logWarn } from '../utils/logger';
import type { ServerEvent } from '../../shared/types';
import { configStore, type AppConfig as StoreAppConfig } from '../config/config-store';
import {
  buildDetachedLaunchPlan,
  describeDetachedEvent,
  isProcessAlive,
  killDetachedTree,
  readDetachedResult,
  readNewLogLines,
  spawnDetachedDelegation,
  DETACHED_POLL_INTERVAL_MS,
  DETACHED_TERMINATE_GRACE_MS,
  type DetachedLauncher,
  type DetachedResult,
} from './detached-delegation';

/** Injected result text is capped so a huge research cannot flood the turn. */
const MAX_INJECTED_RESULT_CHARS = 12_000;
const MAX_PERSISTED_RESULT_CHARS = 20_000;
const MAX_LOG_STEPS = 40;
const MAX_TRACKED_TASKS = 60;
/** One resume attempt per task: a task interrupted again must not loop forever. */
export const MAX_DELEGATION_RESUME_ATTEMPTS = 1;

export type DelegationStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface DelegationReport {
  summary: string;
  findings: string;
  assumptions: string;
  limits: string;
}

export interface DelegationLogEntry {
  at: number;
  kind: 'launched' | 'tool' | 'completed' | 'failed' | 'cancelled';
  text: string;
}

export interface BackgroundDelegation {
  id: string;
  sessionId: string;
  title: string;
  prompt: string;
  role: AgentRole;
  /** Workspace the sub-agent is confined to (kept for retry). */
  cwd: string;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  /** Model label the sub-agent actually ran on (fallback included). */
  modelUsed?: string;
  /** True when the delegation fell back to the active profile. */
  usedFallback?: boolean;
  /** Hierarchy depth (1 = main agent's delegation, 2 = recursive child — hard cap). */
  depth: number;
  /** Parent delegation id when this task was delegated BY another sub-agent. */
  parentTaskId?: string;
  /** Cumulative token usage of THIS level only (children roll up separately). */
  tokenUsage?: { input: number; output: number };
  /**
   * OPT-IN: when true, this report is cross-checked against the OTHER parallel
   * cross-verify reports of the same session — factual contradictions are
   * surfaced explicitly instead of being silently merged.
   */
  crossVerify?: boolean;
  report?: DelegationReport;
  rawResult?: string;
  error?: string;
  modifiedFiles?: string[];
  delivered: boolean;
  log: DelegationLogEntry[];
  /** True when the app quit while this delegation was still running. */
  interrupted?: boolean;
  /** Set on a delegation that replaced an interrupted one (see resumeInterruptedDelegations). */
  resumedFrom?: string;
  /** Id of the delegation that resumed this interrupted one. */
  resumedBy?: string;
  /** How many times this task has already been resumed (bounded, see MAX_DELEGATION_RESUME_ATTEMPTS). */
  resumeAttempts?: number;
  /** True when this delegation runs in its own OS process (survives app quit). */
  detached?: boolean;
  /** PID of the detached process (used to cancel it and to check liveness). */
  pid?: number;
  /** File the detached process writes its atomic outcome to. */
  resultFile?: string;
  /** File the detached process appends its JSONL event stream to. */
  logFile?: string;
  /** Byte offset already consumed from logFile (live progress tail). */
  logOffset?: number;
}

export interface DelegationSettings {
  /** ConfigSet for delegated tasks (empty = inherit the active profile). */
  configSetId: string;
  /** Model pinned inside that ConfigSet (empty = its active model). */
  modelId?: string;
  /** Per-task idle timeout in ms. */
  timeoutMs: number;
  /** Max delegations running at once. */
  maxConcurrent: number;
  /** Native notification when a task finishes while the app is unfocused. */
  notifyOnCompletion: boolean;
  /**
   * Re-launch delegations that were still running when the app last quit.
   * A background sub-agent cannot survive process exit, so "persistent" means
   * resumed at startup from the stored prompt, workspace and role.
   */
  resumeOnRestart: boolean;
  /**
   * Run each delegation in its own detached OS process (--headless), so it
   * keeps working after the app quits. Off by default: it costs a whole
   * process per task and changes the permission model (detachedAutoApprove).
   */
  detachedExecution: boolean;
  /**
   * Give detached delegations --auto-approve. A detached process has nobody to
   * answer a permission prompt, so without this it can read but not write or
   * run commands. Enabling it grants FULL tool access with no confirmation.
   */
  detachedAutoApprove: boolean;
}

export const DEFAULT_DELEGATION_SETTINGS: DelegationSettings = {
  configSetId: '',
  modelId: undefined,
  timeoutMs: 180_000,
  maxConcurrent: 2,
  notifyOnCompletion: true,
  resumeOnRestart: true,
  detachedExecution: false,
  detachedAutoApprove: false,
};

/**
 * The self-contained brief + mandatory report format. The autonomy contract
 * is stated in the prompt itself: work without asking, signalled
 * assumptions, five-section report.
 */
function buildAutonomousPrompt(prompt: string): string {
  return `${prompt}

## Autonomous execution contract
You work ALONE — nobody can answer questions mid-task. If information is
missing, make a reasonable assumption and record it in your report instead of
blocking. Research, read and (within your permissions) write as needed.

## Required final report (exactly this format, plain text)
## Summary
<2-3 sentences: what was done and the outcome>
## Findings
<what was found/produced — the substance of the task>
## Assumptions
<anything you had to assume because the brief lacked information, or "none">
## Limits
<failures, dead-ends, things you could not do, or "none">
## Modified files
<workspace files you changed, or "none">`;
}

/** Parse the mandated five-section report; falls back gracefully. */
export function parseDelegationReport(text: string): DelegationReport {
  const section = (name: string): string | undefined => {
    const re = new RegExp(
      `^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$)`,
      'im'
    );
    const m = re.exec(text);
    return m ? m[1].trim() : undefined;
  };
  return {
    summary: section('Summary') ?? text.trim().slice(0, 400),
    findings: section('Findings') ?? '',
    assumptions: section('Assumptions') ?? '',
    limits: section('Limits') ?? '',
  };
}

/** Human-readable + model-readable projection of a report for injection. */
export function formatReportForInjection(report: DelegationReport): string {
  const parts = [`Summary: ${report.summary}`];
  if (report.findings) parts.push(`Findings: ${report.findings}`);
  if (report.assumptions && !/^none$/i.test(report.assumptions.trim())) {
    parts.push(`Assumptions: ${report.assumptions}`);
  }
  if (report.limits && !/^none$/i.test(report.limits.trim())) {
    parts.push(`Limits: ${report.limits}`);
  }
  return parts.join('\n');
}

const delegations = new Map<string, BackgroundDelegation>();
/** FIFO of delegation ids with undelivered results, per session. */
const pendingBySession = new Map<string, string[]>();
/** Live abort controllers — cancel() must reach the running sub-agent. */
const controllers = new Map<string, AbortController>();
/** Resolvers of detached tasks' `done` promise, keyed by delegation id. */
const detachedWaiters = new Map<string, () => void>();
/** Poller that watches detached processes for completion and progress. */
let detachedTimer: ReturnType<typeof setInterval> | null = null;

/** One research cross-verification pass (opt-in; see crossVerify). */
interface ResearchCrossCheck {
  status: 'pending' | 'done' | 'failed';
  /** Delegation ids covered by this pass. */
  delegationIds: string[];
  result?: CrossVerificationResult;
  /** True once the contradiction block was injected. */
  injected: boolean;
  /** Awaitable handle (tests await it; production never blocks on it). */
  promise: Promise<void>;
}
/**
 * Per-session cross-check BATCHES. One batch per topic group: two unrelated
 * subjects headed for the same session each get their own pass instead of the
 * second group silently waiting for a later arrival.
 */
const researchCrossChecks = new Map<string, ResearchCrossCheck[]>();
/** Embedding cache shared across passes: each distinct brief embeds once. */
const researchEmbeddingCache = new EmbeddingCache();
let settings: DelegationSettings = { ...DEFAULT_DELEGATION_SETTINGS };
let storageFile: string | null = null;
let settingsFile: string | null = null;
let loaded = false;

function resolveStorageFile(): string {
  if (storageFile) return storageFile;
  let userData: string;
  try {
    userData = app?.getPath ? app.getPath('userData') : '';
  } catch {
    userData = '';
  }
  const base = userData || path.join(process.cwd(), '.cowork');
  storageFile = path.join(base, 'background_delegations.json');
  settingsFile = path.join(base, 'delegation_settings.json');
  return storageFile;
}

/** Test/optional hook: pin the storage location before first use. */
export function initBackgroundDelegations(userDataDir: string): void {
  storageFile = path.join(userDataDir, 'background_delegations.json');
  settingsFile = path.join(userDataDir, 'delegation_settings.json');
  loadPersisted();
  loadSettings();
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  loadPersisted();
  loadSettings();
}

function loadPersisted(): void {
  const file = resolveStorageFile();
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as BackgroundDelegation[];
    /** A detached task still alive in another process must keep being watched. */
    let reattachedDetached = false;
    for (const item of raw) {
      // A detached delegation runs in its own process: it may have finished
      // (result file), still be running (live pid), or died without a result.
      // Only the last case is an interruption the resume path can act on.
      if (item.status === 'running' && item.detached) {
        const finished = item.resultFile ? readDetachedResult(item.resultFile) : null;
        if (finished) {
          applyDetachedResult(item, finished);
        } else if (item.pid && isProcessAlive(item.pid)) {
          reattachedDetached = true;
        } else {
          item.status = 'failed';
          item.error = 'Detached process was interrupted by app restart';
          item.completedAt = Date.now();
          item.interrupted = true;
        }
      } else if (item.status === 'running') {
        // Sub-agent sessions die with the app: anything still "running" was
        // interrupted by the restart. The record keeps its prompt/workspace/
        // role so resumeInterruptedDelegations() can re-launch it.
        item.status = 'failed';
        item.error = 'Interrupted by app restart';
        item.completedAt = Date.now();
        item.interrupted = true;
      }
      if (!Array.isArray(item.log)) item.log = [];
      delegations.set(item.id, item);
      if (item.status === 'completed' && !item.delivered) {
        enqueuePending(item.id);
      } else if (item.interrupted && !item.delivered) {
        // An interrupted task must never disappear silently: the session is
        // told at the next turn even when the resume setting is off.
        enqueuePending(item.id);
      }
    }
    if (reattachedDetached) ensureDetachedPolling();
  } catch (err) {
    logError('[BackgroundDelegations] Failed to load persisted state:', err);
  }
}

function loadSettings(): void {
  const file = settingsFile ?? resolveStorageFile();
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(settingsFile!, 'utf-8')) as Partial<DelegationSettings>;
    settings = normalizeDelegationSettings(raw);
  } catch {
    settings = { ...DEFAULT_DELEGATION_SETTINGS };
  }
}

function persist(): void {
  const file = resolveStorageFile();
  try {
    const trimmed = Array.from(delegations.values()).sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_TRACKED_TASKS);
    const serialized = trimmed.map((d) => ({
      ...d,
      rawResult: d.rawResult?.slice(0, MAX_PERSISTED_RESULT_CHARS),
      log: d.log.slice(-MAX_LOG_STEPS),
    }));
    const tmp = `${file}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(serialized, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logError('[BackgroundDelegations] Failed to persist state:', err);
  }
}

export function normalizeDelegationSettings(raw: unknown): DelegationSettings {
  const r = (raw ?? {}) as Partial<DelegationSettings>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const clamp = (v: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(v)));
  return {
    configSetId: typeof r.configSetId === 'string' ? r.configSetId.trim() : '',
    modelId:
      typeof r.modelId === 'string' && r.modelId.trim() ? r.modelId.trim() : undefined,
    timeoutMs: clamp(num(r.timeoutMs, DEFAULT_DELEGATION_SETTINGS.timeoutMs), 10_000, 900_000),
    maxConcurrent: clamp(num(r.maxConcurrent, DEFAULT_DELEGATION_SETTINGS.maxConcurrent), 1, 4),
    notifyOnCompletion:
      typeof r.notifyOnCompletion === 'boolean'
        ? r.notifyOnCompletion
        : DEFAULT_DELEGATION_SETTINGS.notifyOnCompletion,
    resumeOnRestart:
      typeof r.resumeOnRestart === 'boolean'
        ? r.resumeOnRestart
        : DEFAULT_DELEGATION_SETTINGS.resumeOnRestart,
    detachedExecution:
      typeof r.detachedExecution === 'boolean'
        ? r.detachedExecution
        : DEFAULT_DELEGATION_SETTINGS.detachedExecution,
    detachedAutoApprove:
      typeof r.detachedAutoApprove === 'boolean'
        ? r.detachedAutoApprove
        : DEFAULT_DELEGATION_SETTINGS.detachedAutoApprove,
  };
}

export function getDelegationSettings(): DelegationSettings {
  ensureLoaded();
  return { ...settings };
}

export function setDelegationSettings(next: Partial<DelegationSettings>): DelegationSettings {
  ensureLoaded();
  settings = normalizeDelegationSettings({ ...settings, ...next });
  try {
    const file = settingsFile ?? resolveStorageFile();
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    logError('[BackgroundDelegations] Failed to persist settings:', err);
  }
  return { ...settings };
}

function enqueuePending(delegationId: string): void {
  const delegation = delegations.get(delegationId);
  if (!delegation) return;
  const queue = pendingBySession.get(delegation.sessionId) ?? [];
  if (!queue.includes(delegationId)) queue.push(delegationId);
  pendingBySession.set(delegation.sessionId, queue);
}

function pushLog(delegation: BackgroundDelegation, kind: DelegationLogEntry['kind'], text: string): void {
  delegation.log.push({ at: Date.now(), kind, text });
  if (delegation.log.length > MAX_LOG_STEPS) delegation.log.shift();
}

function emit(delegation: BackgroundDelegation, kind: 'status' | 'progress', detail?: string): void {
  const event: ServerEvent = {
    type: 'background.task',
    payload: {
      sessionId: delegation.sessionId,
      taskId: delegation.id,
      title: delegation.title,
      status: delegation.status,
      summary: detail,
      error: delegation.error,
      eventKind: kind,
    },
  };
  try {
    sendToRenderer(event);
  } catch (err) {
    // Renderer channel not configured (early startup, tests) — status still tracked.
    logWarn('[BackgroundDelegations] Event not delivered:', err);
  }
}

export interface StartDelegationOptions {
  sessionId: string;
  /** Workspace the background sub-agent is confined to (children inherit it). */
  cwd: string;
  title: string;
  prompt: string;
  role?: AgentRole;
  /** Hierarchy depth of the DELEGATED task: 1 = main agent's delegation,
   * 2 = a sub-agent's own recursive delegation. HARD CAP at 2. */
  depth?: number;
  /** Delegation id of the parent task, when delegated by a sub-agent. */
  parentTaskId?: string;
  /**
   * OPT-IN cross-verification: when this task and at least one other task of
   * the session carry it, one extra model call cross-checks their reports and
   * reports contradictions explicitly. Off by default (adds a model call).
   */
  crossVerify?: boolean;
  /**
   * Optional semantic grouping for cross-verification: when provided, close
   * paraphrases ("voiture électrique" / "VE") group together even without
   * shared vocabulary. Uses the memory embedding config, so it is inert unless
   * the user enabled embeddings — the lexical path stays the default.
   */
  embed?: (text: string) => Promise<number[]>;
  /** Injectable embedding client (tests) — defaults to MemoryLLMClient. */
  llmClient?: MemoryLLMClientLike;
  /** Config source override (tests); defaults to the app config store. */
  getConfig?: () => StoreAppConfig;
  /** Session launcher override (tests): inject a fake sub-agent session. */
  launchSession?: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
  /** Detached launcher override (tests): never spawn a real Electron process. */
  spawnDetached?: DetachedLauncher;
}

/**
 * Resolve the embedding function used ONLY for subject grouping. Silent by
 * design: embeddings are a precision bonus, and an unavailable provider must
 * leave the lexical grouping untouched rather than surface an error on a
 * background path the user never asked about.
 */
function resolveGroupingEmbedFn(options: StartDelegationOptions): (text: string) => Promise<number[]> {
  if (options.embed) return options.embed;
  const client = options.llmClient ?? new MemoryLLMClient();
  return async (text: string) => {
    try {
      return await client.embed(text);
    } catch {
      return [];
    }
  };
}

/** Hard hierarchy cap: main agent (0) → sub-agent (1) → sub-sub-agent (2). */
export const MAX_DELEGATION_DEPTH = 2;

/** The GLOBAL semaphore shared by the swarm AND every delegation level. */
export const subAgentGate = new SubAgentGate(DEFAULT_DELEGATION_SETTINGS.maxConcurrent);

/**
 * Launch a background sub-agent and return its task id IMMEDIATELY. The
 * returned object is available before the sub-agent finishes — the caller
 * (tool) must not await the sub-agent's completion.
 */
export function startDelegation(options: StartDelegationOptions): { taskId: string; done: Promise<void> } {
  ensureLoaded();

  // HARD depth cap — enforced here even if a palette leak ever allowed a
  // deeper agent to call the delegation tool.
  const depth = options.depth ?? 1;
  if (depth > MAX_DELEGATION_DEPTH) {
    throw new DelegationDepthError(depth);
  }

  // Enforce the delegation-specific concurrency cap BEFORE launching.
  const runningCount = Array.from(delegations.values()).filter((d) => d.status === 'running').length;
  if (runningCount >= settings.maxConcurrent) {
    throw new DelegationCapacityError(
      `Max concurrent delegations reached (${settings.maxConcurrent}). Wait for one to finish or raise the cap in the delegations settings.`
    );
  }

  const role: AgentRole = options.role ?? 'developer';
  const id = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const delegation: BackgroundDelegation = {
    id,
    sessionId: options.sessionId,
    title: options.title,
    prompt: options.prompt,
    role,
    cwd: options.cwd,
    depth,
    parentTaskId: options.parentTaskId,
    status: 'running',
    startedAt: Date.now(),
    delivered: false,
    log: [],
    ...(options.crossVerify ? { crossVerify: true } : {}),
  };
  delegations.set(id, delegation);
  pushLog(delegation, 'launched', `Task delegated (role: ${role}, depth: ${depth})`);
  persist();

  // The global semaphore budget follows the delegation settings.
  subAgentGate.setMax(settings.maxConcurrent);

  // Detached execution only makes sense for top-level delegations: a depth-2
  // child is awaited synchronously by its parent sub-agent.
  if (settings.detachedExecution && depth === 1) {
    const done = launchDetachedTask(id, delegation, options);
    emit(delegation, 'status');
    return { taskId: id, done };
  }

  const controller = new AbortController();
  controllers.set(id, controller);

  const done = launchBackgroundTask(id, delegation, options);
  emit(delegation, 'status');
  return { taskId: id, done };
}

export class DelegationCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationCapacityError';
  }
}

export class DelegationDepthError extends Error {
  constructor(depth: number) {
    super(`Delegation depth ${depth} exceeds the hard cap of 2 levels (main agent → sub-agent → sub-sub-agent).`);
    this.name = 'DelegationDepthError';
  }
}

function launchBackgroundTask(
  id: string,
  delegation: BackgroundDelegation,
  options: StartDelegationOptions
): Promise<void> {
  const task: AgentTask = {
    id,
    role: delegation.role,
    title: delegation.title,
    prompt: buildAutonomousPrompt(delegation.prompt),
    status: 'pending',
    depth: delegation.depth,
  };

  // Same runner as the swarm (per-role profile, confinement, idle timeout,
  // fallback) — with the delegation-specific cap, timeout, cancel signal,
  // the GLOBAL hierarchy semaphore and a live progress hook feeding the
  // tracking view.
  const effectiveGetConfig = () => {
    const config = options.getConfig ? options.getConfig() : configStore.getAll();
    if (!settings.configSetId) return config;
    // Apply the delegation-specific ConfigSet pin without touching the swarm's
    // subAgents config: resolve it the same way the swarm would.
    return {
      ...config,
      subAgents: {
        ...(config.subAgents ?? {
          configSetId: '',
          perRole: {},
          timeoutMs: 120_000,
          maxConcurrent: 2,
        }),
        configSetId: settings.configSetId,
        modelId: settings.modelId,
      },
    };
  };

  const runnerOptions: {
    cwd: string;
    getConfig?: () => StoreAppConfig;
    launchSession?: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
    maxConcurrentOverride?: number;
    timeoutMsOverride?: number;
    gate?: SubAgentGate;
    rootSessionId?: string;
    taskExtras?: (t: AgentTask) => {
      signal?: AbortSignal;
      onEvent?: (step: SubAgentToolStep) => void;
    };
  } = {
    cwd: options.cwd,
    maxConcurrentOverride: settings.maxConcurrent,
    timeoutMsOverride: settings.timeoutMs,
    gate: subAgentGate,
    rootSessionId: options.sessionId,
    taskExtras: () => ({
      signal: controllers.get(id)?.signal,
      onEvent: (step) => {
        pushLog(delegation, 'tool', step.toolName);
        emit(delegation, 'progress', step.toolName);
      },
    }),
  };
  // getConfig must return the pinned-subAgents config.
  runnerOptions.getConfig = effectiveGetConfig;
  if (options.launchSession) runnerOptions.launchSession = options.launchSession;
  const runner: SubAgentRunnerFn = createSwarmRunner(runnerOptions);

  const done = runner(task, 'Background delegation — work autonomously; see the report contract in the task.')
    .then(async (run) => {
      controllers.delete(id);
      const current = delegations.get(id);
      if (!current) return;
      // Cancelled during finalize: do not resurrect as completed.
      if (current.status === 'cancelled') return;
      current.status = 'completed';
      current.completedAt = Date.now();
      current.modelUsed = run.modelUsed;
      current.usedFallback = run.usedFallback;
      current.modifiedFiles = run.modifiedFiles;
      current.rawResult = run.output;
      current.report = parseDelegationReport(run.output);
      if (run.tokenUsage) current.tokenUsage = run.tokenUsage;
      // Recursive rollup: this level's tokens accumulate onto its parent so
      // the measured cost covers the whole hierarchy.
      if (current.parentTaskId) rollupTokensToParent(current.parentTaskId, current);
      pushLog(current, 'completed', current.report.summary.slice(0, 120));
      enqueuePending(id);
      persist();
      log(`[BackgroundDelegations] Task ${id} (${current.title}) completed`);
      emit(current, 'status', current.report.summary.slice(0, 200));
      // OPT-IN Zone 2: once two parallel cross-verify reports are pending,
      // schedule ONE contradiction cross-check (fire-and-forget).
      if (current.crossVerify) {
        // Fire-and-forget: the delegation is already marked completed and its
        // report enqueued, so a slow grouping never delays the user's result.
        void scheduleResearchCrossVerification(current.sessionId, options, effectiveGetConfig).catch(
          (err) => logError('[BackgroundDelegations] Failed to schedule research cross-verification:', err)
        );
      }
    })
    .catch((err: unknown) => {
      controllers.delete(id);
      const current = delegations.get(id);
      if (!current) return;
      if (current.status === 'cancelled') return;
      const message = err instanceof Error ? err.message : String(err);
      current.status = 'failed';
      current.completedAt = Date.now();
      current.error = message;
      current.report = {
        summary: `The delegated task failed: ${message}`,
        findings: '',
        assumptions: '',
        limits: message,
      };
      pushLog(current, 'failed', message);
      enqueuePending(id);
      persist();
      logError(`[BackgroundDelegations] Task ${id} (${current.title}) failed:`, err);
      emit(current, 'status');
    });
  return done;
}

/** Roll a child's token usage onto its parent delegation (whole-hierarchy cost). */
function rollupTokensToParent(parentTaskId: string, child: BackgroundDelegation): void {
  const parent = delegations.get(parentTaskId);
  if (!parent) return;
  const add = child.tokenUsage ?? { input: 0, output: 0 };
  const base = parent.tokenUsage ?? { input: 0, output: 0 };
  parent.tokenUsage = { input: base.input + add.input, output: base.output + add.output };
  persist();
}

// ─────────────────────────────────────────────────────────────────────────────
// DETACHED execution — the delegation survives the app quitting
// ─────────────────────────────────────────────────────────────────────────────

/** Where detached tasks keep their log and result files. */
function detachedDir(): string {
  return path.join(path.dirname(resolveStorageFile()), 'delegations');
}

function ensureDetachedPolling(): void {
  if (detachedTimer) return;
  const timer = setInterval(() => pollDetachedDelegations(), DETACHED_POLL_INTERVAL_MS);
  // Node's Timeout is unref-able (the DOM typing does not know it): the poller
  // must never keep the app — or a test run — alive by itself.
  (timer as { unref?: () => void }).unref?.();
  detachedTimer = timer;
}

function stopDetachedPolling(): void {
  if (!detachedTimer) return;
  clearInterval(detachedTimer);
  detachedTimer = null;
}

/** Stop the poller once nothing detached is left to watch. */
function stopDetachedPollingIfIdle(): void {
  const stillWatching = Array.from(delegations.values()).some(
    (d) => d.detached && d.status === 'running'
  );
  if (!stillWatching) stopDetachedPolling();
}

/**
 * Move a record to its final state from a result payload. Pure so the same
 * logic serves the live poller AND startup reconciliation.
 */
function applyDetachedResult(delegation: BackgroundDelegation, result: DetachedResult): void {
  delegation.completedAt = result.finishedAt ?? Date.now();
  if (result.status === 'completed') {
    delegation.status = 'completed';
    const output = result.output ?? '';
    delegation.rawResult = output;
    delegation.report = parseDelegationReport(output);
  } else {
    delegation.status = 'failed';
    delegation.error = result.error ?? 'Detached process failed';
  }
}

/** Settle a detached task and hand its report to the session exactly once. */
function finalizeDetached(delegation: BackgroundDelegation, result: DetachedResult): void {
  const wasRunning = delegation.status === 'running';
  applyDetachedResult(delegation, result);
  if (delegation.status === 'completed') {
    pushLog(delegation, 'completed', 'Detached process reported completion');
    if (!delegation.delivered) enqueuePending(delegation.id);
  } else {
    pushLog(delegation, 'failed', delegation.error ?? 'Detached process failed');
  }
  const waiter = detachedWaiters.get(delegation.id);
  if (waiter) {
    detachedWaiters.delete(delegation.id);
    waiter();
  }
  persist();
  if (wasRunning) emit(delegation, 'status');
}

/**
 * Launch the delegation as a detached child process. The child is the app
 * itself in headless single-shot mode; the parent keeps only the pid and the
 * two files, so quitting (or restarting) never loses the task.
 */
function launchDetachedTask(
  id: string,
  delegation: BackgroundDelegation,
  options: StartDelegationOptions
): Promise<void> {
  const dir = detachedDir();
  const resultFile = path.join(dir, id + '.result.json');
  const logFile = path.join(dir, id + '.jsonl');

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  detachedWaiters.set(id, resolveDone);

  try {
    const plan = buildDetachedLaunchPlan({
      execPath: process.execPath,
      ...(process.defaultApp ? { appPath: app.getAppPath() } : {}),
      prompt: buildAutonomousPrompt(delegation.prompt),
      cwd: delegation.cwd,
      autoApprove: settings.detachedAutoApprove,
      resultFile,
      logFile,
      delegationId: id,
    });
    const spawnFn = options.spawnDetached ?? spawnDetachedDelegation;
    const { pid } = spawnFn(plan);
    if (!pid) throw new Error('the detached process did not report a pid');
    delegation.detached = true;
    delegation.pid = pid;
    delegation.resultFile = resultFile;
    delegation.logFile = logFile;
    delegation.logOffset = 0;
    pushLog(delegation, 'launched', 'Detached process started (pid ' + pid + ')');
    persist();
    ensureDetachedPolling();
    log(
      '[BackgroundDelegations] Task ' +
        id +
        ' detached (pid ' +
        pid +
        ', auto-approve=' +
        settings.detachedAutoApprove +
        ')'
    );
  } catch (error) {
    delegation.status = 'failed';
    delegation.completedAt = Date.now();
    delegation.error =
      'Could not start the detached process: ' +
      (error instanceof Error ? error.message : String(error));
    pushLog(delegation, 'failed', delegation.error);
    detachedWaiters.delete(id);
    resolveDone();
    persist();
    emit(delegation, 'status');
  }
  return done;
}

/**
 * One polling pass over every running detached task:
 *  1. a result file means it finished — settle it;
 *  2. a dead pid with no result means it died — fail it (and let the resume
 *     path retry it at the next launch);
 *  3. otherwise it is still working — tail its log for live progress.
 * Exported so tests drive it deterministically instead of waiting on timers.
 */
export function pollDetachedDelegations(): void {
  ensureLoaded();
  let progressed = false;
  for (const delegation of Array.from(delegations.values())) {
    if (!delegation.detached || delegation.status !== 'running') continue;

    const result = delegation.resultFile ? readDetachedResult(delegation.resultFile) : null;
    if (result) {
      finalizeDetached(delegation, result);
      continue;
    }

    if (delegation.pid && !isProcessAlive(delegation.pid)) {
      // A result file may still be mid-rename: check once more before failing.
      const late = delegation.resultFile ? readDetachedResult(delegation.resultFile) : null;
      finalizeDetached(
        delegation,
        late ?? { status: 'failed', error: 'Detached process exited without writing a result' }
      );
      continue;
    }

    if (delegation.logFile) {
      const { lines, offset } = readNewLogLines(delegation.logFile, delegation.logOffset ?? 0);
      delegation.logOffset = offset;
      let last: string | null = null;
      for (const line of lines) {
        const text = describeDetachedEvent(line);
        if (text) {
          pushLog(delegation, 'tool', text);
          last = text;
        }
      }
      if (last) {
        progressed = true;
        emit(delegation, 'progress', last);
      }
    }
  }
  stopDetachedPollingIfIdle();
  if (progressed) persist();
}

/**
 * Cancel a running delegation: aborts the REAL sub-agent session (AbortSignal
 * → launchSubAgentSession's race + finally abort/dispose), marks the task
 * cancelled, and never injects a result afterwards.
 */
export function cancelDelegation(taskId: string): boolean {
  ensureLoaded();
  const delegation = delegations.get(taskId);
  if (!delegation || delegation.status !== 'running') return false;
  delegation.status = 'cancelled';
  delegation.completedAt = Date.now();
  pushLog(delegation, 'cancelled', 'Cancelled by user');
  if (delegation.detached && delegation.pid) {
    const pid = delegation.pid;
    const signalled = killDetachedTree(pid, 'SIGTERM');
    pushLog(
      delegation,
      'cancelled',
      signalled
        ? 'Detached process ' + pid + ' terminated'
        : 'Could not signal detached process ' + pid + ' (already gone?)'
    );
    // A detached agent may ignore SIGTERM: escalate once, then give up.
    const escalate = setTimeout(() => {
      if (isProcessAlive(pid)) killDetachedTree(pid, 'SIGKILL');
    }, DETACHED_TERMINATE_GRACE_MS);
    (escalate as { unref?: () => void }).unref?.();
    const waiter = detachedWaiters.get(taskId);
    if (waiter) {
      detachedWaiters.delete(taskId);
      waiter();
    }
  }
  const controller = controllers.get(taskId);
  if (controller) {
    controller.abort();
    controllers.delete(taskId);
  }
  stopDetachedPollingIfIdle();
  persist();
  emit(delegation, 'status');
  log(`[BackgroundDelegations] Task ${taskId} (${delegation.title}) cancelled — sub-agent session aborted`);
  return true;
}

/** Re-launch a cancelled/failed task's original prompt as a NEW delegation. */
export function retryDelegation(
  taskId: string,
  overrides?: Pick<StartDelegationOptions, 'getConfig' | 'launchSession'>
): { taskId: string } | undefined {
  ensureLoaded();
  const source = delegations.get(taskId);
  if (!source || source.status === 'running') return undefined;
  return startDelegation({
    sessionId: source.sessionId,
    cwd: source.cwd,
    title: source.title,
    prompt: source.prompt,
    role: source.role,
    ...(overrides ?? {}),
  });
}

/**
 * Re-launch the delegations that were still running when the app last quit.
 *
 * A background sub-agent session lives inside this process, so quitting always
 * interrupts it — what survives is the delegation itself (prompt, workspace,
 * role), persisted in background_delegations.json. At startup the interrupted
 * TOP-LEVEL tasks are re-launched as new delegations, and both records are
 * linked (resumedFrom / resumedBy) so the tracking view tells the whole story.
 *
 * Bounded on purpose:
 *  - at most MAX_DELEGATION_RESUME_ATTEMPTS resume per task;
 *  - only depth-1 tasks: a depth-2 child belongs to a parent that is re-run;
 *  - the concurrency cap still applies, so tasks that do not fit stay
 *    interrupted and are resumed at the next launch.
 */
export function resumeInterruptedDelegations(
  options: {
    /** Injection point for tests; defaults to the real startDelegation. */
    start?: (options: StartDelegationOptions) => { taskId: string; done: Promise<void> };
  } = {}
): { disabled: boolean; resumed: string[]; skipped: string[] } {
  ensureLoaded();
  const resumed: string[] = [];
  const skipped: string[] = [];

  if (!settings.resumeOnRestart) {
    return { disabled: true, resumed, skipped };
  }

  const interrupted = Array.from(delegations.values())
    .filter(
      (d) =>
        d.interrupted === true &&
        d.status !== 'running' &&
        !d.resumedBy &&
        (d.resumeAttempts ?? 0) < MAX_DELEGATION_RESUME_ATTEMPTS
    )
    .sort((a, b) => a.startedAt - b.startedAt);

  const start = options.start ?? startDelegation;

  for (const delegation of interrupted) {
    if (delegation.depth > 1) {
      // The parent's own re-run recreates its children.
      skipped.push(delegation.id);
      continue;
    }
    try {
      const { taskId } = start({
        sessionId: delegation.sessionId,
        cwd: delegation.cwd,
        title: delegation.title,
        prompt: delegation.prompt,
        role: delegation.role,
        depth: delegation.depth,
        ...(delegation.crossVerify ? { crossVerify: true } : {}),
      });
      const replacement = delegations.get(taskId);
      const attempts = (delegation.resumeAttempts ?? 0) + 1;
      delegation.resumedBy = taskId;
      if (replacement) {
        replacement.resumedFrom = delegation.id;
        replacement.resumeAttempts = attempts;
        pushLog(replacement, 'launched', `Resumed after app restart (was ${delegation.id})`);
      }
      persist();
      resumed.push(taskId);
      log(`[BackgroundDelegations] Resumed interrupted task ${delegation.id} as ${taskId}`);
    } catch (error) {
      // Capacity or depth guard: leave the record resumable for the next
      // launch instead of failing the whole startup path.
      skipped.push(delegation.id);
      logWarn(
        `[BackgroundDelegations] Could not resume ${delegation.id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return { disabled: false, resumed, skipped };
}

/** Remove a FINISHED task from the tracking history (never a running one). */
export function deleteDelegation(taskId: string): boolean {
  ensureLoaded();
  const delegation = delegations.get(taskId);
  if (!delegation || delegation.status === 'running') return false;
  delegations.delete(taskId);
  detachedWaiters.delete(taskId);
  if (delegation.detached) {
    for (const file of [delegation.resultFile, delegation.logFile]) {
      if (!file) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone: deleting a record must never fail on a missing file.
      }
    }
  }
  const queue = pendingBySession.get(delegation.sessionId);
  if (queue) {
    pendingBySession.set(
      delegation.sessionId,
      queue.filter((id) => id !== taskId)
    );
  }
  persist();
  return true;
}

function truncateResult(text: string): string {
  if (text.length <= MAX_INJECTED_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_INJECTED_RESULT_CHARS)}\n… [résultat tronqué aux premiers ${MAX_INJECTED_RESULT_CHARS} caractères]`;
}

/**
 * Run the ONE cross-verification model call over a batch of parallel research
 * reports. Uses the same swarm runner (profile resolution, confinement, idle
 * timeout, global gate) — no second execution mechanism is introduced.
 */
async function runResearchCrossCheck(
  covered: BackgroundDelegation[],
  options: StartDelegationOptions,
  getConfig: () => StoreAppConfig
): Promise<CrossVerificationResult> {
  const reports = covered.map((d) => ({
    id: d.id,
    title: d.title,
    findings: d.report?.findings ?? '',
    summary: d.report?.summary ?? d.rawResult ?? '',
  }));
  const task: AgentTask = {
    id: `research-cross-check-${Date.now()}`,
    role: 'reviewer',
    title: 'Cross-verify parallel research reports',
    prompt: buildResearchCrossCheckPrompt(reports),
    status: 'pending',
  };
  const runnerOptions: {
    cwd: string;
    getConfig: () => StoreAppConfig;
    maxConcurrentOverride: number;
    timeoutMsOverride: number;
    gate: SubAgentGate;
    launchSession?: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
  } = {
    cwd: covered[0]?.cwd ?? options.cwd,
    getConfig,
    maxConcurrentOverride: 1,
    timeoutMsOverride: settings.timeoutMs,
    gate: subAgentGate,
  };
  if (options.launchSession) runnerOptions.launchSession = options.launchSession;
  const run = await createSwarmRunner(runnerOptions)(task, '');
  return buildResearchCrossCheckResult({
    contradictions: parseResearchContradictions(run.output),
    raw: run.output,
    modelCalls: CROSS_VERIFICATION_COST.researchPass,
  });
}

/**
 * After a cross-verify delegation completes, schedule ONE cross-check PER TOPIC
 * GROUP over the pending cross-verify reports of the session. Fire-and-forget by
 * design: the delegation mode must never block, and a failure only loses the
 * enhancement. Bounded: a single model call per group (never one per report),
 * and every distinct group is served in the same cycle — a second subject no
 * longer waits for a later arrival.
 */
async function scheduleResearchCrossVerification(
  sessionId: string,
  options: StartDelegationOptions,
  getConfig: () => StoreAppConfig
): Promise<void> {
  const pendingCrossVerify = Array.from(delegations.values()).filter(
    (d) => d.sessionId === sessionId && d.crossVerify && d.status === 'completed' && !d.delivered
  );
  // A cross-check needs at least TWO independent reports to contradict.
  if (pendingCrossVerify.length < 2) return;
  const textOf = (d: BackgroundDelegation): string => `${d.title}\n${d.prompt}`;

  // Same-SUBJECT grouping: semantic when embeddings are available (catches
  // paraphrases), lexical otherwise. The lexical predicate stays the per-pair
  // fallback for any text that has no embedding.
  let topicGroups: BackgroundDelegation[][];
  try {
    topicGroups = await groupByEmbedding(pendingCrossVerify, textOf, resolveGroupingEmbedFn(options), {
      lexicalFallback: sharesResearchTopic,
      cache: researchEmbeddingCache,
    });
  } catch (err) {
    logError('[BackgroundDelegations] Semantic grouping failed; using lexical grouping:', err);
    topicGroups = groupResearchByTopic(pendingCrossVerify, textOf);
  }

  const batches = researchCrossChecks.get(sessionId) ?? [];
  for (const group of topicGroups) {
    const ids = group.map((d) => d.id).sort();
    // A report already covered by an earlier pass is never re-billed.
    if (batches.some((b) => ids.every((id) => b.delegationIds.includes(id)))) continue;
    const check: ResearchCrossCheck = {
      status: 'pending',
      delegationIds: ids,
      injected: false,
      promise: Promise.resolve(),
    };
    check.promise = runResearchCrossCheck(group, options, getConfig)
      .then((result) => {
        check.status = 'done';
        check.result = result;
        log(
          `[BackgroundDelegations] Research cross-verification (${ids.length} reports): ${result.contradictions.length} contradiction(s) surfaced (${result.modelCalls} extra model call)`
        );
      })
      .catch((err) => {
        check.status = 'failed';
        logError('[BackgroundDelegations] Research cross-verification failed:', err);
      });
    batches.push(check);
  }
  if (batches.length > 0) {
    researchCrossChecks.set(sessionId, batches);
  }
}

/** Render the explicit contradiction block (empty when nothing conflicts). */
function renderResearchCrossCheckBlock(result: CrossVerificationResult): string {
  if (result.contradictions.length === 0) return '';
  const lines = result.contradictions.map((c) => {
    const rationale = c.rationale ? ` — ${c.rationale}` : '';
    return [
      `- ${c.topic}`,
      `  - ${c.sourceA}: ${c.claimA}`,
      `  - ${c.sourceB}: ${c.claimB}`,
      `  - preferred (most recent/authoritative): ${c.preferred}${rationale}`,
    ].join('\n');
  });
  return (
    '<research_cross_verification>\n' +
    'These parallel research reports were cross-checked. The following factual CONTRADICTIONS were found. ' +
    'Report them explicitly to the user — do NOT silently merge them into a single claim:\n' +
    lines.join('\n') +
    '\n</research_cross_verification>'
  );
}

/** Awaitable handle for tests; production never blocks on the cross-checks. */
export function awaitResearchCrossVerification(sessionId: string): Promise<void> {
  ensureLoaded();
  const batches = researchCrossChecks.get(sessionId) ?? [];
  return Promise.all(batches.map((b) => b.promise)).then(() => undefined);
}

/** Test/UI hook: every cross-check batch of a session (one per topic group). */
export function getResearchCrossChecks(sessionId: string): ResearchCrossCheck[] {
  ensureLoaded();
  return researchCrossChecks.get(sessionId) ?? [];
}

/** Float embedding calls issued for grouping (measurable cost, for diagnostics). */
export function getResearchEmbeddingCalls(): number {
  return researchEmbeddingCache.embedCalls;
}

/** Back-compat helper: the FIRST batch of a session, if any. */
export function getResearchCrossCheck(sessionId: string): ResearchCrossCheck | undefined {
  return getResearchCrossChecks(sessionId)[0];
}

/**
 * Consume the completed background-task reports for a session. Calling twice
 * does not duplicate: results are delivered once. When the delivered batch was
 * covered by an opt-in research cross-check, its contradiction block is
 * appended — never merged into the reports themselves.
 */
export function takePendingDelegationResults(sessionId: string): string {
  ensureLoaded();
  const queue = pendingBySession.get(sessionId);
  const checks = researchCrossChecks.get(sessionId) ?? [];
  const delivering = queue && queue.length > 0;

  const crossBlocks: string[] = [];
  let pendingCrossNote = '';
  for (const check of checks) {
    if (check.injected) continue;
    const relevant = delivering ? check.delegationIds.some((id) => queue!.includes(id)) : true;
    if (!relevant) continue;
    if (check.status === 'done' && check.result) {
      const block = renderResearchCrossCheckBlock(check.result);
      if (block) {
        crossBlocks.push(block);
      }
      check.injected = true;
    } else if (check.status === 'pending' && delivering) {
      pendingCrossNote =
        '<research_cross_verification status="pending">A cross-verification pass over these parallel reports is running; any factual contradiction will be reported on a later turn.</research_cross_verification>';
    }
  }

  if (!delivering) {
    // The batch was already delivered; only a late cross-check block can remain.
    return crossBlocks.join('\n\n');
  }
  pendingBySession.set(sessionId, []);
  const blocks: string[] = [];
  for (const id of queue!) {
    const delegation = delegations.get(id);
    if (!delegation) continue;
    delegation.delivered = true;
    const body = delegation.report
      ? formatReportForInjection(delegation.report)
      : delegation.rawResult ?? delegation.error ?? '';
    blocks.push(
      `<background_task_result id="${delegation.id}" title="${delegation.title}" role="${delegation.role}">\n` +
        truncateResult(body) +
        '\n</background_task_result>'
    );
  }
  if (blocks.length === 0 && crossBlocks.length === 0) return '';
  persist();
  const extras = [...(pendingCrossNote ? [pendingCrossNote] : []), ...crossBlocks];
  return (
    '<background_task_results>\nThe following delegated background task(s) finished while you were working. ' +
    'Summarize the outcome for the user in your reply (lead with the key finding):\n' +
    blocks.join('\n\n') +
    (extras.length ? `\n\n${extras.join('\n\n')}` : '') +
    '\n</background_task_results>'
  );
}

/** Visible marker for still-running delegations, injected at every turn. */
export function describeRunningDelegations(sessionId: string): string {
  ensureLoaded();
  const running = Array.from(delegations.values()).filter(
    (d) => d.sessionId === sessionId && d.status === 'running'
  );
  if (running.length === 0) return '';
  const lines = running
    .map((d) => `- "${d.title}" (id: ${d.id}, started ${new Date(d.startedAt).toLocaleTimeString()})`)
    .join('\n');
  return (
    '<background_tasks_running>\n' +
    'Delegated background task(s) still running for this conversation — do NOT wait for them and do NOT ' +
    'repeat their work; their results will be injected automatically at a later turn:\n' +
    lines +
    '\n</background_tasks_running>'
  );
}

/** Tracking view: all delegations (optionally one session), newest first. */
export function listDelegations(sessionId?: string): BackgroundDelegation[] {
  ensureLoaded();
  return Array.from(delegations.values())
    .filter((d) => !sessionId || d.sessionId === sessionId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function getDelegation(taskId: string): BackgroundDelegation | undefined {
  ensureLoaded();
  return delegations.get(taskId);
}

export interface DelegationStats {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  fallbacks: number;
}

/** Aggregate counters over ALL tracked delegations (any session). */
export function getDelegationStats(): DelegationStats {
  ensureLoaded();
  const all = Array.from(delegations.values());
  return {
    total: all.length,
    completed: all.filter((d) => d.status === 'completed').length,
    failed: all.filter((d) => d.status === 'failed').length,
    cancelled: all.filter((d) => d.status === 'cancelled').length,
    fallbacks: all.filter((d) => d.usedFallback).length,
  };
}

/** Whether completion notifications are enabled (renderer-sender gate). */
export function delegationNotifyEnabled(): boolean {
  ensureLoaded();
  return settings.notifyOnCompletion;
}

/** Test hook: wipe in-memory state (storage file untouched unless tmp dir). */
export function __resetDelegationsForTest(): void {
  delegations.clear();
  pendingBySession.clear();
  controllers.forEach((c) => c.abort());
  controllers.clear();
  detachedWaiters.forEach((resolve) => resolve());
  detachedWaiters.clear();
  stopDetachedPolling();
  researchCrossChecks.clear();
  researchEmbeddingCache.clear();
  settings = { ...DEFAULT_DELEGATION_SETTINGS };
  loaded = true;
}

// ─────────────────────────────────────────────────────────────────────────────
// RECURSIVE delegation — a sub-agent's own subordinate (depth + 1, hard cap 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a child delegation SYNCHRONOUSLY from a sub-agent's point of view: the
 * sub-agent waits for its subordinate's structured report (Agent Zero
 * hierarchical model) while the GLOBAL semaphore bounds the whole hierarchy.
 * The child workspace is the PARENT's cwd — same confinement perimeter.
 */
export async function runDelegationSync(options: {
  sessionId: string;
  cwd: string;
  title: string;
  prompt: string;
  role?: AgentRole;
  /** Depth of the DELEGATED child (parent depth + 1). Hard cap 2. */
  depth: number;
  parentTaskId?: string;
  getConfig?: () => StoreAppConfig;
  launchSession?: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
}): Promise<{ report: DelegationReport; raw: string }> {
  const { taskId, done } = startDelegation(options);
  await done;
  const delegation = delegations.get(taskId);
  if (!delegation) throw new Error('Delegated subtask vanished');
  if (delegation.status === 'failed') {
    throw new Error(delegation.error ?? 'Delegated subtask failed');
  }
  return {
    report: delegation.report ?? { summary: '', findings: '', assumptions: '', limits: '' },
    raw: delegation.rawResult ?? '',
  };
}

/**
 * The delegation tool placed in a sub-agent's palette when its depth is below
 * the hard cap. depth ≥ 2 agents never receive it (palette removal) AND
 * startDelegation hard-refuses deeper launches — double enforcement.
 */
export function buildSubAgentDelegationTool(context: {
  rootSessionId: string;
  cwd: string;
  /** Depth of the session this tool is being built FOR. */
  depth: number;
  parentTaskId?: string;
}): import('@mariozechner/pi-coding-agent').ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Type } = require('@sinclair/typebox') as typeof import('@sinclair/typebox');
  const childDepth = context.depth + 1;
  const allowed = childDepth <= MAX_DELEGATION_DEPTH;
  return {
    name: 'delegate_subtask',
    label: 'Delegate subtask',
    description: allowed
      ? 'Delegate ONE self-contained subtask to your own background subordinate and WAIT for its structured report. ' +
        'Use it to keep your own context focused: hand over a complete, self-sufficient brief. ' +
        'The report you receive includes the subordinate\'s summary, findings, assumptions and limits.'
      : `Delegation is unavailable: the hierarchy depth cap (${MAX_DELEGATION_DEPTH} levels) is reached. Work alone and note in your report that a subtask would have merited delegation.`,
    parameters: Type.Object({
      task: Type.String({
        description:
          'Complete, self-sufficient brief for the subordinate: goal, constraints, expected output. It cannot ask you questions.',
      }),
      title: Type.Optional(Type.String({ description: 'Short label for tracking' })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { task?: string; title?: string };
      if (!allowed) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Delegation refused: the hierarchy depth cap (${MAX_DELEGATION_DEPTH} levels) is reached. Handle this subtask yourself and note it in your report.`,
            },
          ],
          details: { refused: 'depth-cap' },
        };
      }
      if (!args.task || !args.task.trim()) {
        return {
          content: [{ type: 'text' as const, text: 'task is required to delegate a subtask.' }],
          details: {},
        };
      }
      try {
        const { report, raw } = await runDelegationSync({
          sessionId: context.rootSessionId,
          cwd: context.cwd,
          title: args.title?.trim() || args.task.trim().slice(0, 60),
          prompt: args.task.trim(),
          role: 'developer',
          depth: childDepth,
          parentTaskId: context.parentTaskId,
        });
        const text = [
          `Subordinate report (depth ${childDepth}):`,
          `Summary: ${report.summary}`,
          report.findings ? `Findings: ${report.findings}` : '',
          report.assumptions && !/^none$/i.test(report.assumptions)
            ? `Assumptions: ${report.assumptions}`
            : '',
          report.limits && !/^none$/i.test(report.limits) ? `Limits: ${report.limits}` : '',
          raw && raw !== report.summary ? raw : '',
        ]
          .filter(Boolean)
          .join('\n');
        return { content: [{ type: 'text' as const, text }], details: { report } };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Subordinate failed: ${err instanceof Error ? err.message : String(err)}. Handle it yourself or note the failure in your report.`,
            },
          ],
          details: {},
        };
      }
    },
  };
}
