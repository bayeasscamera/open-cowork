/**
 * @module main/agent/detached-delegation
 *
 * Launch a background delegation as a REAL detached process, so it survives the
 * app quitting. The process is the app itself in headless single-shot mode
 * (--headless --mode json -p <brief>) and writes two files:
 *
 *   - <userData>/delegations/<id>.jsonl       the JSONL event stream (progress)
 *   - <userData>/delegations/<id>.result.json an atomic outcome record
 *
 * The parent never keeps a pipe: it can therefore be restarted and still read
 * the outcome after the fact. Everything here is pure Node — the only Electron
 * assumption is that the caller passes the right executable/app path.
 *
 * Safety: the brief is passed as ONE argv element (no shell, no interpolation),
 * and the child answers permission requests deny-by-default unless the user
 * explicitly enabled auto-approval in the delegation settings.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DETACHED_RESULT_SCHEMA_VERSION } from '../../shared/detached-delegation-protocol';

/** How often the parent looks for a finished detached task. */
export const DETACHED_POLL_INTERVAL_MS = 3_000;

/** Grace period before a detached task that ignored SIGTERM is killed. */
export const DETACHED_TERMINATE_GRACE_MS = 5_000;

export interface DetachedLaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  resultFile: string;
  logFile: string;
}

export interface BuildDetachedPlanOptions {
  /** process.execPath of the running app. */
  execPath: string;
  /**
   * App path to prepend in development, where process.execPath is the Electron
   * binary and the app directory must be passed as the first argument.
   */
  appPath?: string;
  /** The full autonomous brief (already wrapped by buildAutonomousPrompt). */
  prompt: string;
  /** Workspace the detached agent is confined to. */
  cwd: string;
  /** Approve every tool in the child (opt-in; deny-by-default otherwise). */
  autoApprove?: boolean;
  resultFile: string;
  logFile: string;
  /** Base environment; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Delegation id, exposed to the child only for observability. */
  delegationId?: string;
}

/**
 * Build the argv for the detached child. Kept pure (no spawn) so it is fully
 * testable: the brief is a single argv element, never interpolated in a shell.
 */
export function buildDetachedLaunchPlan(options: BuildDetachedPlanOptions): DetachedLaunchPlan {
  const args: string[] = [];
  if (options.appPath) args.push(options.appPath);
  args.push('--headless', '--mode', 'json', '--cwd', options.cwd, '-p', options.prompt);
  args.push('--result-file', options.resultFile);
  if (options.autoApprove) args.push('--auto-approve');

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  // A detached delegation is a second instance BY DESIGN: without this the
  // single-instance lock makes the child quit before doing any work.
  env.COWORK_MULTI_INSTANCE = '1';
  if (options.delegationId) env.COWORK_DETACHED_DELEGATION_ID = options.delegationId;

  return {
    command: options.execPath,
    args,
    cwd: options.cwd,
    env,
    resultFile: options.resultFile,
    logFile: options.logFile,
  };
}

export interface DetachedResult {
  status: 'completed' | 'failed';
  output?: string;
  error?: string;
  sessionId?: string;
  finishedAt?: number;
}

/** Validate an on-disk result payload; null when it is not a usable record. */
export function parseDetachedResult(raw: unknown): DetachedResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== undefined && r.schemaVersion !== DETACHED_RESULT_SCHEMA_VERSION) {
    return null;
  }
  const status = r.status === 'completed' ? 'completed' : r.status === 'failed' ? 'failed' : null;
  if (!status) return null;
  return {
    status,
    ...(typeof r.output === 'string' ? { output: r.output } : {}),
    ...(typeof r.error === 'string' ? { error: r.error } : {}),
    ...(typeof r.sessionId === 'string' ? { sessionId: r.sessionId } : {}),
    ...(typeof r.finishedAt === 'number' ? { finishedAt: r.finishedAt } : {}),
  };
}

/** Read a finished detached task result file; null when absent or unusable. */
export function readDetachedResult(file: string): DetachedResult | null {
  try {
    if (!fs.existsSync(file)) return null;
    return parseDetachedResult(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    // A half-written file is transient: the writer renames atomically.
    return null;
  }
}

/** Liveness probe that never throws (EPERM means alive but not signalable). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Terminate a detached delegation AND its process group. The child is spawned
 * detached, so it leads its own group: a negative pid reaches the whole tree
 * (helpers it spawned included) instead of orphaning them.
 */
export function killDetachedTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Not a group leader (or already gone): fall back to the single pid.
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

export interface LogTail {
  lines: string[];
  offset: number;
}

/** Read the JSONL lines appended to a detached task log since `offset`. */
export function readNewLogLines(file: string, offset: number): LogTail {
  try {
    if (!fs.existsSync(file)) return { lines: [], offset };
    const size = fs.statSync(file).size;
    // The file may have been truncated by a rotation: restart from zero.
    const start = size < offset || offset < 0 ? 0 : offset;
    if (size <= start) return { lines: [], offset: start };
    const fd = fs.openSync(file, 'r');
    try {
      const length = size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return {
        lines: buffer
          .toString('utf-8')
          .split('\n')
          .filter((line) => line.trim().length > 0),
        offset: size,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], offset };
  }
}

/**
 * Map one JSONL event to a short progress line. Returns null for events that
 * say nothing useful (partial deltas, heartbeats, unknown types).
 */
export function describeDetachedEvent(line: string): string | null {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!event || typeof event.type !== 'string') return null;
  switch (event.type) {
    case 'trace.step': {
      const title = typeof event.title === 'string' ? event.title : 'step';
      const tool =
        typeof event.toolName === 'string' && event.toolName ? ' (' + event.toolName + ')' : '';
      return 'Tool: ' + title + tool;
    }
    case 'session.status':
      return typeof event.status === 'string' ? 'Session ' + event.status : null;
    case 'error':
      return typeof event.message === 'string' ? 'Error: ' + event.message : null;
    case 'session.ended':
      return 'Detached process finished the task';
    default:
      return null;
  }
}

export interface DetachedSpawnOptions {
  cwd: string;
  detached: boolean;
  stdio: ['ignore', number, number];
  env: Record<string, string>;
}

export interface DetachedChild {
  pid?: number;
  unref?: () => void;
}

/** Injectable spawn signature so tests never launch a real Electron process. */
export type DetachedSpawnFn = (
  command: string,
  args: string[],
  options: DetachedSpawnOptions
) => DetachedChild;

const defaultSpawn = spawn as unknown as DetachedSpawnFn;

/** A launcher takes the built plan and returns the child pid (0 = failed). */
export type DetachedLauncher = (plan: DetachedLaunchPlan) => { pid: number };

/**
 * Spawn the detached child, appending its stdout and stderr to the task log.
 * The parent closes its own copy of the descriptor immediately and unrefs the
 * child, so the app can quit without waiting for it.
 */
export function spawnDetachedDelegation(
  plan: DetachedLaunchPlan,
  spawnFn: DetachedSpawnFn = defaultSpawn
): { pid: number } {
  fs.mkdirSync(path.dirname(plan.logFile), { recursive: true });
  const out = fs.openSync(plan.logFile, 'a');
  try {
    const child = spawnFn(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: ['ignore', out, out],
      env: plan.env,
    });
    child.unref?.();
    return { pid: typeof child.pid === 'number' ? child.pid : 0 };
  } finally {
    fs.closeSync(out);
  }
}
