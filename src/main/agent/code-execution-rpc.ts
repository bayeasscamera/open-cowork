/**
 * @module main/agent/code-execution-rpc
 *
 * Zero-Context Multi-Step Tool Pipeline & RPC Engine (Hermes-inspired).
 *
 * Instead of wasting 10-20 turns of LLM back-and-forth for data transformation,
 * batch analysis, or multi-step tool calls, the model can emit a script that
 * executes in a local environment and invokes agent tools through an in-memory
 * or IPC RPC bridge.
 */

import { logError } from '../utils/logger';

export type ToolExecutorFn = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RpcExecutionOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface RpcExecutionResult {
  success: boolean;
  result?: unknown;
  stdout: string;
  error?: string;
  toolCallCount: number;
}

export class CodeExecutionRpcBridge {
  private toolExecutor: ToolExecutorFn;

  constructor(toolExecutor: ToolExecutorFn) {
    this.toolExecutor = toolExecutor;
  }

  /**
   * Execute an asynchronous JavaScript/TypeScript function that has access
   * to a injected `tools` client.
   *
   * Example script:
   * ```javascript
   * async (tools) => {
   *   const files = await tools.call('list_dir', { path: '.' });
   *   const tsFiles = files.filter(f => f.endsWith('.ts'));
   *   return { count: tsFiles.length, files: tsFiles.slice(0, 5) };
   * }
   * ```
   */
  async executeScript(
    scriptBody: string,
    options: RpcExecutionOptions = {}
  ): Promise<RpcExecutionResult> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const maxOutputChars = options.maxOutputChars ?? 50000;
    const stdoutLogs: string[] = [];
    let toolCallCount = 0;

    const toolsClient = {
      call: async (toolName: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        toolCallCount++;
        stdoutLogs.push(`[RPC CALL] ${toolName}(${JSON.stringify(args).slice(0, 120)})`);
        return await this.toolExecutor(toolName, args);
      },
      log: (...args: unknown[]): void => {
        const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        stdoutLogs.push(line);
      },
    };

    try {
      // Evaluate script inside an isolated async function wrapper
      // Clean script if wrapped with async (tools) => or plain code
      let normalizedScript = scriptBody.trim();
      if (!normalizedScript.startsWith('async') && !normalizedScript.startsWith('(async')) {
        normalizedScript = `async (tools) => {\n${normalizedScript}\n}`;
      }

      // Safe eval of function expression
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const scriptFn = new Function(`"use strict"; return (${normalizedScript});`)() as (
        tools: typeof toolsClient
      ) => Promise<unknown>;

      // Execute with timeout race
      const executionPromise = scriptFn(toolsClient);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs}ms`)), timeoutMs)
      );

      const rawResult = await Promise.race([executionPromise, timeoutPromise]);
      let stdout = stdoutLogs.join('\n');
      if (stdout.length > maxOutputChars) {
        stdout = stdout.slice(0, maxOutputChars) + '\n...[Output truncated]';
      }

      return {
        success: true,
        result: rawResult,
        stdout,
        toolCallCount,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logError('[CodeExecutionRpcBridge] Execution failed:', err);
      return {
        success: false,
        error: errorMsg,
        stdout: stdoutLogs.join('\n'),
        toolCallCount,
      };
    }
  }
}
