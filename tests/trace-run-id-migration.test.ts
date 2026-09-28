import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The `run_id` column on `trace_steps`.
 *
 * A session serves many turns, and every turn appends its thinking / tool_call
 * / tool_result steps to the same table. Before the column, the only grouping
 * available was the whole session, so a step could not be attributed to the
 * turn that produced it and a per-turn report had to guess from timestamps.
 *
 * Two things have to hold for that to be trustworthy:
 *   1. an existing database gains the column on open, keeping its rows;
 *   2. a run id survives a write/read round trip, and steps without one still
 *      load (rows predating the column must not break the session view).
 */

let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getPath: () => testRoot,
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import { closeDatabase, getDatabase, initDatabase } from '../src/main/db/database';
import type { TraceStepRow } from '../src/main/db/database';

function insertSession(id: string): void {
  const now = Date.now();
  // initDatabase is idempotent — it hands back the open instance — so each
  // helper can call it. The migration test closes and reopens the database,
  // and the helpers must survive that.
  initDatabase()
    .raw.prepare(
      `INSERT OR REPLACE INTO sessions
       (id, title, status, cwd, mounted_paths, allowed_tools, memory_enabled, created_at, updated_at)
       VALUES (?, ?, 'idle', NULL, '[]', '[]', 0, ?, ?)`
    )
    .run(id, 'session', now, now);
}

function insertStep(
  step: Partial<TraceStepRow> & Pick<TraceStepRow, 'id' | 'session_id' | 'type' | 'title'>
): void {
  initDatabase()
    .raw.prepare(
      `INSERT OR REPLACE INTO trace_steps
       (id, session_id, run_id, type, status, title, content, tool_name, tool_input, tool_output, is_error, timestamp, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      step.id,
      step.session_id,
      step.run_id ?? null,
      step.type,
      step.status ?? 'completed',
      step.title,
      step.content ?? null,
      step.tool_name ?? null,
      step.tool_input ?? null,
      step.tool_output ?? null,
      step.is_error ?? null,
      step.timestamp ?? 0,
      step.duration ?? null
    );
}

beforeAll(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'cowork-trace-run-id-'));
  initDatabase();
});

afterAll(() => {
  closeDatabase();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('trace_steps.run_id', () => {
  it('adds the column to an existing database without losing rows', () => {
    const sessionId = 'session-migration';
    insertSession(sessionId);

    // Simulate a database written before the column existed: close the app's
    // connection, drop the column and its index while keeping the rows, then
    // reopen — which is exactly what an app restart does, and what runs the
    // migration.
    closeDatabase();
    const legacy = new Database(join(testRoot, 'data', 'cowork.db'));
    legacy.exec('DROP INDEX IF EXISTS idx_trace_steps_run');
    legacy.exec('ALTER TABLE trace_steps DROP COLUMN run_id');
    legacy
      .prepare(
        `INSERT INTO trace_steps (id, session_id, type, status, title, timestamp)
         VALUES ('legacy-step', ?, 'tool_call', 'completed', 'old', 1)`
      )
      .run(sessionId);
    legacy.close();

    initDatabase();
    const db = getDatabase();

    const columns = db.raw
      .prepare(`SELECT name FROM pragma_table_info('trace_steps')`)
      .all() as Array<{ name: string }>;
    expect(columns.map((c) => c.name)).toContain('run_id');

    const after = db.traceSteps.getBySessionId(sessionId);
    expect(after.some((row) => row.id === 'legacy-step')).toBe(true);
    // A pre-migration row reads back as null rather than throwing.
    expect(after.find((row) => row.id === 'legacy-step')?.run_id).toBeNull();
  });

  it('round-trips a run id and reads it back per run', () => {
    const db = getDatabase();
    const sessionId = 'session-runs';
    insertSession(sessionId);
    insertStep({
      id: 'r1-thinking',
      session_id: sessionId,
      run_id: 'run-1',
      type: 'thinking',
      title: 'Processing request...',
    });
    insertStep({
      id: 'r1-result',
      session_id: sessionId,
      run_id: 'run-1',
      type: 'tool_result',
      title: 'Bash',
      duration: 42,
    });
    insertStep({
      id: 'r2-thinking',
      session_id: sessionId,
      run_id: 'run-2',
      type: 'thinking',
      title: 'Processing request...',
    });

    const run1 = db.traceSteps.getByRunId(sessionId, 'run-1');
    expect(run1.map((row) => row.id)).toEqual(['r1-thinking', 'r1-result']);
    expect(run1[1].duration).toBe(42);

    const run2 = db.traceSteps.getByRunId(sessionId, 'run-2');
    expect(run2.map((row) => row.id)).toEqual(['r2-thinking']);

    // Two turns, same title: only the run id tells them apart.
    const all = db.traceSteps.getBySessionId(sessionId);
    expect(all.filter((row) => row.title === 'Processing request...')).toHaveLength(2);
    expect(db.traceSteps.getByRunId(sessionId, 'no-such-run')).toEqual([]);
  });

  it('stores null for a step with no run rather than an empty string', () => {
    const db = getDatabase();
    const sessionId = 'session-null';
    insertSession(sessionId);
    insertStep({ id: 'n1', session_id: sessionId, type: 'text', title: 'hello' });
    const row = db.traceSteps.getBySessionId(sessionId).find((r) => r.id === 'n1');
    expect(row?.run_id).toBeNull();
  });

  it('scopes a per-run read to its own session', () => {
    const db = getDatabase();
    insertSession('session-other');
    insertStep({
      id: 'o1',
      session_id: 'session-other',
      run_id: 'run-1',
      type: 'thinking',
      title: 'other session',
    });
    const forOther = db.traceSteps.getByRunId('session-other', 'run-1');
    expect(forOther.map((row) => row.id)).toEqual(['o1']);
  });

  it('replaces a step in place without dropping its run id', () => {
    // trace_steps.create uses INSERT OR REPLACE, so a replayed step must keep
    // the run it was first written under.
    const db = getDatabase();
    const sessionId = 'session-replace';
    insertSession(sessionId);
    insertStep({
      id: 'rep1',
      session_id: sessionId,
      run_id: 'run-x',
      type: 'tool_call',
      title: 'first',
    });
    insertStep({
      id: 'rep1',
      session_id: sessionId,
      run_id: 'run-x',
      type: 'tool_call',
      title: 'second',
    });
    const rows = db.traceSteps.getBySessionId(sessionId).filter((r) => r.id === 'rep1');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('second');
    expect(rows[0].run_id).toBe('run-x');
  });

  it('creates the run index used by the per-run read', () => {
    const db: Database.Database = getDatabase().raw;
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trace_steps'`)
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_trace_steps_run');
  });
});
