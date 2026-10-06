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
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'readline';

import {
  buildChildEnv,
  parseChildMessage,
  resolveRunCodeLimits,
  DEFAULT_RUN_CODE_LIMITS,
  type RunCodeLimits,
  type RunCodeResponse,
} from './run-code-protocol';
import { invokeTool, type PrunerSettings } from '../tools/invoke';
import type { ToolContext, ToolRegistry } from '../tools/registry';
import type { ToolGateDeps } from '../tools/pipeline';
import {
  findSandboxLauncher,
  planSandbox,
  sensitiveReadPaths,
  systemWideDeniedReadPaths,
} from './run-code-sandbox';
import { startResourceWatchdog } from './run-code-watchdog';
import {
  resolveEsbuildBinary,
  resolveEsbuildMain,
  resolveEsbuildRuntimeDirs,
  resolveRunCodeChildScript,
} from './run-code-runtime';
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
  /**
   * Entry script of the child. Defaults to the bundled one; overridable so tests
   * can compile a fixture instead.
   */
  childScript?: string;
  /**
   * Directories the child must not read: credentials, keychains, app data.
   * Defaults to the standard set derived from the home directory. Narrowing this
   * widens what model-written code can read, so it is opt-in for additions only.
   */
  deniedReadPaths?: readonly string[];
  /** The app's userData directory, denied to the child: it holds API keys. */
  appDataPath?: string;
  /**
   * The home directory the sandbox closes off. Defaults to the real one.
   * Overridable so the confinement itself can be tested against a temporary
   * directory instead of the developer's actual files.
   */
  homeDir?: string;
  /**
   * Additional directories the child may read, on top of what the host already
   * reopens (node, the child script, esbuild). Occasionally a toolchain needs
   * one more place; this is how it is granted, explicitly, rather than by
   * widening the jail.
   */
  extraReadablePaths?: readonly string[];
  /**
   * Pretend to run on another platform. Production never sets this; it exists so
   * the Windows refusal — the only correct behaviour there — is exercised
   * end to end rather than asserted from the plan function alone. A refusal path
   * that is never executed is a comment, not a guarantee.
   */
  sandboxPlatform?: NodeJS.Platform;
  /**
   * Native binaries the child may exec. The child must transpile, and esbuild
   * ships as a native binary it spawns, so this is granted explicitly rather
   * than by widening process-exec.
   */
  allowedExecPaths?: readonly string[];
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
  | 'quota_exceeded'
  | 'resource_limit';

