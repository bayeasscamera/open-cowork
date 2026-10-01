/**
 * @module main/a2a/a2a-server
 *
 * Minimal, spec-shaped A2A server (REST binding) exposing this app as an
 * agent other agents can delegate read-only work to.
 *
 * Endpoints (auth = `Authorization: Bearer <token>` everywhere but the card):
 *   GET  /.well-known/agent-card.json  → public discovery document
 *   POST /message:send                 → create (or continue) a task; always
 *                                        returns immediately with a WORKING
 *                                        task — poll it, per the non-blocking
 *                                        mode of the spec
 *   GET  /tasks                        → all known tasks, newest last
 *   GET  /tasks/{id}                   → task state + answer artifact when done
 *   POST /tasks/{id}:cancel            → stop the session, mark CANCELED
 *
 * Security model — three layers, all enforced here, none in the client:
 *  1. Loopback bind (127.0.0.1) + bearer token compared in constant time.
 *     The server is opt-in and off by default.
 *  2. Tasks run in sessions under a NON-INTERACTIVE tool lockdown
 *     (read/search/list/fetch only — see `permission-rules-store`), so even a
 *     malicious prompt cannot write, execute, or reconfigure anything.
 *  3. No workspace escape: the session uses the app's default workdir; the
 *     protocol carries no path parameter to abuse.
 *
 * Dependency-free (node:http only, no electron) so the whole surface is
 * verifiable from unit tests over real HTTP.
 */
import * as crypto from 'crypto';
import * as http from 'http';
import { buildAgentCard } from './agent-card';

export const A2A_DEFAULT_PORT = 19889;
export const A2A_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'unknown';

export interface A2ATask {
  id: string;
  contextId: string;
  status: { state: A2ATaskState; message?: string; timestamp: string };
  artifacts?: Array<{
    artifactId: string;
    name: string;
    parts: Array<{ text: string }>;
  }>;
}

export type A2ASessionStatus = 'idle' | 'running' | 'completed' | 'error';

/** What the server needs from the app; faked in tests, adapted in prod. */
export interface A2ABackend {
  createSession(title: string, prompt: string): Promise<{ sessionId: string }>;
  continueSession(sessionId: string, prompt: string): Promise<void>;
  getSessionStatus(sessionId: string): A2ASessionStatus | null;
  /** Latest assistant text, or null while there is nothing to report yet. */
  getAnswerText(sessionId: string): string | null;
  cancelSession(sessionId: string): void;
  lockSession(sessionId: string): void;
  unlockSession(sessionId: string): void;
  buildTitle(prompt: string): string;
}

export interface A2AServerOptions {
  port: number;
  token: string;
  appVersion: string;
  backend: A2ABackend;
  onLog?: (message: string, details?: unknown) => void;
}

interface TaskRecord {
  task: A2ATask;
  sessionId: string;
  canceled: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Constant-time bearer comparison so token length leaks nothing. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match || !match[1]) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

interface IncomingMessage {
  messageId?: string;
  role?: string;
  contextId?: string;
  parts?: Array<{ text?: string }>;
}

