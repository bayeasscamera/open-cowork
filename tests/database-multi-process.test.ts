import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * Multi-process safety of cowork.db (better-sqlite3).
 *
 * Open Cowork can have more than one process attached to the same
 * `<userData>/data/cowork.db` file at once: the GUI process, a `--headless`
 * process, and a second launch of the app. SQLite's WAL journal and busy
 * handler are what make that safe, so these tests exercise the real
 * mechanisms against a real on-disk database instead of trusting that the
 * code configured them:
 *
 *   1. the file is opened in WAL and an explicit lock timeout is active;
 *   2. a write blocked by another process waits for the lock and then
 *      completes, instead of failing or corrupting the file;
 *   3. a writer that cannot get the lock inside its timeout fails with a
 *      clean SQLITE_BUSY and the database stays usable;
 *   4. deferred read -> write transactions are the one WAL case the busy
 *      handler cannot retry (SQLITE_BUSY_SNAPSHOT). Documented here so the
 *      app's write paths can be kept free of that pattern;
 *   5. a write that loses the lock race is retried and lands;
 *   6. a write that can never get the lock fails with a typed, logged
 *      DatabaseWriteLockedError and never silently drops the row;
 *   7. several real OS processes writing the same tables concurrently lose
 *      no rows and leave `PRAGMA integrity_check` = ok.
 */

let testRoot = '';
let holderCount = 0;

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      if (!testRoot) testRoot = mkdtempSync(join(tmpdir(), 'cowork-db-multiproc-'));
      return testRoot;
    },
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import {
  closeDatabase,
  DatabaseWriteLockedError,
  getDatabase,
  initDatabase,
  runWithWriteLockRetry,
} from '../src/main/db/database';

initDatabase();

const DB_PATH = join(testRoot, 'data', 'cowork.db');
const REPO_ROOT = process.cwd();
const openConnections: Database.Database[] = [];

function openOwn(timeout?: number): Database.Database {
  const conn = new Database(DB_PATH, timeout === undefined ? undefined : { timeout });
  openConnections.push(conn);
  return conn;
}

function sqliteCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function seedSession(conn: Database.Database, id: string): void {
  const now = Date.now();
  conn
    .prepare(
      `INSERT OR REPLACE INTO sessions
       (id, title, status, cwd, mounted_paths, allowed_tools, memory_enabled, created_at, updated_at)
       VALUES (?, ?, 'idle', NULL, '[]', '[]', 0, ?, ?)`
    )
    .run(id, 'session ' + id, now, now);
}

function countMessages(conn: Database.Database, sessionId: string): number {
  return (
    conn.prepare('SELECT count(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as {
      n: number;
    }
  ).n;
}

function integrityCheck(conn: Database.Database): string {
  return String(conn.pragma('integrity_check', { simple: true }));
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, COWORK_ROOT: REPO_ROOT, COWORK_DB: DB_PATH, ...extra };
}

/** Spawn a helper script that loads better-sqlite3 from the app's node_modules. */
function writeChildScript(name: string, lines: string[]): string {
  const scriptPath = join(testRoot, name);
  writeFileSync(
    scriptPath,
    [
      "const { createRequire } = require('node:module');",
      "const { join } = require('node:path');",
      "const requireFromApp = createRequire(join(process.env.COWORK_ROOT, 'package.json'));",
      "const Database = requireFromApp('better-sqlite3');",
      'const db = new Database(process.env.COWORK_DB);',
      "db.pragma('busy_timeout = 5000');",
      ...lines,
      '',
    ].join('\n')
  );
  return scriptPath;
}

/**
 * Start a real second process that holds the SQLite write lock on `rowId`
 * for `holdMs` milliseconds. Resolves once the lock is actually taken.
 */
async function startLockHolder(rowId: string, holdMs: number): Promise<ChildProcess> {
  holderCount += 1;
  const scriptPath = writeChildScript('lock-holder-' + holderCount + '.cjs', [
    "db.exec('BEGIN IMMEDIATE');",
    "db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('holder', process.env.COWORK_ROW);",
    "process.stdout.write('LOCKED\\n');",
    "setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.env.COWORK_HOLD_MS));",
  ]);
  const child = spawn(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    env: childEnv({ COWORK_ROW: rowId, COWORK_HOLD_MS: String(holdMs) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('LOCKED')) resolve();
    });
    child.on('error', reject);
    child.on('close', () => reject(new Error('lock holder exited before taking the lock')));
  });
  return child;
}

function waitForClose(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.on('close', () => resolve()));
}