export interface RunCodeResult {
  status: RunCodeStatus;
  /** Text handed back to the model (already pruned). */
  output: string;
  error?: string;
  toolCalls: number;
  durationMs: number;
  /**
   * The V8 heap limit the child reported at startup, in bytes. Present only if
   * the child managed to send its `ready` message. A caller that cares whether
   * the memory cap was really applied reads this, not the request.
   */
  heapLimitBytes?: number;
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
 * Human-readable byte count for limit messages. Floor units, no decimals: the
 * numbers are budgets, not measurements.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} bytes`;
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let value = Math.floor(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value = Math.floor(value / 1024);
    unit += 1;
  }
  return `${value} ${units[unit]}`;
}

/**
 * Stable identity for one tool call from code, used to label the permission
 * prompt. Derived from the tool and its arguments, so two identical calls share
 * an id and a pipelined call is never labelled with another call's identity.
 */
function toolUseIdFor(toolName: string, args: Record<string, unknown>): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? {});
  } catch {
    serialized = '<unserialisable>';
  }
  let hash = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    hash = (hash * 31 + serialized.charCodeAt(index)) | 0;
  }
  return `run_code:${toolName}:${(hash >>> 0).toString(36)}`;
}

/**
 * Convert the byte budget into a V8 old-space cap in MiB.
 *
 * Clamped on both sides. The floor keeps the child from being started with a cap
 * so small that it cannot even boot Node; the ceiling stops a caller from
 * passing a huge value and quietly disabling the limit. `--max-old-space-size`
 * takes MiB, so anything under 1 MiB would round to zero and be ignored, which
 * would leave the child uncapped while appearing configured.
 */
export function heapLimitMb(maxMemoryBytes: number): number {
  const MIB = 1024 * 1024;
  if (!Number.isFinite(maxMemoryBytes) || maxMemoryBytes <= 0) {
    return Math.floor(DEFAULT_RUN_CODE_LIMITS.maxMemoryBytes / MIB);
  }
  const mb = Math.floor(maxMemoryBytes / MIB);
  return Math.min(Math.max(mb, 64), 4096);
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
  // Resolved rather than injected, so the packaged app works without every
  // caller having to know the layout. A missing child is a build problem and is
  // reported as one: degrading to some other execution path here would be the
  // worst possible response.
  const childScript = request.childScript ?? resolveRunCodeChildScript();
  if (!childScript) {
    return {
      status: 'failed',
      output: '',
      error:
        'run_code is unavailable: the child runtime was not found in this build. ' +
        'The run_code child must be built to dist-electron/run-code-child/index.js.',
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

      // The session's own rules decide first, and a refusal there is FINAL: it
      // would be wrong to ask the user to approve something the session
      // forbids, and answering 'allow' must not be able to override it.
      const base = await request.gate.decidePermission({ sessionId, toolName, args });
      if (!base.allowed) return base;

      // No handler means nobody to ask. `base` is still the real permission
      // engine, including its own 'ask' round-trip to the renderer, so this is
      // not an ungated path.
      if (!request.requestPermission) return base;

      // Model-written code calling a tool is exactly the case where a human
      // should see the prompt, so the session's handler is consulted as well.
      //
      // The tool-use id is derived from the call itself rather than a counter:
      // the child may pipeline several calls, and a counter read from shared
      // state could label one call with another's identity in the prompt the
      // user answers. Deriving it keeps the prompt honest under concurrency.
      try {
        const decision = await request.requestPermission(
          sessionId,
          toolUseIdFor(toolName, args),
          toolName,
          args
        );
        if (decision === 'deny') {
          return {
            allowed: false,
            reason:
              'Permission denied by the parent session for this run_code tool call. ' +
              'Do not retry it; ask the user instead.',
          };
        }
        return { allowed: true };
      } catch (error) {
        // Fail CLOSED. A permission handler that throws must not become an
        // accidental allow.
        return {
          allowed: false,
          reason: `The permission request failed, so the call was refused: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    },
  };

  let toolCalls = 0;
  let settled = false;
  let outputBytes = 0;
  let stdout = '';
  let failure: { status: RunCodeStatus; error: string } | null = null;
  let observedHeapLimitBytes: number | undefined;

  // The OS draws the boundary. Without this the child is a plain node process:
  // it can `import('node:fs')` and read anything the user can read, which the
  // tool gate does not govern because no `tools.*()` call is involved.
  const execPath = request.execPath ?? process.execPath;
  // The exact esbuild entry the child imports. Resolved once here so the child
  // never depends on module-resolution search under the sandbox.
  const esbuildMainPath = resolveEsbuildMain();

  // Everything the child must still read once the home directory is closed off:
  // node's own installation and the esbuild binary it spawns. Both can live inside
  // the home directory in development, so they are reopened explicitly rather
  // than left to chance.
  const runtimePaths = [
    path.dirname(execPath),
    // The child's OWN script. It lives in the build output, which is not
    // necessarily inside the session workspace, so with the home directory
    // jailed it needs reopening or the child cannot even load.
    path.dirname(childScript),
    ...(request.allowedExecPaths ?? []).map((candidate) => path.dirname(candidate)),
    // The esbuild PACKAGE as well as its binary: the child imports it, and with
    // the home directory jailed an unlisted module is simply unresolvable.
    ...resolveEsbuildRuntimeDirs(),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);

  const platform = request.sandboxPlatform ?? process.platform;
  const plan = planSandbox({
    platform,
    execPath,
    nodeArgs: [`--max-old-space-size=${heapLimitMb(limits.maxMemoryBytes)}`, childScript],
    workspace: request.cwd,
    deniedReadPaths: [
      // The whole system surface first, then the credential paths. Both were
      // verified bootable; either alone leaves real material readable.
      ...systemWideDeniedReadPaths(),
      ...(request.deniedReadPaths ?? sensitiveReadPaths(os.homedir(), request.appDataPath)),
    ],
    // The home directory is closed off wholesale. sensitiveReadPaths still covers
    // material OUTSIDE it.
    homeDir: request.homeDir ?? os.homedir(),
    readableRuntimePaths: [...runtimePaths, ...(request.extraReadablePaths ?? [])],
    // The child must transpile, and esbuild is a native binary it spawns, so
    // that exact path is granted. It is the only binary beyond node.
    allowedExecPaths:
      request.allowedExecPaths ??
      [resolveEsbuildBinary()].filter((candidate): candidate is string => candidate !== null),
    launcherPath: findSandboxLauncher(platform, existsSync),
  });
  if (!plan.supported) {
    // Fail closed. Running unsandboxed would let model-written code read any file
    // the user can read while appearing to be confined, which is worse than
    // refusing: it manufactures trust that does not exist.
    return {
      status: 'failed',
      output: '',
      error: plan.reason ?? 'run_code has no OS confinement available and was refused.',
      toolCalls: 0,
      durationMs: 0,
    };
  }

  return await new Promise<RunCodeResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        plan.command,
        // The V8 flag and the script path are already inside plan.args, after
        // the sandbox launcher. execArgv is not used: `fork()` accepts it,
        // `spawn()` does not.
        plan.args,
        {
          cwd: request.cwd,
          // Own process group, so the timeout can kill the whole tree.
          detached: true,
          // Never inherit stdio: the pipe IS the protocol.
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildChildEnv(process.env, {
            COWORK_RUN_CODE_SESSION: request.sessionId,
            // The child imports this exact file (see transpileWithEsbuild): a bare
            // specifier would make module resolution climb into unreadable
            // directories and fail with a misleading EPERM.
            ...(esbuildMainPath ? { COWORK_ESBUILD_MAIN: esbuildMainPath } : {}),
          }),
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

    const finish = (
      result: Omit<RunCodeResult, 'toolCalls' | 'durationMs' | 'heapLimitBytes'>
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watchdog?.stop();
      killProcessGroup(child);
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      resolve({
        ...result,
        toolCalls,
        durationMs: Date.now() - started,
        ...(observedHeapLimitBytes === undefined ? {} : { heapLimitBytes: observedHeapLimitBytes }),
      });
    };

    const timer = setTimeout(() => {
      finish({
        status: 'timeout',
        output: stdout,
        error: `run_code exceeded its ${limits.timeoutMs}ms time limit and the process was killed.`,
      });
    }, limits.timeoutMs);

    // Native memory and CPU time, which neither the V8 flag nor the wall clock
    // can bound. The same byte budget doubles as the RSS cap, so there is one
    // number to reason about; the CPU budget is the wall clock plus headroom for
    // legitimate multi-core work, since worker threads multiply CPU seconds.
    const watchdog =
      child.pid === undefined
        ? undefined
        : startResourceWatchdog(
            child.pid,
            {
              maxRssBytes: limits.maxMemoryBytes,
              maxCpuSeconds: Math.ceil(limits.timeoutMs / 1000) + 30,
            },
            250,
            (violation, observed) => {
              finish(
                violation === 'memory'
                  ? {
                      status: 'resource_limit',
                      output: stdout,
                      error:
                        `run_code exceeded its ${formatBytes(limits.maxMemoryBytes)} memory budget ` +
                        `(observed RSS ${formatBytes(observed)}; sampling means a fast allocator ` +
                        `overshoots before the kill) and the process was killed. ` +
                        `Allocate less, stream the data, or ask for a higher limit.`,
                    }
                  : {
                      status: 'resource_limit',
                      output: stdout,
                      error:
                        `run_code exceeded its CPU budget (${Math.ceil(limits.timeoutMs / 1000) + 30}s ` +
                        `of CPU time against a ${Math.ceil(limits.timeoutMs / 1000)}s wall clock) and ` +
                        `the process was killed. A single thread cannot outrun the wall clock, so ` +
                        `this means worker threads; use fewer of them.`,
                    }
              );
            }
          );

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
        void invokeTool(request.registry, message.tool, message.args, ctx, gate, {
          pruner: request.pruner,
        })
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

      if (message.type === 'ready') {
        // The cap is only real if the child agrees it is. Recording it makes
        // that checkable instead of assumed.
        observedHeapLimitBytes = message.heapLimitBytes;
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

    // stdin is a stream: writing to a pipe whose reader is already gone fails
    // ASYNCHRONOUSLY with EPIPE, delivered as an 'error' event rather than
    // thrown — so the try/catch around the writes below cannot see it. An
    // unhandled 'error' on a stream throws in the main process and can take
    // the app down, so it has to be caught here, before the first write.
    child.stdin?.on('error', (error: Error) => {
      logWarn('[RunCode] run_code child stdin error:', error);
      finish({
        status: 'failed',
        output: stdout,
        error: `run_code child stdin closed: ${error.message}`,
      });
    });

    // The source goes in as a single JSON line on stdin. stdin must stay OPEN:
    // the host answers the child's tool calls over the same pipe, so closing it
    // here would leave every `tools.*` call waiting forever.
    try {
      child.stdin?.write(
        JSON.stringify({ source: request.source, maxToolCalls: limits.maxToolCalls }) + '\n'
      );
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
