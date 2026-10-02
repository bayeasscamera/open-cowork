/**
 * run_code child entry point.
 *
 * A separate executable file (not a branch of the host) so the spawned process
 * is a real, inspectable `node` process with its own PID and process group —
 * which is what makes the timeout kill meaningful.
 *
 * It deliberately does NOT import the host module. The host imports the app's
 * logger, which imports Electron; bundling that into the child would make the
 * child fail to start outside an Electron runtime, and would give
 * model-written code a bundle containing host internals it has no business
 * loading. The child depends on the protocol, the child runtime and esbuild —
 * nothing else.
 */

import { createInterface } from 'readline';
import * as v8 from 'node:v8';

import { runCodeChild } from './run-code-child';

/**
 * Transpile the model's TypeScript with the esbuild the app already ships.
 *
 * The source is wrapped in an exported async function BEFORE transpiling, for
 * two reasons:
 *   - a top-level `return` is how the script yields its value, and that is
 *     illegal at the top level of an ES module, so the wrapper gives it a legal
 *     home;
 *   - `await import(...)` inside the script keeps working, because the wrapper
 *     is still a module.
 *
 * The output is CommonJS so the default export can be read back off
 * `module.exports` after a plain function evaluation.
 */
async function transpileWithEsbuild(source: string): Promise<string> {
  const { transform } = await import('esbuild');
  const wrapped = [
    'export default async function __cowork_run_code(tools) {',
    source,
    '}',
  ].join('\n');
  const result = await transform(wrapped, {
    loader: 'ts',
    format: 'cjs',
    target: 'node20',
  });
  return result.code;
}

async function main(): Promise<void> {
  // ONE reader for the whole session. Draining stdin first (e.g. with
  // `for await`) would destroy the stream, and the tool answers the host sends
  // afterwards would never arrive — so the request and the answers share a
  // single line reader, with the first line being the request.
  const rl = createInterface({ input: process.stdin });
  const queue: string[] = [];
  let notify: (() => void) | null = null;
  rl.on('line', (line) => {
    queue.push(line);
    notify?.();
    notify = null;
  });

  const firstLine = await new Promise<string | null>((resolve) => {
    if (queue.length > 0) {
      resolve(queue.shift() ?? null);
      return;
    }
    notify = () => resolve(queue.shift() ?? null);
  });

  let source = '';
  let maxToolCalls = 50;
  try {
    const parsed = JSON.parse(firstLine ?? '') as { source?: unknown; maxToolCalls?: unknown };
    source = typeof parsed.source === 'string' ? parsed.source : '';
    if (typeof parsed.maxToolCalls === 'number' && parsed.maxToolCalls > 0) {
      maxToolCalls = Math.floor(parsed.maxToolCalls);
    }
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        type: 'error',
        message: `run_code received an unreadable request: ${error instanceof Error ? error.message : String(error)}`,
      }) + '\n'
    );
    return;
  }

  await runCodeChild({
    source,
    transpile: transpileWithEsbuild,
    write: (line) => {
      process.stdout.write(line + '\n');
    },
    read: async () => {
      if (queue.length > 0) return queue.shift() ?? null;
      if (process.stdin.readableEnded) return null;
      return new Promise<string | null>((resolve) => {
        notify = () => resolve(queue.shift() ?? null);
      });
    },
    maxToolCalls,
    heapLimitBytes: () => v8.getHeapStatistics().heap_size_limit,
  });
}

void main().catch((error: unknown) => {
  // Last-resort guard: the host treats a silent child as a crash, so make the
  // failure explicit on the same channel it reads.
  process.stdout.write(
    JSON.stringify({
      type: 'error',
      message: `run_code child failed: ${error instanceof Error ? error.message : String(error)}`,
    }) + '\n'
  );
  process.exitCode = 1;
});
