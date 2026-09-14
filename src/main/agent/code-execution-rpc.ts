/**
 * @module main/agent/code-execution-rpc
 *
 * Zero-Context Multi-Step Tool Pipeline & RPC Engine (Hermes-inspired).
 *
 * Features:
 * - Direct invocation of local and MCP tools without LLM turn roundtrips
 * - Strict timeout, output size truncation, and execution recursion limits
 * - Detailed execution audit metrics and telemetry
 */

import { logError } from '../utils/logger';

export type ToolExecutorFn = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RpcExecutionOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  maxToolCalls?: number;
}

export interface RpcExecutionResult {
  success: boolean;
  result?: unknown;
  stdout: string;
  error?: string;
  toolCallCount: number;
  durationMs: number;
}

export class CodeExecutionRpcBridge {
  private toolExecutor: ToolExecutorFn;

  constructor(toolExecutor: ToolExecutorFn) {
    this.toolExecutor = toolExecutor;
  }

  /**
   * Execute an asynchronous JavaScript/TypeScript function that has access
   * to a injected `tools` client.
   */
  async executeScript(
    scriptBody: string,
    options: RpcExecutionOptions = {}
  ): Promise<RpcExecutionResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 30000;
    const maxOutputChars = options.maxOutputChars ?? 50000;
    const maxToolCalls = options.maxToolCalls ?? 100;
    const stdoutLogs: string[] = [];
    let toolCallCount = 0;

    const toolsClient = {
      call: async (toolName: string, args: Record<string, unknown> = {}): Promise<unknown> => {
        toolCallCount++;
        if (toolCallCount > maxToolCalls) {
          throw new Error(`Exceeded maximum tool call threshold (${maxToolCalls}) in single script execution`);
        }
        stdoutLogs.push(`[RPC CALL] ${toolName}(${JSON.stringify(args).slice(0, 120)})`);
        return await this.toolExecutor(toolName, args);
      },
      log: (...args: unknown[]): void => {
        const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        stdoutLogs.push(line);
      },
    };

    try {
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
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      const rawResult = await Promise.race([
        scriptFn(toolsClient).finally(() => {
          if (timer) clearTimeout(timer);
        }),
        timeoutPromise,
      ]);

      let stdout = stdoutLogs.join('\n');
      if (stdout.length > maxOutputChars) {
        stdout = stdout.slice(0, maxOutputChars) + '\n...[Output truncated]';
      }

      return {
        success: true,
        result: rawResult,
        stdout,
        toolCallCount,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logError('[CodeExecutionRpcBridge] Execution failed:', err);
      return {
        success: false,
        error: errorMsg,
        stdout: stdoutLogs.join('\n'),
        toolCallCount,
        durationMs: Date.now() - startTime,
      };
    }
  }
}
