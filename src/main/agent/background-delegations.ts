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
import {
  createSwarmRunner,
  type SubAgentSessionArgs,
  type SubAgentSessionResult,
  type SubAgentToolStep,
} from './swarm-runner';
import { sendToRenderer } from '../events/renderer-sender';
import { log, logError, logWarn } from '../utils/logger';
import type { ServerEvent } from '../../shared/types';
import { configStore, type AppConfig as StoreAppConfig } from '../config/config-store';

/** Injected result text is capped so a huge research cannot flood the turn. */
const MAX_INJECTED_RESULT_CHARS = 12_000;
const MAX_PERSISTED_RESULT_CHARS = 20_000;
const MAX_LOG_STEPS = 40;
const MAX_TRACKED_TASKS = 60;

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
  report?: DelegationReport;
  rawResult?: string;
  error?: string;
  modifiedFiles?: string[];
  delivered: boolean;
  log: DelegationLogEntry[];
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
}

export const DEFAULT_DELEGATION_SETTINGS: DelegationSettings = {
  configSetId: '',
  modelId: undefined,
  timeoutMs: 180_000,
  maxConcurrent: 2,
  notifyOnCompletion: true,
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
    for (const item of raw) {
      // Sub-agent sessions die with the app: anything still "running" was
      // interrupted by the restart.
      if (item.status === 'running') {
        item.status = 'failed';
        item.error = 'Interrupted by app restart';
        item.completedAt = Date.now();
      }
      if (!Array.isArray(item.log)) item.log = [];
      delegations.set(item.id, item);
      if (item.status === 'completed' && !item.delivered) {
        enqueuePending(item.id);
      }
    }
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
  /** Workspace the background sub-agent is confined to. */
  cwd: string;
  title: string;
  prompt: string;
  role?: AgentRole;
  /** Config source override (tests); defaults to the app config store. */
  getConfig?: () => StoreAppConfig;
  /** Session launcher override (tests): inject a fake sub-agent session. */
  launchSession?: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
}

/**
 * Launch a background sub-agent and return its task id IMMEDIATELY. The
 * returned object is available before the sub-agent finishes — the caller
 * (tool) must not await the sub-agent's completion.
 */
export function startDelegation(options: StartDelegationOptions): { taskId: string } {
  ensureLoaded();

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
    status: 'running',
    startedAt: Date.now(),
    delivered: false,
    log: [],
  };
  delegations.set(id, delegation);
  pushLog(delegation, 'launched', `Task delegated (role: ${role})`);
  persist();

  const controller = new AbortController();
  controllers.set(id, controller);

  launchBackgroundTask(id, delegation, options);
  emit(delegation, 'status');
  return { taskId: id };
}

export class DelegationCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegationCapacityError';
  }
}

function launchBackgroundTask(
  id: string,
  delegation: BackgroundDelegation,
  options: StartDelegationOptions
): void {
  const task: AgentTask = {
    id,
    role: delegation.role,
    title: delegation.title,
    prompt: buildAutonomousPrompt(delegation.prompt),
    status: 'pending',
  };

  // Same runner as the swarm (per-role profile, confinement, idle timeout,
  // fallback) — with the delegation-specific cap, timeout, cancel signal and
  // a live progress hook feeding the tracking view.
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
    taskExtras?: (t: AgentTask) => {
      signal?: AbortSignal;
      onEvent?: (step: SubAgentToolStep) => void;
    };
  } = {
    cwd: options.cwd,
    maxConcurrentOverride: settings.maxConcurrent,
    timeoutMsOverride: settings.timeoutMs,
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

  void runner(task, 'Background delegation — work autonomously; see the report contract in the task.')
    .then((run) => {
      controllers.delete(id);
      const current = delegations.get(id);
      if (!current) return;
      // Cancelled during finalize: do not resurrect as completed.
      if (current.status === 'cancelled') return;
      current.status = 'completed';
      current.completedAt = Date.now();
      current.modelUsed = run.modelUsed;
      current.modifiedFiles = run.modifiedFiles;
      current.rawResult = run.output;
      current.report = parseDelegationReport(run.output);
      pushLog(current, 'completed', current.report.summary.slice(0, 120));
      enqueuePending(id);
      persist();
      log(`[BackgroundDelegations] Task ${id} (${current.title}) completed`);
      emit(current, 'status', current.report.summary.slice(0, 200));
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
  const controller = controllers.get(taskId);
  if (controller) {
    controller.abort();
    controllers.delete(taskId);
  }
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

/** Remove a FINISHED task from the tracking history (never a running one). */
export function deleteDelegation(taskId: string): boolean {
  ensureLoaded();
  const delegation = delegations.get(taskId);
  if (!delegation || delegation.status === 'running') return false;
  delegations.delete(taskId);
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
 * Consume the completed background-task reports for a session. Calling twice
 * does not duplicate: results are delivered once.
 */
export function takePendingDelegationResults(sessionId: string): string {
  ensureLoaded();
  const queue = pendingBySession.get(sessionId);
  if (!queue || queue.length === 0) return '';
  pendingBySession.set(sessionId, []);
  const blocks: string[] = [];
  for (const id of queue) {
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
  if (blocks.length === 0) return '';
  persist();
  return (
    '<background_task_results>\nThe following delegated background task(s) finished while you were working. ' +
    'Summarize the outcome for the user in your reply (lead with the key finding):\n' +
    blocks.join('\n\n') +
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
  settings = { ...DEFAULT_DELEGATION_SETTINGS };
  loaded = true;
}