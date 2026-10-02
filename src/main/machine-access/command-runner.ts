/**
 * @module main/machine-access/command-runner
 *
 * Command execution (spec 6): every command is classified by assessRisk,
 * confined to granted folders, run with a scrubbed environment, a timeout, a
 * capped output, and a process GROUP that is killed on abort/emergency stop.
 *
 * No command is forbidden by principle. Dangerous/suspicious commands require
 * reinforced user approval in every autonomy level — the runner only reports
 * that an approval is required; it never approves on the user's behalf.
 */

import * as os from 'os';
import { spawn } from 'child_process';
import { assessRisk, type RiskContext } from './risk-assessor';
import { resolveSafePath } from './safe-path';
import type { AutonomyLevel, FolderGrant } from './types';

export type CommandLevel = 'lecture' | 'ecriture' | 'execution' | 'reseau' | 'dangereux' | 'suspect';

export interface CommandLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  maxProcesses: number;
}

export const DEFAULT_COMMAND_LIMITS: CommandLimits = {
  timeoutMs: 60_000,
  maxOutputBytes: 256 * 1024,
  maxProcesses: 200,
};

export interface CommandRequest {
  command: string;
  cwd?: string;
  workspaceRoot: string;
  grants?: FolderGrant[];
  autonomy?: AutonomyLevel;
  limits?: Partial<CommandLimits>;
  riskContext?: RiskContext;
  /** Extra env the caller intentionally passes (never inherits app secrets). */
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface CommandOrigin {
  /** User message, file, web page, or tool result the request came from. */
  kind: 'user-message' | 'file-content' | 'web-content' | 'tool-result';
  label?: string;
}

export interface CommandOutcome {
  level: CommandLevel;
  /** True when the user must approve before it may run (any level). */
  approvalRequired: boolean;
  reasons: string[];
  why: string;
  cwd?: string;
  /** Filled only when actually executed. */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  truncated?: boolean;
  timedOut?: boolean;
  approvalRequiredDetails?: { command: string; cwd?: string; level: CommandLevel; origin: string; reasons: string[] };
}

/** Env allow-list: PATH/HOME/TMPDIR + locale. No API keys, no tokens. */
const ENV_ALLOW = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TERM'];

export function scrubEnv(extra: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOW) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  out['WORKSPACE'] = process.cwd();
  if (platform === 'win32') out['SystemRoot'] = process.env['SystemRoot'] ?? 'C:\\Windows';
  for (const [key, value] of Object.entries(extra)) out[key] = value;
  return out;
}

/** Read-only commands need no confirmation under 'read-free'. */
export function classifyLevel(command: string): CommandLevel {
  const c = command.trim();
  if (/\b(curl|wget|nc|ssh|scp|ftp|telnet)\b/i.test(c)) return 'reseau';
  if (/\b(mkfs|dd|chown|chmod|mount|shutdown|reboot|diskutil|sudo|runas)\b/i.test(c)) return 'dangereux';
  if (/\b(rm|mv|rmdir|del|cp|mkdir|touch|tee|truncate)\b/i.test(c)) return 'ecriture';
  if (/\b(node|npm|npx|pnpm|yarn|python|pip|go|cargo|make|bash|sh|python3)\b/i.test(c)) return 'execution';
  if (/\b(ls|cat|head|tail|grep|rg|find|stat|wc|which|echo|pwd)\b/i.test(c)) return 'lecture';
  return 'execution';
}

/** Classify without executing; the UI uses this to build the confirmation card. */
export function assessCommand(request: CommandRequest, origin: CommandOrigin): CommandOutcome {
  const autonomy = request.autonomy ?? 'ask-always';
  const cwd = request.cwd ?? request.workspaceRoot;
  const resolved = resolveSafePath(cwd, {
    workspaceRoot: request.workspaceRoot,
    grants: request.grants ?? [],
    autonomy,
  });
  const level = classifyLevel(request.command);
  const riskContext: RiskContext = {
    ...request.riskContext,
    fromUntrustedContent: request.riskContext?.fromUntrustedContent ??
      (origin.kind !== 'user-message' ? true : undefined),
    untrustedSource: request.riskContext?.untrustedSource ?? origin.label,
  };
  const risk = assessRisk(
    {
      kind: 'command',
      command: request.command,
      ...(resolved.realPath ? { paths: [resolved.realPath] } : {}),
    },
    riskContext
  );

  const reasons = [...risk.reasons];
  const effectiveLevel: CommandLevel =
    risk.level === 'dangereux' ? 'dangereux' : risk.level === 'suspect' ? 'suspect' : level;

  const approvalRequired =
    risk.level !== 'ordinaire' ||
    resolved.sensitive === true ||
    resolved.ok === false ||
    autonomy === 'ask-always' ||
    (autonomy === 'read-free' && level !== 'lecture') ||
    (origin.kind !== 'user-message' && level !== 'lecture');

  return {
    level: effectiveLevel,
    approvalRequired,
    reasons,
    why: reasons.join('; ') || `classified as ${level}`,
    cwd: resolved.realPath ?? cwd,
    ...(approvalRequired
      ? {
          approvalRequiredDetails: {
            command: request.command,
            cwd: resolved.realPath ?? cwd,
            level: effectiveLevel,
            origin: `${origin.kind}${origin.label ? `: ${origin.label}` : ''}`,
            reasons,
          },
        }
      : {}),
  };
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Execute a command. Callers MUST have obtained user approval when
 * `assessCommand(...).approvalRequired` is true — this function does not
 * decide that, it only guarantees the execution bounds.
 */
export function runCommand(request: CommandRequest, outcome: CommandOutcome): Promise<ExecResult> {
  const limits = { ...DEFAULT_COMMAND_LIMITS, ...request.limits };
  const cwd = outcome.cwd ?? request.workspaceRoot;
  const start = Date.now();
  const isWindows = process.platform === 'win32';
  const shell = isWindows ? 'powershell.exe' : '/bin/bash';
  const args = isWindows ? ['-NoProfile', '-NonInteractive', '-Command', request.command] : ['-c', request.command];

  return new Promise((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      env: scrubEnv(request.env ?? {}),
      // Own process group so children die with us.
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;

    const onAbort = (): void => {
      killGroup(child.pid, isWindows);
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, isWindows);
    }, limits.timeoutMs);

    const append = (target: 'out' | 'err', chunk: Buffer): void => {
      if (bytes >= limits.maxOutputBytes) {
        truncated = true;
        return;
      }
      const room = limits.maxOutputBytes - bytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      bytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
      if (target === 'out') stdout += slice.toString('utf-8');
      else stderr += slice.toString('utf-8');
    };

    child.stdout?.on('data', (c: Buffer) => append('out', c));
    child.stderr?.on('data', (c: Buffer) => append('err', c));
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr: error.message, exitCode: 1, truncated, timedOut, durationMs: Date.now() - start });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? (timedOut ? 124 : 1),
        truncated,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}

/** Kill the whole process group; a bare child.kill() leaves grandchildren. */
export function killGroup(pid: number | undefined, isWindows = process.platform === 'win32'): void {
  if (!pid) return;
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000).unref?.();
    }
  } catch {
    /* group already gone */
  }
}

export function homeTempDir(): string {
  return os.tmpdir();
}