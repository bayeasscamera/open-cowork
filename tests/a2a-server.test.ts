/**
 * Chantier 6 — Agent-to-Agent server.
 *
 * Proofs (all over real HTTP against the shipped module, Electron-free):
 *  1. The agent card is public, honest (no streaming/push), and declares auth.
 *  2. Everything else requires the bearer token (401 otherwise, constant-time).
 *  3. Full task lifecycle: send → working → poll → completed with an answer
 *     artifact; multi-turn continues the same session; cancel stops it.
 *  4. Lockdown: an A2A-style session cannot write/execute even in Full
 *     Access; the agent gets a read-only explanation, not silence.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import {
  startA2AServer,
  isAuthorized,
  type A2ABackend,
  type A2AServerHandle,
  type A2ATask,
} from '../src/main/a2a/a2a-server';
import { buildAgentCard } from '../src/main/a2a/agent-card';
import {
  LOCKDOWN_ALLOWED_TOOLS,
  clearSessionToolLockdown,
  decidePermission,
  decidePermissionWithDetail,
  describeLockdownRefusal,
  setAutoApproveAll,
  setPermissionRules,
  setSessionToolLockdown,
} from '../src/main/config/permission-rules-store';

const PORT = 19891;
const TOKEN = 'test-token-1234567890';
const BASE = `http://127.0.0.1:${PORT}`;

interface FakeSession {
  status: 'idle' | 'running' | 'completed' | 'error';
  prompts: string[];
  answer: string | null;
}

function createFakeBackend(): A2ABackend & { sessions: Map<string, FakeSession> } {
  const sessions = new Map<string, FakeSession>();
  let next = 0;
  return {
    sessions,
    async createSession(title: string, prompt: string) {
      const sessionId = `sess-${++next}`;
      sessions.set(sessionId, { status: 'running', prompts: [`${title} :: ${prompt}`], answer: null });
      return { sessionId };
    },
    async continueSession(sessionId: string, prompt: string) {
      sessions.get(sessionId)?.prompts.push(prompt);
    },
    getSessionStatus(sessionId: string) {
      return sessions.get(sessionId)?.status ?? null;
    },
    getAnswerText(sessionId: string) {
      return sessions.get(sessionId)?.answer ?? null;
    },
    cancelSession(sessionId: string) {
      const session = sessions.get(sessionId);
      if (session) session.status = 'idle';
    },
    lockSession() {},
    unlockSession() {},
    buildTitle: (prompt: string) => `A2A: ${prompt.slice(0, 20)}`,
  };
}

let backend: ReturnType<typeof createFakeBackend>;
let server: A2AServerHandle;

beforeAll(() => {
  backend = createFakeBackend();
  server = startA2AServer({ port: PORT, token: TOKEN, appVersion: 'test', backend });
});

afterAll(() => {
  server.stop();
});

function authed(init?: RequestInit): RequestInit {
  return { ...init, headers: { ...init?.headers, Authorization: `Bearer ${TOKEN}` } };
}

async function sendMessage(text: string, contextId?: string): Promise<A2ATask> {
  const res = await fetch(
    `${BASE}/message:send`,
    authed({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          messageId: 'm1',
          role: 'user',
          ...(contextId ? { contextId } : {}),
          parts: [{ text }],
        },
      }),
    })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as A2ATask;
}

describe('agent card (public discovery)', () => {
  it('serves an honest card without auth', async () => {
    const res = await fetch(`${BASE}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as ReturnType<typeof buildAgentCard>;
    expect(card.name).toBe('Open Cowork');
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.skills.length).toBeGreaterThan(0);
    expect(card.securitySchemes.bearer.scheme).toBe('bearer');
  });
});

describe('authorization', () => {
  it('rejects missing and wrong tokens', async () => {
    expect((await fetch(`${BASE}/tasks`)).status).toBe(401);
    expect(
      (await fetch(`${BASE}/tasks`, { headers: { Authorization: 'Bearer wrong' } })).status
    ).toBe(401);
    expect((await fetch(`${BASE}/tasks`, authed())).status).toBe(200);
  });

  it('compares in constant time without leaking', () => {
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized('Bearer ', TOKEN)).toBe(false);
    expect(isAuthorized('Bearer short', TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
  });
});

describe('task lifecycle', () => {
  it('send → working → completed with an answer artifact', async () => {
    const task = await sendMessage('Explain the auth module');
    expect(task.status.state).toBe('working');
    expect(task.id).toBeTruthy();
    expect(task.contextId).toBeTruthy();

    const listed = (await (await fetch(`${BASE}/tasks`, authed())).json()) as {
      tasks: A2ATask[];
    };
    expect(listed.tasks.some((t) => t.id === task.id)).toBe(true);

    // The agent finishes: flip the fake session and set its answer.
    const sessionId = [...backend.sessions.keys()].at(-1);
    expect(sessionId).toBeTruthy();
    backend.sessions.get(sessionId!)!.status = 'completed';
    backend.sessions.get(sessionId!)!.answer = 'Auth lives in remote/gateway.ts.';

    const done = (await (
      await fetch(`${BASE}/tasks/${task.id}`, authed())
    ).json()) as A2ATask;
    expect(done.status.state).toBe('completed');
    expect(done.artifacts?.[0]?.parts[0]?.text).toBe('Auth lives in remote/gateway.ts.');
  });

  it('continues the same session on the same context', async () => {
    const first = await sendMessage('First question');
    const second = await sendMessage('Follow-up', first.contextId);
    expect(second.id).toBe(first.id);
    const sessionId = [...backend.sessions.keys()].at(-1)!;
    expect(backend.sessions.get(sessionId)!.prompts.length).toBe(2);
  });

  it('cancel stops the session and marks the task canceled', async () => {
    const task = await sendMessage('Long research task');
    const res = await fetch(`${BASE}/tasks/${task.id}:cancel`, authed({ method: 'POST' }));
    expect(res.status).toBe(200);
    const canceled = (await res.json()) as A2ATask;
    expect(canceled.status.state).toBe('canceled');
    const reread = (await (
      await fetch(`${BASE}/tasks/${task.id}`, authed())
    ).json()) as A2ATask;
    expect(reread.status.state).toBe('canceled');
  });

  it('rejects empty messages, non-user roles and unknown tasks', async () => {
    const empty = await fetch(
      `${BASE}/message:send`,
      authed({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { role: 'user', parts: [{ text: '  ' }] } }),
      })
    );
    expect(empty.status).toBe(400);

    const agentRole = await fetch(
      `${BASE}/message:send`,
      authed({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { role: 'agent', parts: [{ text: 'hi' }] } }),
      })
    );
    expect(agentRole.status).toBe(400);

    expect((await fetch(`${BASE}/tasks/nope`, authed())).status).toBe(404);
    expect(
      (await fetch(`${BASE}/tasks/nope:cancel`, authed({ method: 'POST' }))).status
    ).toBe(404);
  });
});

describe('non-interactive session lockdown', () => {
  beforeEach(() => {
    setAutoApproveAll(false);
    clearSessionToolLockdown('a2a-sess');
    setPermissionRules([
      { tool: 'read', action: 'allow' },
      { tool: 'bash', action: 'ask' },
    ]);
  });

  it('denies writes and shell even in Full Access', () => {
    setSessionToolLockdown('a2a-sess', LOCKDOWN_ALLOWED_TOOLS);
    setAutoApproveAll(true);
    expect(decidePermission('a2a-sess', 'write', { path: 'x.txt' })).toBe('deny');
    expect(decidePermission('a2a-sess', 'bash', { command: 'ls' })).toBe('deny');
    const detail = decidePermissionWithDetail('a2a-sess', 'bash', { command: 'ls' });
    expect(detail.lockdownRefusal).toBe(true);
    // …while reads still flow.
    expect(decidePermission('a2a-sess', 'read', { path: 'x.txt' })).toBe('allow');
    expect(decidePermission('a2a-sess', 'grep', { pattern: 'x' })).toBe('allow');
  });

  it('explains the read-only policy instead of failing silently', () => {
    const text = describeLockdownRefusal('bash');
    expect(text).toContain('bash');
    expect(text).toMatch(/read-only/i);
    expect(text).toMatch(/do not retry/i);
  });

  it('user deny rules still win with their own explanation', () => {
    setSessionToolLockdown('a2a-sess', LOCKDOWN_ALLOWED_TOOLS);
    setPermissionRules([{ tool: 'grep', pattern: '*secret*', action: 'deny' }]);
    const detail = decidePermissionWithDetail('a2a-sess', 'grep', { pattern: 'secret' });
    expect(detail.decision).toBe('deny');
    expect(detail.matchedDenyRule).toMatchObject({ tool: 'grep' });
    expect(detail.lockdownRefusal).toBe(false);
  });
});