function extractPromptText(message: IncomingMessage): string | null {
  if (!message || typeof message !== 'object') return null;
  if (message.role !== undefined && message.role !== 'user') return null;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const text = parts
    .map((part) => (part && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
  return text ? text : null;
}

export interface A2AServerHandle {
  url: string;
  stop(): void;
}

export function startA2AServer(options: A2AServerOptions): A2AServerHandle {
  const { port, token, backend, appVersion } = options;
  const log = options.onLog ?? (() => undefined);
  const tasks = new Map<string, TaskRecord>();
  const liveByContext = new Map<string, string>();

  const baseUrl = `http://${A2A_HOST}:${port}`;

  function taskView(record: TaskRecord): A2ATask {
    const status = backend.getSessionStatus(record.sessionId);
    const state = toTaskState(status, record.canceled);
    const task: A2ATask = {
      id: record.task.id,
      contextId: record.task.contextId,
      status: { state, timestamp: nowIso() },
    };
    if (state === 'completed') {
      const answer = backend.getAnswerText(record.sessionId);
      task.artifacts = [
        {
          artifactId: `${record.task.id}-answer`,
          name: 'answer',
          parts: [{ text: answer ?? '' }],
        },
      ];
    } else if (state === 'failed') {
      task.status.message = 'The agent run failed; see the app session log for details.';
    } else if (state === 'canceled') {
      task.status.message = 'The task was canceled.';
    }
    return task;
  }

  function isTerminal(state: A2ATaskState): boolean {
    return state === 'completed' || state === 'failed' || state === 'canceled';
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || '/', baseUrl);
        const pathname = url.pathname;

        if (req.method === 'GET' && pathname === '/.well-known/agent-card.json') {
          return sendJson(res, 200, buildAgentCard({ baseUrl, appVersion }));
        }

        if (!isAuthorized(req.headers.authorization, token)) {
          return sendJson(res, 401, { error: 'Unauthorized: valid bearer token required.' });
        }

        if (req.method === 'POST' && pathname === '/message:send') {
          let body: unknown;
          try {
            body = await readBody(req);
          } catch {
            return sendJson(res, 400, { error: 'Invalid JSON body (max 1MB).' });
          }
          const payload = (body ?? {}) as { message?: IncomingMessage };
          const prompt = extractPromptText(payload.message ?? {});
          if (!prompt) {
            return sendJson(res, 400, {
              error: 'A user message with at least one text part is required.',
            });
          }

          // Multi-turn: a live task on the same context continues its session.
          const contextId =
            typeof payload.message?.contextId === 'string' && payload.message.contextId
              ? payload.message.contextId
              : crypto.randomUUID();
          const existingSessionId = liveByContext.get(contextId);
          if (existingSessionId) {
            const existing = [...tasks.values()].find((t) => t.sessionId === existingSessionId);
            if (existing && !isTerminal(toTaskState(backend.getSessionStatus(existingSessionId), existing.canceled))) {
              try {
                await backend.continueSession(existingSessionId, prompt);
              } catch (error) {
                return sendJson(res, 502, {
                  error: `Could not continue session: ${error instanceof Error ? error.message : String(error)}`,
                });
              }
              return sendJson(res, 200, taskView(existing));
            }
            liveByContext.delete(contextId);
          }

          let sessionId: string;
          try {
            const created = await backend.createSession(backend.buildTitle(prompt), prompt);
            sessionId = created.sessionId;
          } catch (error) {
            return sendJson(res, 502, {
              error: `Could not start session: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
          backend.lockSession(sessionId);
          const taskId = crypto.randomUUID();
          const record: TaskRecord = {
            task: {
              id: taskId,
              contextId,
              status: { state: 'working', timestamp: nowIso() },
            },
            sessionId,
            canceled: false,
          };
          tasks.set(taskId, record);
          liveByContext.set(contextId, sessionId);
          log('[A2A] Task created:', { taskId, sessionId });
          return sendJson(res, 200, taskView(record));
        }

        if (req.method === 'GET' && pathname === '/tasks') {
          return sendJson(
            res,
            200,
            { tasks: [...tasks.values()].map((record) => taskView(record)) }
          );
        }

        const taskIdMatch = /^\/tasks\/([^/]+)$/.exec(pathname);
        if (req.method === 'GET' && taskIdMatch?.[1]) {
          const record = tasks.get(taskIdMatch[1]);
          if (!record) return sendJson(res, 404, { error: 'Unknown task id.' });
          return sendJson(res, 200, taskView(record));
        }

        const cancelMatch = /^\/tasks\/([^/]+):cancel$/.exec(pathname);
        if (req.method === 'POST' && cancelMatch?.[1]) {
          const record = tasks.get(cancelMatch[1]);
          if (!record) return sendJson(res, 404, { error: 'Unknown task id.' });
          record.canceled = true;
          try {
            backend.cancelSession(record.sessionId);
          } catch (error) {
            log('[A2A] Cancel failed:', error);
          }
          backend.unlockSession(record.sessionId);
          liveByContext.delete(record.task.contextId);
          return sendJson(res, 200, taskView(record));
        }

        return sendJson(res, 404, { error: 'Not found.' });
      } catch (error) {
        log('[A2A] Unexpected error:', error);
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
      }
    })();
  });

  server.listen(port, A2A_HOST, () => {
    log(`[A2A] Listening on ${baseUrl}`);
  });
  server.unref();
  server.on('error', (error: NodeJS.ErrnoException) => {
    log(`[A2A] Server error (${error.code ?? 'unknown'}): ${error.message}`);
  });

  return {
    url: baseUrl,
    stop: () => {
      server.close();
    },
  };
}

function toTaskState(
  status: A2ASessionStatus | null,
  canceled: boolean
): A2ATaskState {
  if (canceled) return 'canceled';
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
      return 'failed';
    case 'running':
    case 'idle':
      return 'working';
    default:
      return 'unknown';
  }
}
