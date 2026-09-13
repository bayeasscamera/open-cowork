/**
 * Shared JSON-RPC transport for in-VM sandbox agents (WSL on Windows,
 * Lima on macOS).
 *
 * Owns the protocol plumbing that both bridges used to duplicate:
 * response buffering, request/response correlation over stdio, and
 * timeouts. Subclasses provide the child process stdin handle and a
 * log tag; they keep their platform-specific lifecycle (spawn, status
 * checks, installs) untouched.
 */
import { randomUUID } from 'crypto';
import { logError } from '../utils/logger';
import type { JSONRPCRequest, JSONRPCResponse } from './types';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export abstract class VMJsonRpcTransport {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private buffer: string = '';

  protected abstract readonly logTag: string;

  /** The stdin stream of the running agent process, or null when stopped. */
  protected abstract getAgentStdin(): NodeJS.WritableStream | null;

  protected abstract agentName(): string;

  /** Default stdout cap before the agent is considered runaway and killed. */
  protected readonly maxBufferBytes = 10 * 1024 * 1024;

  /**
   * Feed one stdout chunk into the transport. Kills the agent process via
   * the subclass hook when the unprocessed buffer exceeds the cap.
   */
  protected ingestStdout(chunk: Buffer | string, onOverflow: () => void): void {
    this.buffer += chunk.toString();
    if (this.buffer.length > this.maxBufferBytes) {
      logError(`${this.logTag} Buffer size exceeded limit, disconnecting agent`);
      this.failAllPendingRequests();
      onOverflow();
      return;
    }
    this.processBuffer();
  }

  protected processBuffer(): void {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as JSONRPCResponse;
        const pending = this.pendingRequests.get(response.id);

        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(response.id);

          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (error) {
        logError(`${this.logTag} Failed to parse response:`, line, error);
      }
    }
  }

  protected async sendRequest<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = 60000
  ): Promise<T> {
    const stdin = this.getAgentStdin();
    if (!stdin) {
      throw new Error(`${this.agentName()} agent not running`);
    }

    const id = randomUUID();
    const request: JSONRPCRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      stdin.write(JSON.stringify(request) + '\n');
    });
  }

  /** Reject all in-flight requests — call when the agent process dies. */
  protected failAllPendingRequests(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${this.agentName()} agent disconnected`));
    }
    this.pendingRequests.clear();
    this.buffer = '';
  }
}