afterAll(() => {
  for (const conn of openConnections) {
    try {
      conn.close();
    } catch {
      /* already closed */
    }
  }
  closeDatabase();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('cowork.db multi-process safety (real better-sqlite3)', () => {
  it('opens the on-disk database in WAL mode with an explicit lock timeout', () => {
    const app = getDatabase().raw;
    expect(String(app.pragma('journal_mode', { simple: true }))).toBe('wal');
    // Explicitly configured in initializeSchema, not inherited from the driver.
    expect(Number(app.pragma('busy_timeout', { simple: true }))).toBe(5000);

    // An independent connection (i.e. another process) sees the same mode:
    // WAL is persisted in the file header, not a per-connection setting.
    const other = openOwn();
    expect(String(other.pragma('journal_mode', { simple: true }))).toBe('wal');
  });

  it('waits for a write lock held by another process, then completes the write', async () => {
    const setup = openOwn();
    seedSession(setup, 'crossproc-row');

    const holder = await startLockHolder('crossproc-row', 400);

    const writer = openOwn(5000);
    const started = Date.now();
    writer.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('writer', 'crossproc-row');
    const elapsed = Date.now() - started;

    await waitForClose(holder);

    // It really blocked on the other process's lock instead of failing fast.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    const row = writer.prepare('SELECT title FROM sessions WHERE id = ?').get('crossproc-row') as {
      title: string;
    };
    expect(row.title).toBe('writer');
    expect(integrityCheck(writer)).toBe('ok');
  }, 30_000);

  it('fails a too-impatient writer with SQLITE_BUSY and keeps the file usable', () => {
    const holder = openOwn();
    const impatient = openOwn(60);
    seedSession(holder, 'busy-row');

    holder.exec('BEGIN IMMEDIATE');
    holder.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('holder', 'busy-row');

    let error: unknown;
    try {
      impatient.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('impatient', 'busy-row');
    } catch (caught) {
      error = caught;
    }

    expect(sqliteCode(error)).toBe('SQLITE_BUSY');
    expect(integrityCheck(holder)).toBe('ok');

    // Once the lock is released the same statement succeeds: a clean failure,
    // not a poisoned connection.
    holder.exec('COMMIT');
    impatient.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('recovered', 'busy-row');
    const row = impatient.prepare('SELECT title FROM sessions WHERE id = ?').get('busy-row') as {
      title: string;
    };
    expect(row.title).toBe('recovered');
    expect(integrityCheck(impatient)).toBe('ok');
  });

  it('cannot retry a deferred read-then-write transaction (WAL snapshot hazard)', () => {
    const reader = openOwn(5000);
    const writer = openOwn();
    seedSession(writer, 'snapshot-row');

    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM sessions').get();

    // Another connection commits a write after the reader took its snapshot.
    writer.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('moved-on', 'snapshot-row');

    let error: unknown;
    try {
      reader.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('stale', 'snapshot-row');
    } catch (caught) {
      error = caught;
    }
    reader.exec('ROLLBACK');

    // The busy handler does NOT wait here: WAL refuses to upgrade a stale read
    // snapshot. This is why write paths must not read-then-write inside a
    // deferred transaction, and why the retry helper matches the whole
    // SQLITE_BUSY* family rather than only the plain code.
    expect(sqliteCode(error)).toBe('SQLITE_BUSY_SNAPSHOT');
  });

  it('retries a write that loses the lock race and still persists the row', async () => {
    const db = getDatabase();
    const raw = db.raw;
    seedSession(raw, 'retry-row');
    const originalTimeout = Number(raw.pragma('busy_timeout', { simple: true }));

    // Make the first attempt give up well before the other process releases,
    // so success can only come from the retry layer.
    raw.pragma('busy_timeout = 100');
    try {
      // Released after ~200ms: the first attempt times out at 100ms, the
      // helper backs off 200ms, so only a retry can land the row.
      const holder = await startLockHolder('retry-row', 200);

      const started = Date.now();
      db.messages.create({
        id: 'retry-message',
        session_id: 'retry-row',
        role: 'user',
        content: '"hello"',
        timestamp: Date.now(),
        token_usage: null,
        execution_time_ms: null,
      });
      const elapsed = Date.now() - started;

      await waitForClose(holder);

      expect(elapsed).toBeGreaterThanOrEqual(280);
      expect(countMessages(raw, 'retry-row')).toBe(1);
      expect(integrityCheck(raw)).toBe('ok');
    } finally {
      raw.pragma('busy_timeout = ' + originalTimeout);
    }
  }, 30_000);

  it('fails with a typed DatabaseWriteLockedError when the lock is never released in time', async () => {
    const db = getDatabase();
    const raw = db.raw;
    seedSession(raw, 'blocked-row');
    const originalTimeout = Number(raw.pragma('busy_timeout', { simple: true }));

    raw.pragma('busy_timeout = 50');
    try {
      const holder = await startLockHolder('blocked-row', 700);

      let error: unknown;
      try {
        db.messages.create({
          id: 'blocked-message',
          session_id: 'blocked-row',
          role: 'user',
          content: '"lost"',
          timestamp: Date.now(),
          token_usage: null,
          execution_time_ms: null,
        });
      } catch (caught) {
        error = caught;
      }

      await waitForClose(holder);

      // A clean, typed, logged failure — and the row was NOT silently written.
      expect(error).toBeInstanceOf(DatabaseWriteLockedError);
      const locked = error as DatabaseWriteLockedError;
      expect(locked.operation).toContain('INSERT INTO messages');
      expect(locked.code.startsWith('SQLITE_BUSY')).toBe(true);
      expect(countMessages(raw, 'blocked-row')).toBe(0);

      // The connection stays usable once the lock is gone.
      db.messages.create({
        id: 'after-message',
        session_id: 'blocked-row',
        role: 'user',
        content: '"after"',
        timestamp: Date.now(),
        token_usage: null,
        execution_time_ms: null,
      });
      expect(countMessages(raw, 'blocked-row')).toBe(1);
    } finally {
      raw.pragma('busy_timeout = ' + originalTimeout);
    }
  }, 30_000);

  it('never retries an error that is not lock contention', () => {
    let calls = 0;
    expect(() =>
      runWithWriteLockRetry('unit-test', () => {
        calls += 1;
        throw new Error('NOT NULL constraint failed');
      })
    ).toThrow('NOT NULL constraint failed');
    expect(calls).toBe(1);
  });

  it('keeps every row when several OS processes write the same tables at once', async () => {
    const WORKERS = 4;
    const WRITES_PER_WORKER = 300;

    const writerPath = writeChildScript('concurrent-writer.cjs', [
      'const worker = process.env.COWORK_WORKER;',
      'const count = Number(process.env.COWORK_COUNT);',
      'const insert = db.prepare(',
      "  'INSERT INTO messages (id, session_id, role, content, timestamp, token_usage, execution_time_ms) VALUES (?, ?, ?, ?, ?, ?, ?)'",
      ');',
      "const bump = db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');",
      'const write = db.transaction(() => {',
      '  for (let index = 0; index < count; index += 1) {',
      "    insert.run(worker + '-' + index, worker, 'user', 'payload ' + index, Date.now(), null, null);",
      '    bump.run(Date.now(), worker);',
      '  }',
      '});',
      'try {',
      '  write();',
      "  console.log('OK ' + count);",
      '} catch (error) {',
      "  console.error('FAIL ' + worker + ' ' + ((error && error.code) || '') + ' ' + ((error && error.message) || error));",
      '  process.exit(1);',
      '}',
      'db.close();',
    ]);

    const setup = openOwn();
    for (let worker = 0; worker < WORKERS; worker += 1) {
      seedSession(setup, 'worker-' + worker);
    }

    const runWorker = (worker: number) =>
      new Promise<{ worker: number; code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [writerPath], {
          cwd: REPO_ROOT,
          env: childEnv({
            COWORK_WORKER: 'worker-' + worker,
            COWORK_COUNT: String(WRITES_PER_WORKER),
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', () => resolve({ worker, code: -1, stderr: 'spawn failed' }));
        child.on('close', (code) => resolve({ worker, code, stderr }));
      });

    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_unused, worker) => runWorker(worker))
    );

    for (const result of results) {
      expect(result.stderr, 'worker ' + result.worker + ' stderr: ' + result.stderr).toBe('');
      expect(result.code, 'worker ' + result.worker + ' exit code').toBe(0);
    }

    const total = setup
      .prepare("SELECT count(*) AS n FROM messages WHERE session_id LIKE 'worker-%'")
      .get() as { n: number };
    expect(total.n).toBe(WORKERS * WRITES_PER_WORKER);

    const distinct = setup
      .prepare(
        "SELECT count(DISTINCT session_id) AS n FROM messages WHERE session_id LIKE 'worker-%'"
      )
      .get() as { n: number };
    expect(distinct.n).toBe(WORKERS);

    expect(integrityCheck(setup)).toBe('ok');
  }, 60_000);
});
