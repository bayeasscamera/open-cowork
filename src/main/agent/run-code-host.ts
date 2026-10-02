/**
 * @module main/agent/run-code-host
 *
 * Main-process side of `run_code`. Owns the child process and every limit.
 *
 * Design constraints this module exists to enforce:
 *
 *   - The script runs in a CHILD PROCESS. The main process spawns it, watches
 *     it, and kills it; it never evaluates a line of it.
 *   - The whole PROCESS GROUP is killed on timeout, not just the direct child,
 *     so a script that spawned its own subprocess cannot outlive the limit.
 *   - Every `tools.*` call is re-gated through `invokeTool()`, so a call made
 *     from code is subject to the same preset, permission, path-guard and mods
 *     checks as a direct call. A code path can never obtain a capability a
 *     direct tool call could not.
 *   - Approvals are the SESSION's. `detachedAutoApprove` is deliberately NOT
 *     consulted: that flag exists for unattended background delegations, and
 *     inheriting it would let model-written code run unattended.
 *   - The child's environment is stripped of anything secret.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as readline from 'readline';

import {
  buildChildEnv,
  parseChildMessage,
  resolveRunCodeLimits,
  type RunCodeLimits,
  type RunCodeResponse,
} from './run-code-protocol';
import { invokeTool, type PrunerSettings } from '../tools/invoke';
import type { ToolContext, ToolRegistry } from '../tools/registry';
import type { ToolGateDeps } from '../tools/pipeline';
import { logWarn } from '../utils/logger';

export interface RunCodeRequest {
  /** Model-written TypeScript. */
  source: string;
  sessionId: string;
  /** Workspace root; also the child's cwd, and the path-guard target. */
  cwd: string;
  registry: ToolRegistry;
  gate: ToolGateDeps;
  /** Preset allow-list. A call outside it is refused, in code as in direct mode. */
  allowedTools: readonly string[];
  /** Preset pruner, applied to the output before it reaches the model. */
  pruner?: PrunerSettings;
  limits?: Partial<RunCodeLimits>;
  /** Node binary to spawn. Overridable for tests. */
  execPath?: string;
  /** Entry script of the child. Overridable for tests. */
  childScript?: string;
  /** Approval handler for tools the session must ask about. */
  requestPermission?: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>
  ) => Promise<'allow' | 'deny' | 'allow_always'>;
}

export type RunCodeStatus =
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'tool_limit'
  | 'quota_exceeded';

export interface RunCodeResult {
  status: RunCodeStatus;
  /** Text handed back to the model (already pruned). */
  output: string;
  error?: string;
  toolCalls: number;
  durationMs: number;
}

/**
 * Guard the child with a hard timeout, killing the whole process GROUP.
 *
 * `detached: true` puts the child in its own process group, and a negative pid
 * signals the group. Killing only the direct child would leave any subprocess
 * the script spawned running past the limit, holding the port/files it grabbed.
 */
function killProcessGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    // Negative pid = the whole group. ESRCH simply means it already exited.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Nothing left to kill.
    }
  }
}

/**
 * Execute model-written code in a child process.
 *
 * Resolves rather than throws for every expected failure (timeout, quota, tool
 * refusal, child crash): the caller needs a message it can show the model, and
 * a thrown error here would be indistinguishable from a host bug.
 */
