/**
 * Shared harness for the WSL/Lima bridge tests.
 *
 * Both bridges spawn a child process and speak newline-delimited JSON-RPC
 * over its stdio. FakeAgentProcess emulates that child: every write on
 * stdin is parsed as one or more requests, an optional responder decides
 * the reply, and the reply is emitted back on stdout. Tests can therefore
 * assert the exact wire payload without touching a real VM.
 */
import { EventEmitter } from 'events';

export interface JsonRpcRequestMessage {
  jsonrpc: string;
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface AgentReply {
  result?: unknown;
  error?: { code: number; message: string };
}

export type AgentResponder = (request: JsonRpcRequestMessage) => AgentReply | undefined;

export interface ExecResultLike {
  stdout?: unknown;
  stderr?: unknown;
}

/** Resolve the fake stdout/stderr for one execFile/exec invocation. */
export type ExecResolver = (command: string, args: string[]) => ExecResultLike | Error;

export class FakeAgentProcess extends EventEmitter {
  public readonly requests: JsonRpcRequestMessage[] = [];
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public readonly stdin: { write: (chunk: string) => void };
  public killed = false;

  private responder: AgentResponder;

  constructor(responder: AgentResponder = () => ({ result: {} })) {
    super();
    this.responder = responder;
    this.stdin = {
      write: (chunk: string): void => {
        this.handleWrite(chunk);
      },
    };
  }

  setResponder(responder: AgentResponder): void {
    this.responder = responder;
  }

  methods(): string[] {
    return this.requests.map((request) => request.method);
  }

  request(method: string): JsonRpcRequestMessage | undefined {
    return this.requests.find((entry) => entry.method === method);
  }

  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, 'SIGTERM');
    return true;
  }

  private handleWrite(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;

      const request = JSON.parse(line) as JsonRpcRequestMessage;
      this.requests.push(request);

      const reply = this.responder(request) ?? { result: {} };
      const payload = reply.error
        ? { jsonrpc: '2.0', id: request.id, error: reply.error }
        : { jsonrpc: '2.0', id: request.id, result: reply.result };

      this.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`));
    }
  }
}

/** Build a `child_process.execFile` implementation backed by a resolver. */
export function makeExecFileImpl(
  resolver: ExecResolver
): (
  command: string,
  args: string[],
  options: unknown,
  callback: (error: Error | null, result?: ExecResultLike) => void
) => void {
  return (command, args, _options, callback) => {
    const outcome = resolver(command, args);
    if (outcome instanceof Error) {
      callback(outcome);
      return;
    }
    callback(null, outcome);
  };
}

/** Build a `child_process.exec` implementation backed by a resolver. */
export function makeExecImpl(
  resolver: ExecResolver
): (
  command: string,
  options: unknown,
  callback: (error: Error | null, result?: ExecResultLike) => void
) => void {
  return (command, _options, callback) => {
    const outcome = resolver(command, command.split(' ').slice(1));
    if (outcome instanceof Error) {
      callback(outcome);
      return;
    }
    callback(null, outcome);
  };
}

/** Join a command + argv list the way the exec resolver keys see it. */
export function commandKey(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}
