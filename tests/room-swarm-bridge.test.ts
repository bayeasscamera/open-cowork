import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createRoomStore } from '../src/main/rooms/room-store-factory';
import { captureSwarmIntoRoom, tryCaptureSwarmIntoRoom } from '../src/main/rooms/room-swarm-bridge';
import type { RoomStore } from '../src/main/rooms/room-store';
import type { MultiAgentPlan, AgentTask } from '../src/main/agent/multi-agent-coordinator';

function newStore(): RoomStore {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, name TEXT NOT NULL,
      goal TEXT, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE room_members (
      room_id TEXT NOT NULL, role TEXT NOT NULL, task_id TEXT,
      joined_at INTEGER NOT NULL, PRIMARY KEY (room_id, role)
    )
  `);
  db.exec(`
    CREATE TABLE room_messages (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL, from_role TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, model_calls INTEGER NOT NULL DEFAULT 0,
      status TEXT, created_at INTEGER NOT NULL
    )
  `);
  return createRoomStore({ raw: db } as never);
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    role: 'developer',
    title: 'do the thing',
    prompt: 'p',
    status: 'completed',
    aggregationPolicy: undefined as never,
    ...overrides,
  } as AgentTask;
}

function plan(overrides: Partial<MultiAgentPlan> = {}): MultiAgentPlan {
  return {
    id: 'plan-1',
    goal: 'refactor the auth module',
    tasks: [task()],
    status: 'done',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    aggregationPolicy: 'fail-all',
    ...overrides,
  };
}

describe('swarm to room bridge', () => {
  it('records the members and what each task produced', () => {
    const store = newStore();
    const captured = captureSwarmIntoRoom({
      plan: plan({
        tasks: [
          task({ id: 't1', role: 'architect', title: 'design', result: 'split into two modules' }),
          task({ id: 't2', role: 'developer', title: 'implement', result: 'done', modifiedFiles: ['a.ts', 'b.ts'] }),
        ],
      }),
      store,
    });

    const detail = store.getDetail(captured.roomId);
    expect(detail?.members.map((m) => m.role).sort()).toEqual(['architect', 'developer']);
    expect(detail?.messages.map((m) => m.body)).toEqual([
      '[design] split into two modules',
      '[implement] done',
      '[implement] modified 2 file(s): a.ts, b.ts',
    ]);
  });

  it('keeps a failed task visible instead of dropping it', () => {
    const store = newStore();
    const captured = captureSwarmIntoRoom({
      plan: plan({
        status: 'failed',
        tasks: [task({ status: 'failed', error: 'model unavailable', result: undefined })],
      }),
      store,
    });
    expect(store.messages(captured.roomId)[0].body).toContain('failed: model unavailable');
  });

  it('persists teammate exchanges as question and answer pairs', () => {
    const store = newStore();
    const captured = captureSwarmIntoRoom({
      plan: plan({
        teamMode: true,
        tasks: [
          task({
            teammateExchanges: [
              {
                id: 'ex-1',
                fromRole: 'developer',
                fromTaskId: 't1',
                targetRole: 'architect',
                question: 'where is the token validated?',
                answer: 'gateway.ts',
                status: 'answered',
                modelCalls: 1,
                at: 1_000,
                durationMs: 250,
              },
            ],
          }),
        ],
      }),
      store,
    });

    expect(captured.exchangesRecorded).toBe(1);
    expect(captured.modelCalls).toBe(1);
    const kinds = store.messages(captured.roomId).map((m) => m.kind);
    expect(kinds).toContain('question');
    expect(kinds).toContain('answer');
    expect(store.totalModelCalls(captured.roomId)).toBe(1);
  });

  it('preserves the fallback of an unanswered question', () => {
    const store = newStore();
    const captured = captureSwarmIntoRoom({
      plan: plan({
        tasks: [
          task({
            teammateExchanges: [
              {
                id: 'ex-1',
                fromRole: 'developer',
                fromTaskId: 't1',
                targetRole: 'architect',
                question: 'are you there?',
                answer: 'teammate_unavailable',
                status: 'unavailable',
                modelCalls: 0,
                at: 1_000,
                durationMs: 0,
              },
            ],
          }),
        ],
      }),
      store,
    });

    const messages = store.messages(captured.roomId);
    expect(messages.some((m) => m.kind === 'answer' && m.body.includes('teammate_unavailable'))).toBe(
      true
    );
    // An unanswered exchange cost nothing, and the room should say so.
    expect(captured.modelCalls).toBe(0);
  });

  it('scopes the room to the session that ran the swarm', () => {
    const store = newStore();
    const captured = captureSwarmIntoRoom({ plan: plan(), store, sessionId: 's-7' });
    expect(store.get(captured.roomId)?.sessionId).toBe('s-7');
  });

  it('leaves the room open for follow-up work', () => {
    const store = newStore();
    const captured = captureSwarmIntoRoom({ plan: plan({ status: 'done' }), store });
    expect(store.get(captured.roomId)?.status).toBe('open');
  });

  it('names the room after the goal, shortened if long', () => {
    const store = newStore();
    const short = captureSwarmIntoRoom({ plan: plan({ goal: 'fix the bug' }), store });
    expect(store.get(short.roomId)?.name).toBe('fix the bug');

    const long = captureSwarmIntoRoom({
      plan: plan({ goal: 'x'.repeat(200) }),
      store,
    });
    expect(store.get(long.roomId)!.name.length).toBeLessThanOrEqual(80);
  });

  it('clips a very large task result rather than storing it whole', () => {
    const store = newStore();
    const captured = captureSwarmIntoRoom({
      plan: plan({ tasks: [task({ result: 'y'.repeat(50_000) })] }),
      store,
    });
    const body = store.messages(captured.roomId)[0].body;
    expect(body.length).toBeLessThan(50_000);
    expect(body.endsWith('…')).toBe(true);
  });

  it('never throws when persistence fails, so the swarm result survives', () => {
    const broken = {
      create() {
        throw new Error('disk full');
      },
    } as unknown as RoomStore;

    // This is the property that matters at the call site: the swarm already did
    // the work, so recording it must not be able to fail the run.
    expect(tryCaptureSwarmIntoRoom({ plan: plan(), store: broken })).toBeNull();
  });

  it('returns null rather than a partial room when it does persist', () => {
    const store = newStore();
    const result = tryCaptureSwarmIntoRoom({ plan: plan(), store });
    expect(result?.created).toBe(true);
    expect(store.list()).toHaveLength(1);
  });
});