export async function runCode(request: RunCodeRequest): Promise<RunCodeResult> {
  const started = Date.now();
  const limits = resolveRunCodeLimits(request.limits);

  // Transpile in the main process? NO — the source is untrusted, and even
  // parsing it here would be work on model-written input inside the main
  // process. The child transpiles its own input.
  const childScript = request.childScript;
  if (!childScript) {
    return {
      status: 'failed',
      output: '',
      error: 'run_code is unavailable: no child runtime is configured.',
      toolCalls: 0,
      durationMs: 0,
    };
  }

  const gate: ToolGateDeps = {
    // The preset allow-list is enforced here AND in the pipeline: a tool the
    // preset does not allow is refused in code exactly as it is in direct mode.
    ...request.gate,
    allowedTools: request.allowedTools,
    decidePermission: async (input: {
      sessionId: string;
      toolName: string;
      args: Record<string, unknown>;
    }) => {
      const { sessionId, toolName, args } = input;
      if (!request.requestPermission) {
        return request.gate.decidePermission({ sessionId, toolName, args });
      }
      const base = await request.gate.decidePermission({ sessionId, toolName, args });
      if (!base.allowed) return base;
      return { allowed: true };
    },
  };

  let toolCalls = 0;
  let settled = false;
  let outputBytes = 0;
  let stdout = '';
  let failure: { status: RunCodeStatus; error: string } | null = null;

  return await new Promise<RunCodeResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        request.execPath ?? process.execPath,
        [childScript],
        {
          cwd: request.cwd,
          // Own process group, so the timeout can kill the whole tree.
          detached: true,
          // Never inherit stdio: the pipe IS the protocol.
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildChildEnv(process.env, { COWORK_RUN_CODE_SESSION: request.sessionId }),
        }
      );
    } catch (error) {
      resolve({
        status: 'failed',
        output: '',
        error: `Could not start the run_code child: ${error instanceof Error ? error.message : String(error)}`,
        toolCalls: 0,
        durationMs: Date.now() - started,
      });
      return;
    }

    const finish = (result: Omit<RunCodeResult, 'toolCalls' | 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killProcessGroup(child);
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      resolve({ ...result, toolCalls, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      finish({
        status: 'timeout',
        output: stdout,
        error: `run_code exceeded its ${limits.timeoutMs}ms time limit and the process was killed.`,
      });
    }, limits.timeoutMs);

    /** Pending tool calls, keyed by the child's correlation id. */
    const pending = new Map<number, (response: RunCodeResponse) => void>();

    const reader = readline.createInterface({ input: child.stdout! });
    reader.on('line', (line) => {
      const message = parseChildMessage(line);
      if (!message) return;

      if (message.type === 'tool_call') {
        outputBytes += line.length + 1;
        if (outputBytes > limits.maxOutputBytes) {
          failure = {
            status: 'quota_exceeded',
            error: `run_code produced more than ${limits.maxOutputBytes} bytes of protocol traffic.`,
          };
          finish({ status: 'quota_exceeded', output: stdout, error: failure.error });
          return;
        }

        toolCalls += 1;
        if (toolCalls > limits.maxToolCalls) {
          finish({
            status: 'tool_limit',
            output: stdout,
            error: `run_code exceeded the maximum of ${limits.maxToolCalls} tool calls for this execution.`,
          });
          return;
        }

        const ctx: ToolContext = { sessionId: request.sessionId, cwd: request.cwd };
        void invokeTool(
          request.registry,
          message.tool,
          message.args,
          ctx,
          gate,
          { pruner: request.pruner }
        )
          .then((result) => {
            const content = result.content.slice(0, limits.maxToolResultChars);
            const response: RunCodeResponse = {
              type: 'tool_result',
              id: message.id,
              content,
              ...(result.isError ? { isError: true } : {}),
            };
            writeToChild(child, response);
            pending.get(message.id)?.(response);
            pending.delete(message.id);
          })
          .catch((error: unknown) => {
            // A throwing tool is a real failure, not a protocol problem.
            finish({
              status: 'failed',
              output: stdout,
              error: `Tool '${message.tool}' failed: ${error instanceof Error ? error.message : String(error)}`,
            });
          });
        return;
      }

      if (message.type === 'done') {
        const value =
          message.value === null || message.value === undefined
            ? ''
            : typeof message.value === 'string'
              ? message.value
              : JSON.stringify(message.value, null, 2);
        if (message.stdout) stdout += `${message.stdout}\n`;
        finish({ status: 'completed', output: `${stdout}${value}`.trim() });
        return;
      }

      if (message.type === 'error') {
        // The child enforces its own copy of the call quota, and it trips
        // first. Classify it back to `tool_limit` so the caller sees one
        // stable reason for hitting the budget, whichever side noticed.
        const isQuota = /exceeded the maximum of \d+ tool calls/i.test(message.message);
        finish({
          status: isQuota ? 'tool_limit' : 'failed',
          output: stdout,
          error: message.message,
        });
      }
    });

    // A child that dies on its own must settle the promise, or the caller
    // waits for the timeout even though there is nothing left to wait for.
    child.on('error', (error) => {
      finish({ status: 'failed', output: stdout, error: `run_code child error: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      finish({
        status: 'failed',
        output: stdout,
        error: `run_code child stopped unexpectedly (${how}).`,
      });
    });

    // The source goes in as a single JSON line on stdin. stdin must stay OPEN:
    // the host answers the child's tool calls over the same pipe, so closing it
    // here would leave every `tools.*` call waiting forever.
    try {
      child.stdin?.write(JSON.stringify({ source: request.source, maxToolCalls: limits.maxToolCalls }) + '\n');
    } catch (error) {
      finish({
        status: 'failed',
        output: '',
        error: `Could not send the script to the run_code child: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

/** Write one JSONL response to the child's stdin, tolerating a closed pipe. */
function writeToChild(child: ChildProcess, response: RunCodeResponse): void {
  try {
    child.stdin?.write(JSON.stringify(response) + '\n');
  } catch (error) {
    logWarn('[RunCode] Could not write a tool result to the child:', error);
  }
}
