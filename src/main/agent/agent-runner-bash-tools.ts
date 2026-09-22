/**
 * @module main/agent/agent-runner-bash-tools
 *
 * Bash tool wrappers extracted from CoworkAgentRunner.
 *
 * Two behaviours are injected into the SDK's bash tool:
 * - a default timeout when the model omits one;
 * - sudo interception: ask the user for a password and feed it to `sudo -S`
 *   over stdin so it never reaches process arguments or the environment.
 */

import { spawn } from 'child_process';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { log, logError } from '../utils/logger';

/** Timeout (seconds) injected when the model omits one. */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

/** Detect a sudo invocation. Word boundaries keep "visudo" out. */
export function isSudoCommand(command: string): boolean {
  return /\bsudo\b/.test(command);
}

/** Add -S to sudo invocations that do not already carry it. */
export function rewriteSudoCommand(command: string): string {
  return command.replace(/\bsudo\b(?!\s+-S)/g, 'sudo -S');
}

export interface SudoCommandSpec {
  shell: string;
  shellArgs: string[];
  password: string;
  cwd: string;
  timeoutMs: number;
}

/**
 * Run one sudo command, writing the password to stdin so it never shows up in
 * the process list. Resolves with stdout + stderr concatenated.
 */
export function runSudoCommand(spec: SudoCommandSpec): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(spec.shell, spec.shellArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: spec.cwd,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Sudo command timed out after ${spec.timeoutMs}ms`));
    }, spec.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout + stderr);
    });
    child.stdin.write(spec.password + '\n');
    child.stdin.end();
  });
}

export interface SudoWrapperOptions {
  /** Ask the user for the sudo password. Absent = wrapper disabled. */
  requestSudoPassword?: (
    sessionId: string,
    toolCallId: string,
    command: string
  ) => Promise<string | null | undefined>;
  sessionId: string;
  effectiveCwd: string;
}

/**
 * Wrap the bash tool so sudo commands prompt the user for a password and then
 * run the rewritten command with that password piped in over stdin.
 */
export function wrapBashToolForSudo(
  tools: ToolDefinition[],
  options: SudoWrapperOptions
): ToolDefinition[] {
  const { requestSudoPassword, sessionId, effectiveCwd } = options;
  if (!requestSudoPassword) return tools;

  return tools.map((tool) => {
    if (tool.name !== 'bash') return tool;

    const originalExecute = tool.execute;
    return {
      ...tool,
      execute: async (
        toolCallId: string,
        params: { command: string; timeout?: number },
        signal: AbortSignal | undefined,
        onUpdate: ((update: unknown) => void) | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx: any
      ) => {
        const command = params.command;

        if (isSudoCommand(command)) {
          log('[CoworkAgentRunner] Sudo command detected, requesting password');
          const password = await requestSudoPassword(sessionId, toolCallId, command);

          if (!password) {
            log('[CoworkAgentRunner] Sudo password cancelled by user');
            return {
              content: [
                { type: 'text' as const, text: 'Command cancelled: user denied sudo password.' },
              ],
              details: undefined as unknown,
            };
          }

          const rewrittenCommand = rewriteSudoCommand(command);

          log(
            '[CoworkAgentRunner] Executing sudo command with password injection (via stdin pipe)'
          );
          try {
            const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
            const shellArgs =
              process.platform === 'win32' ? ['/c', rewrittenCommand] : ['-c', rewrittenCommand];
            const timeoutMs = (params.timeout ?? DEFAULT_BASH_TIMEOUT_SECONDS) * 1000;
            const output = await runSudoCommand({
              shell,
              shellArgs,
              password,
              cwd: effectiveCwd,
              timeoutMs,
            });
            return {
              content: [{ type: 'text' as const, text: output || '(no output)' }],
              details: undefined as unknown,
            };
          } catch (sudoErr) {
            logError('[CoworkAgentRunner] Sudo command failed:', sudoErr);
            throw sudoErr instanceof Error ? sudoErr : new Error(String(sudoErr));
          }
        }

        return originalExecute(toolCallId, params, signal, onUpdate, ctx);
      },
    } as ToolDefinition;
  });
}

/**
 * Wrap the bash tool to inject a default timeout when the model omits one.
 * The agent SDK's bash tool has no default timeout, which means commands can
 * run indefinitely if the model does not specify one.
 */
export function wrapBashToolWithDefaultTimeout(
  tools: ToolDefinition[],
  defaultTimeoutSeconds: number = DEFAULT_BASH_TIMEOUT_SECONDS
): ToolDefinition[] {
  return tools.map((tool) => {
    if (tool.name !== 'bash') return tool;

    const originalExecute = tool.execute;
    return {
      ...tool,
      execute: async (
        toolCallId: string,
        params: { command: string; timeout?: number },
        signal: AbortSignal | undefined,
        onUpdate: ((update: unknown) => void) | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx: any
      ) => {
        const effectiveParams =
          params.timeout != null ? params : { ...params, timeout: defaultTimeoutSeconds };
        return originalExecute(toolCallId, effectiveParams, signal, onUpdate, ctx);
      },
    } as ToolDefinition;
  });
}
