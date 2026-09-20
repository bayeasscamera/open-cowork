/**
 * @module main/agent/background-delegations
 *
 * Asynchronous delegation: the main agent hands ONE autonomous task (typically
 * a web research) to a background sub-agent and keeps working in the same
 * session. The sub-agent runs fire-and-forget with the SAME guardrails as the
 * synchronous swarm (per-role model resolution, workspace confinement, idle
 * timeout, fallback) because it runs through createSwarmRunner — only the
 * waiting is different.
 *
 * Lifecycle:
 *   delegate_background_task tool → startDelegation() returns a task id
 *   immediately (non-blocking) → the sub-agent session runs in the background
 *   → on completion the result is queued for the session → at the user's NEXT
 *   turn the agent-runner injects it as a <background_task_results> block
 *   (see takePendingDelegationResults) and lists still-running tasks
 *   (describeRunningDelegations). While running, the renderer shows a badge
 *   fed by 'background.task' events, and a native notification fires on
 *   completion when the app is unfocused (renderer-sender).
 *
 * Note on BackgroundJobRegistry: that registry tracks SPAWNED PROCESSES
 * (dev servers, daemons — pid/log/exit). Delegated sub-agents are in-process
 * sessions, so a dedicated registry is used instead; it reuses the same
 * atomic-JSON persistence pattern for status durability across restarts.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { AgentTask, AgentRole, SubAgentRunnerFn } from './multi-agent-coordinator';
import {
  createSwarmRunner,
  type SubAgentSessionArgs,
  type SubAgentSessionResult,
} from './swarm-runner';
import { sendToRenderer } from '../events/renderer-sender';
import { log, logError, logWarn } from '../utils/logger';
import type { ServerEvent } from '../../shared/types';
import type { AppConfig as StoreAppConfig } from '../config/config-store';

/** Injected result text is capped so a huge research cannot flood the turn. */
const MAX_INJECTED_RESULT_CHARS = 12_000;
const MAX_PERSISTED_RESULT_CHARS = 20_000;

export type DelegationStatus = 'running' | 'completed' | 'failed';

export interface BackgroundDelegation {
  id: string;
  sessionId: string;
  title: string;
  prompt: string;
  role: AgentRole;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  /** Completed results are injected into the session exactly once. */
  delivered: boolean;
}

const delegations = new Map<string, BackgroundDelegation>();
/** FIFO of delegation ids with undelivered results, per session. */
const pendingBySession = new Map<string, string[]>();
let storageFile: string | null = null;
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
  return storageFile;
}

/** Test/optional hook: pin the storage location before first use. */
export function initBackgroundDelegations(userDataDir: string): void {
  storageFile = path.join(userDataDir, 'background_delegations.json');
  loadPersisted();
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  loadPersisted();
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
      delegations.set(item.id, item);
      if (item.status === 'completed' && !item.delivered && item.result) {
        enqueuePending(item.id);
      }
    }
  } catch (err) {
    logError('[BackgroundDelegations] Failed to load persisted state:', err);
  }
}

function persist(): void {
  const file = resolveStorageFile();
  try {
    const serialized = Array.from(delegations.values()).slice(-50).map((d) => ({
      ...d,
      result: d.result?.slice(0, MAX_PERSISTED_RESULT_CHARS),
    }));
    const tmp = `${file}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(serialized, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    logError('[BackgroundDelegations] Failed to persist state:', err);
  }
}

function enqueuePending(delegationId: string): void {
  const delegation = delegations.get(delegationId);
  if (!delegation) return;
  const queue = pendingBySession.get(delegation.sessionId) ?? [];
  if (!queue.includes(delegationId)) queue.push(delegationId);
  pendingBySession.set(delegation.sessionId, queue);
}

function emit(delegation: BackgroundDelegation, summary?: string): void {
  const event: ServerEvent = {
    type: 'background.task',
    payload: {
      sessionId: delegation.sessionId,
      taskId: delegation.id,
      title: delegation.title,
      status: delegation.status,
      summary,
      error: delegation.error,
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
  const role: AgentRole = options.role ?? 'developer';
  const id = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const delegation: BackgroundDelegation = {
    id,
    sessionId: options.sessionId,
    title: options.title,
    prompt: options.prompt,
    role,
    status: 'running',
    startedAt: Date.now(),
    delivered: false,
  };
  delegations.set(id, delegation);
  persist();

  const task: AgentTask = {
    id,
    role,
    title: options.title,
    prompt: options.prompt,
    status: 'pending',
  };

  // Same runner as the synchronous swarm: per-role model resolution,
  // workspace confinement, per-task timeout, one-shot fallback. Only the
  // await is dropped — the promise chain reports the outcome when it lands.
  const runnerOptions: {
    cwd: string;
    getConfig?: () => StoreAppConfig;
    launchSession?: (args: SubAgentSessionArgs) => Promise<SubAgentSessionResult>;
  } = { cwd: options.cwd };
  if (options.getConfig) runnerOptions.getConfig = options.getConfig;
  if (options.launchSession) runnerOptions.launchSession = options.launchSession;
  const runner: SubAgentRunnerFn = createSwarmRunner(runnerOptions);

  void runner(task, 'Background delegation — work autonomously and report the result.')
    .then((run) => {
      const current = delegations.get(id);
      if (!current) return;
      current.status = 'completed';
      current.completedAt = Date.now();
      current.result = run.output;
      enqueuePending(id);
      persist();
      log(`[BackgroundDelegations] Task ${id} (${current.title}) completed`);
      emit(current, run.output.slice(0, 200));
    })
    .catch((err: unknown) => {
      const current = delegations.get(id);
      if (!current) return;
      current.status = 'failed';
      current.completedAt = Date.now();
      current.error = err instanceof Error ? err.message : String(err);
      // A failure notice is queued too: the main agent must learn the task
      // failed instead of silently waiting forever.
      current.result = `La tâche déléguée a échoué : ${current.error}`;
      enqueuePending(id);
      persist();
      logError(`[BackgroundDelegations] Task ${id} (${current.title}) failed:`, err);
      emit(current);
    });

  emit(delegation);
  return { taskId: id };
}

function truncateResult(text: string): string {
  if (text.length <= MAX_INJECTED_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_INJECTED_RESULT_CHARS)}\n… [résultat tronqué aux premiers ${MAX_INJECTED_RESULT_CHARS} caractères]`;
}

/**
 * Consume the completed background-task results for a session. Returns a
 * clearly-marked block to append to the user's turn (or '' when nothing is
 * pending). Calling twice does not duplicate: results are delivered once.
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
    blocks.push(
      `<background_task_result id="${delegation.id}" title="${delegation.title}" role="${delegation.role}">\n` +
        truncateResult(delegation.result ?? delegation.error ?? '') +
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

/** All delegations of a session, newest first (status tool). */
export function listDelegations(sessionId: string): BackgroundDelegation[] {
  ensureLoaded();
  return Array.from(delegations.values())
    .filter((d) => d.sessionId === sessionId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** Test hook: wipe in-memory state (storage file untouched unless tmp dir). */
export function __resetDelegationsForTest(): void {
  delegations.clear();
  pendingBySession.clear();
  loaded = true;
}