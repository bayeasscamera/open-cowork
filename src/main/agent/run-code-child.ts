/**
 * @module main/agent/run-code-child
 *
 * The `run_code` child process. Model-written TypeScript runs HERE, in a
 * separate process, never in the main process.
 *
 * What the child has: the script, a `tools` proxy, and a stdin/stdout pipe.
 * What the child does NOT have: any tool implementation, any API key, and any
 * network capability beyond the tools the main process chooses to serve. Every
 * `tools.x()` becomes a JSONL request and blocks for the main process's
 * answer, so authority stays in the main process at every step.
 *
 * The compiled module is evaluated with `new Function` HERE, in the child. That
 * is deliberate and it is the only eval in the codebase. It is acceptable here
 * and nowhere else for two reasons: the child already holds no authority (no
 * tool implementation, no credential, confined by the process boundary and the
 * OS limits the parent applies), and a `vm` context would add the *appearance* of
 * isolation while still sharing the child's authority — which is worse, because
 * it invites trusting code that is not confined.
 *
 * This module must therefore stay out of the main process's import graph. It is
 * reachable only from `run-code-child-main.ts`, which nothing in `src` imports;
 * it is bundled as a separate entry point. If you ever add an import of this
 * file from the main process, the main bundle grows an eval path and the
 * "never evaluates model code in main" guarantee is gone.
 */

import { parseHostMessage, type RunCodeResponse } from './run-code-protocol';

/** Transpile TypeScript to JavaScript. Injected so the child has no build dep. */
export type Transpiler = (source: string) => Promise<string> | string;

interface RunCodeChildOptions {
  /** The model's source, TypeScript or JavaScript. */
  source: string;
  transpile: Transpiler;
  /** Emit one JSONL line. Injected for testability. */
  write: (line: string) => void;
  /** Read one JSONL line. Injected for testability. */
  read: () => Promise<string | null>;
  /**
   * The V8 heap limit actually in force for this process. Read here, in the
   * child module, because the script itself is evaluated in a `new Function`
   * body where `require` is not in scope.
   */
  heapLimitBytes: () => number;
}

/**
 * The `tools` object handed to the script. Every method:
 *   - counts against a cap (enforced here so a runaway loop cannot flood the
 *     pipe even before the host's own counter sees it),
 *   - sends a request,
 *   - and resolves with the host's answer.
 *
 * A tool the host refuses comes back as a rejected promise with the host's
 * reason, so the script can adapt rather than seeing a silent `undefined`.
 */
function createToolsProxy(
  limits: { maxToolCalls: number },
  write: (line: string) => void,
  read: () => Promise<string | null>,
  state: { calls: number }
): Record<string, (args?: unknown) => Promise<unknown>> {
  return new Proxy(
    {},
    {
      get(_target, property: string) {
        if (typeof property !== 'string') return undefined;
        return async (args?: unknown): Promise<unknown> => {
          state.calls += 1;
          if (state.calls > limits.maxToolCalls) {
            throw new Error(
              `run_code exceeded the maximum of ${limits.maxToolCalls} tool calls for this execution.`
            );
          }
          const id = state.calls - 1;
          write(JSON.stringify({ type: 'tool_call', id, tool: property, args }));

          // Wait for the matching answer. Stray or out-of-order lines are
          // ignored rather than desynchronising the stream; a host that closes
          // the pipe without answering is an error, not a silent success.
          for (;;) {
            const line = await read();
            if (line === null) {
              throw new Error('run_code host closed the connection before answering.');
            }
            const response = parseHostMessage(line);
            if (!response || response.id !== id) continue;
            if (response.isError) {
              throw new Error(response.content);
            }
            return response.content;
          }
        };
      },
    }
  ) as Record<string, (args?: unknown) => Promise<unknown>>;
}

/**
 * Run one script to completion inside this process.
 *
 * Emits exactly one terminal message (`done` or `error`). Never throws: a
 * script that dies must still produce a message the host can report, because
 * the host is waiting on stdout to settle.
 */
export async function runCodeChild(options: RunCodeChildOptions & {
  maxToolCalls: number;
}): Promise<void> {
  const { source, transpile, write, read, maxToolCalls, heapLimitBytes } = options;

  // Report the real limit first, so the host can prove the cap was applied
  // rather than merely intended.
  try {
    write(JSON.stringify({ type: 'ready', heapLimitBytes: heapLimitBytes() }));
  } catch {
    // A failure to self-report must not stop the run; the host treats `ready`
    // as optional.
  }

  let compiled: string;
  try {
    compiled = await transpile(source);
  } catch (error) {
    write(
      JSON.stringify({
        type: 'error',
        message: `TypeScript compilation failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    );
    return;
  }

  const state = { calls: 0 };
  const tools = createToolsProxy({ maxToolCalls }, write, read, state);

  try {
    // The compiled module is evaluated HERE, inside the child process. The
    // main process never evaluates a line of the model's source.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const evaluate = new Function('module', 'exports', compiled) as (
      m: { exports: Record<string, unknown> },
      e: Record<string, unknown>
    ) => void;
    const moduleShim: { exports: Record<string, unknown> } = { exports: {} };
    evaluate(moduleShim, moduleShim.exports);

    const entry = moduleShim.exports.default ?? moduleShim.exports;
    if (typeof entry !== 'function') {
      throw new Error('The compiled script did not produce a callable entry point.');
    }
    const value = await (entry as (t: unknown) => Promise<unknown>)(tools);
    write(JSON.stringify({ type: 'done', value: safeSerialize(value) }));
  } catch (error) {
    write(
      JSON.stringify({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      })
    );
  }
}

/** JSON-serialise a script result, tolerating cycles and BigInt. */
function safeSerialize(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_key, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return '[function]';
      if (typeof val === 'undefined') return null;
      return val;
    }));
  } catch {
    return String(value);
  }
}

/** Re-exported so the host can type its side of the exchange. */
export type { RunCodeResponse };
