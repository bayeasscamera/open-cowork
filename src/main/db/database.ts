/**
 * SQLite database implementation using better-sqlite3
 * Provides persistent storage for sessions, messages, and other data
 */

import './native-module-guard';
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { existsSync, mkdirSync, statSync, renameSync, openSync, readSync, closeSync } from 'fs';
import { log, logError, logWarn } from '../utils/logger';
import { boundTraceStepRow } from './retention';

export interface DatabaseInstance {
  // Raw database access (for advanced queries)
  raw: Database.Database;

  // Session operations
  sessions: {
    create: (session: SessionRow) => void;
    update: (id: string, updates: Partial<SessionRow>) => void;
    get: (id: string) => SessionRow | undefined;
    getAll: () => SessionRow[];
    delete: (id: string) => void;
  };

  // Message operations
  messages: {
    create: (message: MessageRow) => void;
    update: (id: string, updates: Partial<Pick<MessageRow, 'execution_time_ms'>>) => void;
    getBySessionId: (sessionId: string) => MessageRow[];
    delete: (id: string) => void;
    deleteBySessionId: (sessionId: string) => void;
  };

  traceSteps: {
    create: (step: TraceStepRow) => void;
    update: (id: string, updates: Partial<TraceStepRow>) => void;
    getBySessionId: (sessionId: string) => TraceStepRow[];
    getByRunId: (sessionId: string, runId: string) => TraceStepRow[];
    deleteBySessionId: (sessionId: string) => void;
  };

  scheduledTasks: {
    create: (task: ScheduledTaskRow) => void;
    update: (id: string, updates: Partial<ScheduledTaskRow>) => void;
    get: (id: string) => ScheduledTaskRow | undefined;
    getAll: () => ScheduledTaskRow[];
    delete: (id: string) => void;
  };

  projects: {
    create: (project: ProjectRow) => void;
    update: (id: string, updates: Partial<ProjectRow>) => void;
    get: (id: string) => ProjectRow | undefined;
    getAll: () => ProjectRow[];
    /** Hard delete — only legal for empty/archived projects (store guards it). */
    delete: (id: string) => void;
  };

  projectFiles: {
    add: (file: ProjectFileRow) => void;
    remove: (projectId: string, filePath: string) => void;
    listByProject: (projectId: string) => ProjectFileRow[];
    deleteByProject: (projectId: string) => void;
  };

  // For compatibility with old interface
  prepare: (sql: string) => Database.Statement;
  exec: (sql: string) => void;
  pragma: (pragma: string) => unknown;
  close: () => void;
}

export interface SessionRow {
  id: string;
  title: string;
  claude_session_id: string | null;
  openai_thread_id: string | null;
  status: string;
  cwd: string | null;
  mounted_paths: string; // JSON string
  allowed_tools: string; // JSON string
  memory_enabled: number;
  model: string | null;
  is_pinned?: number | null;
  project_id?: string | null;
  /** SESSION-level ConfigSet override (null = inherit project, then global). */
  config_set_id?: string | null;
  /** Model pinned inside that set (null = the set's own model). */
  config_model_id?: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string; // JSON string
  timestamp: number;
  token_usage: string | null; // JSON string
  execution_time_ms: number | null;
}

export interface TraceStepRow {
  id: string;
  session_id: string;
  /** Agent run (one user turn) that emitted the step; null on pre-migration rows. */
  run_id?: string | null;
  type: string;
  status: string;
  title: string;
  content: string | null;
  tool_name: string | null;
  tool_input: string | null; // JSON string
  tool_output: string | null;
  is_error: number | null;
  timestamp: number;
  duration: number | null;
}

export interface ScheduledTaskRow {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  project_id: string | null;
  run_at: number;
  next_run_at: number | null;
  schedule_config: string | null;
  repeat_every: number | null;
  repeat_unit: string | null;
  enabled: number;
  last_run_at: number | null;
  last_run_session_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  /** Workspace folder the project is bound to (sandbox confinement target). */
  workdir: string;
  /** Optional ConfigSet used instead of the globally active one for this project. */
  config_set_id: string | null;
  /** Model pinned inside the ConfigSet (NULL = the set's active model — legacy rows). */
  config_model_id: string | null;
  /** 'single' (default) or 'two-stage' — NULL on legacy rows, normalized on read. */
  pipeline_mode: string | null;
  /** ConfigSet of the fast draft pass (two-stage only). */
  draft_config_set_id: string | null;
  /** Model pinned inside the draft ConfigSet (NULL = the set's active model). */
  draft_config_model_id: string | null;
  /** ConfigSet of the refine pass (two-stage only; required to activate). */
  refine_config_set_id: string | null;
  /** Model pinned inside the refine ConfigSet (NULL = the set's active model). */
  refine_config_model_id: string | null;
  /** Agent preset pinned on the project (NULL = 'standard'). */
  preset_id: string | null;
  /** Persistent project instructions injected into every linked session. */
  instructions: string | null;
  /** 0 = active, 1 = archived (no destructive delete without confirmation). */
  archived: number;
  created_at: number;
  updated_at: number;
}

interface ProjectFileRow {
  id: string;
  project_id: string;
  /** Absolute path of the reference file (read at session start, never mounted writable). */
  file_path: string;
  added_at: number;
}

let db: DatabaseInstance | null = null;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

function buildBackupPath(targetPath: string, suffix: string): string {
  return `${targetPath}.${suffix}-${Date.now()}`;
}

function moveIfExists(sourcePath: string, destinationPath: string): void {
  if (!existsSync(sourcePath)) {
    return;
  }
  renameSync(sourcePath, destinationPath);
}

function ensureDirectory(pathToEnsure: string, label: string): void {
  if (!existsSync(pathToEnsure)) {
    mkdirSync(pathToEnsure, { recursive: true });
    return;
  }

  const stats = statSync(pathToEnsure);
  if (stats.isDirectory()) {
    return;
  }

  const backupPath = buildBackupPath(pathToEnsure, 'backup');
  renameSync(pathToEnsure, backupPath);
  logWarn(`[Database] ${label} path is not a directory, moved to backup:`, backupPath);
  mkdirSync(pathToEnsure, { recursive: true });
}

function isSqliteFile(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(fd, buffer, 0, SQLITE_HEADER.length, 0);
    if (bytesRead < SQLITE_HEADER.length) {
      return false;
    }
    return buffer.equals(SQLITE_HEADER);
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function prepareDatabaseDirectory(userDataPath: string): string {
  ensureDirectory(userDataPath, 'userData');

  const dbDir = join(userDataPath, 'data');
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    return dbDir;
  }

  const stats = statSync(dbDir);
  if (stats.isDirectory()) {
    return dbDir;
  }

  const preservedPath = buildBackupPath(dbDir, isSqliteFile(dbDir) ? 'legacy-db' : 'conflict');
  renameSync(dbDir, preservedPath);
  mkdirSync(dbDir, { recursive: true });

  if (isSqliteFile(preservedPath)) {
    const recoveredDbPath = join(dbDir, 'cowork.db');
    renameSync(preservedPath, recoveredDbPath);
    moveIfExists(`${dbDir}-wal`, `${recoveredDbPath}-wal`);
    moveIfExists(`${dbDir}-shm`, `${recoveredDbPath}-shm`);
    logWarn('[Database] Recovered legacy SQLite file into:', recoveredDbPath);
  } else {
    logWarn(
      '[Database] Database directory path was occupied by a file, moved to backup:',
      preservedPath
    );
  }

  return dbDir;
}

/**
 * Get the database file path
 */
function getDatabasePath(): string {
  // Use electron's userData path for persistent storage
  const userDataPath = app.getPath('userData');
  const dbDir = prepareDatabaseDirectory(userDataPath);
  const dbPath = join(dbDir, 'cowork.db');

  if (existsSync(dbPath) && statSync(dbPath).isDirectory()) {
    const backupPath = buildBackupPath(dbPath, 'dir-backup');
    renameSync(dbPath, backupPath);
    logWarn('[Database] Database file path is a directory, moved to backup:', backupPath);
  }

  return dbPath;
}

/**
 * Initialize the database schema
 */
function initializeSchema(database: Database.Database): void {
  try {
    // Enable WAL mode for better performance & concurrent writes.
    // These pragmas MUST run outside a transaction (journal_mode cannot be
    // changed while one is open), so they are kept apart from the DDL block.
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('cache_size = -64000'); // 64MB cache
    database.pragma('temp_store = MEMORY');
    // Multi-process contract: the GUI process, a `--headless` process and a
    // second app launch can all hold cowork.db open at once. WAL allows one
    // writer at a time, so every other writer must WAIT for the lock instead
    // of failing instantly. This is set explicitly rather than inherited from
    // better-sqlite3's implicit 5000ms constructor default, so a future
    // `new Database(path, { timeout })` cannot silently drop the guarantee.
    database.pragma('busy_timeout = 5000');

    // Serialize the entire DDL block against a concurrent migrator. Taking the
    // write lock UP FRONT (BEGIN IMMEDIATE, not the default deferred BEGIN)
    // is what makes the check-then-act in `ensureColumn` safe: a second
    // process cannot interleave its own PRAGMA/ALTER pair inside ours, so the
    // loser's ALTER is the only failure mode left — and that one is already
    // handled idempotently. `runWithWriteLockRetry` covers the case where the
    // other process still holds the lock when we ask for it.
    runSchemaMigrations(database);

    log('[Database] Schema initialized');
  } catch (error) {
    logError('[Database] Schema initialization failed:', error);
    throw error;
  }
}

/**
 * Run the whole schema migration inside one `BEGIN IMMEDIATE` transaction,
 * retrying write-lock contention.
 *
 * Exported (unlike the rest of this module's internals) because it is the one
 * seam a test needs to drive the real migration path against a real database
 * without booting the app.
 */
export function runSchemaMigrations(database: Database.Database): void {
  runWithWriteLockRetry('schema migration', () => {
    database.exec('BEGIN IMMEDIATE');
    try {
      applySchema(database);
      database.exec('COMMIT');
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        logError('[Database] Schema migration rollback failed:', rollbackError);
      }
      throw error;
    }
  });
}

/**
 * The full schema: table creation plus every incremental `ensureColumn`
 * migration. Runs inside the caller's `BEGIN IMMEDIATE` transaction, so it
 * must contain no statement that cannot participate in one.
 */
function applySchema(database: Database.Database): void {
  {
    database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      openai_thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      cwd TEXT,
      mounted_paths TEXT NOT NULL DEFAULT '[]',
      allowed_tools TEXT NOT NULL DEFAULT '[]',
      memory_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

    ensureColumn(database, 'sessions', 'openai_thread_id', 'openai_thread_id TEXT');
    ensureColumn(database, 'sessions', 'model', 'model TEXT');
    ensureColumn(database, 'sessions', 'is_pinned', 'is_pinned INTEGER NOT NULL DEFAULT 0');

    // Create messages table
    database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      token_usage TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

    ensureColumn(database, 'messages', 'execution_time_ms', 'execution_time_ms INTEGER');

    // Create trace steps table
    database.exec(`
    CREATE TABLE IF NOT EXISTS trace_steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      is_error INTEGER,
      timestamp INTEGER NOT NULL,
      duration INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

    // A session accumulates trace steps for every turn it has served. The run
    // column is what lets a report or a lookup attribute a step to one turn;
    // without it the only grouping available is the whole session.
    ensureColumn(database, 'trace_steps', 'run_id', 'run_id TEXT');

    // Create index for faster message queries
    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_id 
    ON messages(session_id)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp 
    ON messages(session_id, timestamp)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_trace_steps_session_id
    ON trace_steps(session_id)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_trace_steps_timestamp
    ON trace_steps(session_id, timestamp)
  `);

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_trace_steps_run
    ON trace_steps(session_id, run_id, timestamp)
  `);

    // Create memory_entries table (for future use)
    database.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

    // Create skills table (for future use)
    database.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT,
      created_at INTEGER NOT NULL
    )
  `);

    database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cwd TEXT NOT NULL,
      project_id TEXT,
      run_at INTEGER NOT NULL,
      next_run_at INTEGER,
      schedule_config TEXT,
      repeat_every INTEGER,
      repeat_unit TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      last_run_session_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
    ensureColumn(database, 'scheduled_tasks', 'schedule_config', 'schedule_config TEXT');
    ensureColumn(database, 'scheduled_tasks', 'project_id', 'project_id TEXT');

    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
    ON scheduled_tasks(enabled, next_run_at)
  `);

    // Create projects table — groups sessions around a shared working
    // context (workdir + persistent instructions + reference files).
    database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      workdir TEXT NOT NULL,
      config_set_id TEXT,
      config_model_id TEXT,
      pipeline_mode TEXT,
      draft_config_set_id TEXT,
      draft_config_model_id TEXT,
      refine_config_set_id TEXT,
      refine_config_model_id TEXT,
      preset_id TEXT,
      instructions TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
    // Legacy projects predate the model pin: NULL = the ConfigSet's active model.
    ensureColumn(database, 'projects', 'config_model_id', 'config_model_id TEXT');
    // Agent preset pin. NULL means "standard", so every pre-preset project
    // keeps its exact previous behaviour. Added through the same hardened
    // ensureColumn path as the columns above.
    ensureColumn(database, 'projects', 'preset_id', 'preset_id TEXT');
    // Two-stage pipeline columns — added after the first release, so existing
    // databases need the same ALTER TABLE path as the model pin above.
    ensureColumn(database, 'projects', 'pipeline_mode', 'pipeline_mode TEXT');
    ensureColumn(database, 'projects', 'draft_config_set_id', 'draft_config_set_id TEXT');
    ensureColumn(database, 'projects', 'draft_config_model_id', 'draft_config_model_id TEXT');
    ensureColumn(database, 'projects', 'refine_config_set_id', 'refine_config_set_id TEXT');
    ensureColumn(database, 'projects', 'refine_config_model_id', 'refine_config_model_id TEXT');

    // Sessions can point at the project they belong to (null = no project).
    ensureColumn(database, 'sessions', 'project_id', 'project_id TEXT');

    // Session-level settings override — the highest level of the
    // global → project → session ladder. NULL means "inherit".
    ensureColumn(database, 'sessions', 'config_set_id', 'config_set_id TEXT');
    ensureColumn(database, 'sessions', 'config_model_id', 'config_model_id TEXT');
    database.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_project_id
    ON sessions(project_id)
  `);

    // Reference files attached to a project: paths read at session start
    // and injected into the agent context (never mounted writable).
    database.exec(`
    CREATE TABLE IF NOT EXISTS project_files (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      UNIQUE(project_id, file_path),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  }
}

function validateIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}

const ALLOWED_COLUMN_TYPES = [
  'TEXT NOT NULL DEFAULT',
  'INTEGER DEFAULT',
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
] as const;

/**
 * True when the error is SQLite's "column already exists" rejection.
 *
 * `initializeSchema` runs BEFORE `createLockResilientDatabase`, so its DDL has
 * no retry wrapper: two processes starting together (GUI + headless
 * delegation) can both read `PRAGMA table_info`, both see the column missing,
 * and the loser's `ALTER TABLE ADD COLUMN` fails with `duplicate column
 * name`. That failure is benign — the column the migration wanted IS there.
 */
function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /duplicate column name/i.test(message);
}

/** Does the column already exist? Re-reads the schema (never cached). */
function columnExists(
  database: Database.Database,
  table: string,
  column: string
): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  validateIdentifier(table);
  validateIdentifier(column);

  // Reconstruct definition from validated parts to prevent SQL injection.
  // The definition format is: "<column> <TYPE_SUFFIX>" — extract the type
  // suffix that follows the column name and validate it against an allowlist.
  const prefix = column + ' ';
  if (!definition.startsWith(prefix)) {
    throw new Error(`Column definition must start with column name: ${definition}`);
  }
  const typeSuffix = definition.slice(prefix.length).trim().toUpperCase();
  const matchedType = ALLOWED_COLUMN_TYPES.find(
    (t) => typeSuffix === t || typeSuffix.startsWith(t + ' ')
  );
  if (!matchedType) {
    throw new Error(`Unsupported column type in definition: ${typeSuffix}`);
  }
  // Use only the validated column name + original (non-uppercased) suffix so
  // that default value tokens are preserved exactly as authored.
  const originalSuffix = definition.slice(prefix.length).trim();
  const safeDefinition = `${column} ${originalSuffix}`;

  if (columnExists(database, table, column)) {
    return;
  }

  try {
    // Serialize DDL against a concurrent migrator: WAL admits one writer, so
    // losing the race surfaces as SQLITE_BUSY and is retried instead of
    // aborting startup.
    runWithWriteLockRetry(`ALTER TABLE ${table} ADD COLUMN ${column}`, () =>
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${safeDefinition}`)
    );
  } catch (error) {
    // Lost a check-then-act race with a second process that added the same
    // column first. Treat it as success, but only after confirming the column
    // really is there — a genuine failure must never be swallowed.
    if (!isDuplicateColumnError(error)) throw error;
    if (!columnExists(database, table, column)) {
      throw new Error(
        `Migration of ${table}.${column} failed with a duplicate-column error but the column is absent: ${String(error)}`
      );
    }
    log(
      `[Database] ${table}.${column} was added concurrently by another process — migration satisfied`
    );
  }
}

/**
 * SQLite lock errors that are worth retrying.
 *
 * WAL admits one writer at a time; the others wait inside SQLite for
 * `busy_timeout` milliseconds. When that wait expires the statement throws
 * SQLITE_BUSY — or SQLITE_BUSY_SNAPSHOT when a deferred read-then-write
 * transaction holds a stale snapshot, which the busy handler does NOT retry.
 * Because several Open Cowork processes can share cowork.db, a write that
 * loses this race must be retried or fail with a clear log, never crash the
 * main process.
 */
function isSqliteLockError(error: unknown): error is { code: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
  );
}

/**
 * Block the calling thread for a short backoff. better-sqlite3 is synchronous,
 * so there is no awaitable sleep on this path.
 */
function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

/**
 * Thrown when a write never obtained the SQLite write lock. Callers can catch
 * this to report a clean, actionable failure instead of a cryptic driver error.
 */
export class DatabaseWriteLockedError extends Error {
  readonly code: string;
  readonly operation: string;

  constructor(operation: string, attempts: number, cause: unknown) {
    super(
      `Database write "${operation}" could not acquire the SQLite write lock after ${attempts} attempts; another Open Cowork process is holding it.`
    );
    this.name = 'DatabaseWriteLockedError';
    this.operation = operation;
    this.code = isSqliteLockError(cause) ? cause.code : 'SQLITE_BUSY';
    this.cause = cause;
  }
}

// One retry on top of the 5000ms the connection already waits inside SQLite.
// Worst case for a contended write is therefore ~10s of in-process blocking,
// which is only reached when another process holds the lock the whole time;
// the alternative — dropping the write — is worse for data integrity.
const WRITE_LOCK_ATTEMPTS = 2;
const WRITE_LOCK_BACKOFF_MS = 200;

/**
 * Run a write, retrying only lock contention. Any other error (constraint
 * violation, bug) propagates immediately so it is never hidden by a retry.
 */
export function runWithWriteLockRetry<T>(operation: string, run: () => T): T {
  let lastError: unknown;
  for (let attempt = 1; attempt <= WRITE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      return run();
    } catch (error) {
      if (!isSqliteLockError(error)) throw error;
      lastError = error;
      if (attempt < WRITE_LOCK_ATTEMPTS) {
        logWarn(
          `[Database] Write "${operation}" blocked by another process (${error.code}), retrying after ${WRITE_LOCK_BACKOFF_MS}ms`
        );
        sleepSync(WRITE_LOCK_BACKOFF_MS);
      }
    }
  }
  const locked = new DatabaseWriteLockedError(operation, WRITE_LOCK_ATTEMPTS, lastError);
  logError(locked.message);
  throw locked;
}

/**
 * Route every statement's `run()` (the INSERT/UPDATE/DELETE path) through
 * runWithWriteLockRetry. Only `run` is wrapped: reads, `.all()`, `.get()`,
 * `.exec()` and DDL keep their exact behaviour. Wrapping at the connection
 * level means a write added later is protected by construction.
 */
function createLockResilientDatabase(database: Database.Database): Database.Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        return (source: string): Database.Statement => {
          const statement = target.prepare(source);
          const originalRun = statement.run.bind(statement);
          const label = source.replace(/\s+/g, ' ').trim().slice(0, 80);
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === 'run') {
                return (...parameters: unknown[]) =>
                  runWithWriteLockRetry(label, () =>
                    (originalRun as (...args: unknown[]) => unknown)(...parameters)
                  );
              }
              const value = Reflect.get(statementTarget, statementProperty, statementTarget);
              return typeof value === 'function' ? value.bind(statementTarget) : value;
            },
          }) as Database.Statement;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database.Database;
}

/**
 * Initialize the database
 */
export function initDatabase(): DatabaseInstance {
  if (db) return db;

  const dbPath = getDatabasePath();
  log('[Database] Opening database at:', dbPath);

  let rawDb: Database.Database;
  try {
    rawDb = new Database(dbPath);
  } catch (error) {
    logError('[Database] Failed to open database at:', dbPath, error);
    throw error;
  }

  // Enable foreign keys
  rawDb.pragma('foreign_keys = ON');

  // Initialize schema
  initializeSchema(rawDb);

  // From here on, every statement prepared through `rawDb` retries write-lock
  // contention from another process instead of throwing on the first
  // SQLITE_BUSY (see createLockResilientDatabase).
  rawDb = createLockResilientDatabase(rawDb);

  // Prepare statements for better performance
  const insertSession = rawDb.prepare(`
    INSERT OR REPLACE INTO sessions
    (id, title, claude_session_id, openai_thread_id, status, cwd, mounted_paths, allowed_tools, memory_enabled, model, project_id, config_set_id, config_model_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Note: Dynamic update queries are built in sessions.update() for flexibility
  // const updateSessionStmt = rawDb.prepare(`
  //   UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?
  // `);

  const getSessionStmt = rawDb.prepare(`
    SELECT * FROM sessions WHERE id = ?
  `);

  const getAllSessionsStmt = rawDb.prepare(`
    SELECT * FROM sessions ORDER BY is_pinned DESC, updated_at DESC
  `);

  const deleteSessionStmt = rawDb.prepare(`
    DELETE FROM sessions WHERE id = ?
  `);

  const insertMessage = rawDb.prepare(`
    INSERT INTO messages (id, session_id, role, content, timestamp, token_usage, execution_time_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const getMessagesBySessionStmt = rawDb.prepare(`
    SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC
  `);

  const updateMessageStmt = rawDb.prepare(`
    UPDATE messages SET execution_time_ms = ? WHERE id = ?
  `);

  const deleteMessageStmt = rawDb.prepare(`
    DELETE FROM messages WHERE id = ?
  `);

  const deleteMessagesBySessionStmt = rawDb.prepare(`
    DELETE FROM messages WHERE session_id = ?
  `);

  const insertTraceStep = rawDb.prepare(`
    INSERT OR REPLACE INTO trace_steps (
      id, session_id, run_id, type, status, title, content, tool_name, tool_input, tool_output, is_error, timestamp, duration
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getTraceStepsBySessionStmt = rawDb.prepare(`
    SELECT * FROM trace_steps WHERE session_id = ? ORDER BY timestamp ASC
  `);

  const getTraceStepsByRunStmt = rawDb.prepare(`
    SELECT * FROM trace_steps WHERE session_id = ? AND run_id = ? ORDER BY timestamp ASC
  `);

  const deleteTraceStepsBySessionStmt = rawDb.prepare(`
    DELETE FROM trace_steps WHERE session_id = ?
  `);

  const insertScheduledTask = rawDb.prepare(`
    INSERT OR REPLACE INTO scheduled_tasks (
      id, title, prompt, cwd, project_id, run_at, next_run_at, schedule_config, repeat_every, repeat_unit, enabled, last_run_at, last_run_session_id, last_error, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getScheduledTaskStmt = rawDb.prepare(`
    SELECT * FROM scheduled_tasks WHERE id = ?
  `);

  const getAllScheduledTasksStmt = rawDb.prepare(`
    SELECT * FROM scheduled_tasks ORDER BY created_at ASC
  `);

  const deleteScheduledTaskStmt = rawDb.prepare(`
    DELETE FROM scheduled_tasks WHERE id = ?
  `);

  const insertProject = rawDb.prepare(`
    INSERT INTO projects (
      id, name, description, workdir, config_set_id, config_model_id,
      pipeline_mode, draft_config_set_id, draft_config_model_id,
      refine_config_set_id, refine_config_model_id,
      preset_id, instructions, archived, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getProjectStmt = rawDb.prepare(`
    SELECT * FROM projects WHERE id = ?
  `);

  const getAllProjectsStmt = rawDb.prepare(`
    SELECT * FROM projects ORDER BY created_at DESC
  `);

  const deleteProjectStmt = rawDb.prepare(`
    DELETE FROM projects WHERE id = ?
  `);

  const insertProjectFile = rawDb.prepare(`
    INSERT OR IGNORE INTO project_files (id, project_id, file_path, added_at)
    VALUES (?, ?, ?, ?)
  `);

  const deleteProjectFileStmt = rawDb.prepare(`
    DELETE FROM project_files WHERE project_id = ? AND file_path = ?
  `);

  const getProjectFilesStmt = rawDb.prepare(`
    SELECT * FROM project_files WHERE project_id = ? ORDER BY added_at ASC
  `);

  const deleteProjectFilesByProjectStmt = rawDb.prepare(`
    DELETE FROM project_files WHERE project_id = ?
  `);

  db = {
    raw: rawDb,

    sessions: {
      create: (session: SessionRow) => {
        insertSession.run(
          session.id,
          session.title,
          session.claude_session_id,
          session.openai_thread_id,
          session.status,
          session.cwd,
          session.mounted_paths,
          session.allowed_tools,
          session.memory_enabled,
          session.model,
          session.project_id ?? null,
          session.config_set_id ?? null,
          session.config_model_id ?? null,
          session.created_at,
          session.updated_at
        );
      },

      update: (id: string, updates: Partial<SessionRow>) => {
        // Columns that must never be overwritten after insert
        const IMMUTABLE_COLUMNS = new Set(['id', 'created_at']);

        // Build dynamic update query
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            if (IMMUTABLE_COLUMNS.has(key)) continue;
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }

        if (setClauses.length === 0) return;

        // Always update updated_at
        setClauses.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);

        const sql = `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`;
        rawDb.prepare(sql).run(...values);
      },

      get: (id: string): SessionRow | undefined => {
        return getSessionStmt.get(id) as SessionRow | undefined;
      },

      getAll: (): SessionRow[] => {
        return getAllSessionsStmt.all() as SessionRow[];
      },

      delete: (id: string) => {
        // Messages will be deleted automatically due to ON DELETE CASCADE
        deleteSessionStmt.run(id);
      },
    },

    messages: {
      create: (message: MessageRow) => {
        insertMessage.run(
          message.id,
          message.session_id,
          message.role,
          message.content,
          message.timestamp,
          message.token_usage,
          message.execution_time_ms ?? null
        );
      },

      update: (id: string, updates: Partial<Pick<MessageRow, 'execution_time_ms'>>) => {
        if (updates.execution_time_ms !== undefined) {
          updateMessageStmt.run(updates.execution_time_ms, id);
        }
      },

      getBySessionId: (sessionId: string): MessageRow[] => {
        return getMessagesBySessionStmt.all(sessionId) as MessageRow[];
      },

      delete: (id: string) => {
        deleteMessageStmt.run(id);
      },

      deleteBySessionId: (sessionId: string) => {
        deleteMessagesBySessionStmt.run(sessionId);
      },
    },

    traceSteps: {
      create: (step: TraceStepRow) => {
        // Bounded at the storage layer, not at the call sites: a tool that
        // returns a build log must not be able to add megabytes to one row,
        // and a bound applied upstream is undone by the next caller that
        // forgets it. See retention.ts.
        const bounded = boundTraceStepRow({
          content: step.content,
          tool_output: step.tool_output,
          tool_input: step.tool_input,
        });
        insertTraceStep.run(
          step.id,
          step.session_id,
          step.run_id ?? null,
          step.type,
          step.status,
          step.title,
          bounded.content,
          step.tool_name,
          bounded.tool_input,
          bounded.tool_output,
          step.is_error,
          step.timestamp,
          step.duration
        );
      },

      update: (id: string, updates: Partial<TraceStepRow>) => {
        const setClauses: string[] = [];
        const values: unknown[] = [];
        // Same storage-layer bound as create(): a tool result arrives here as
        // an update, which is the path a long-running tool actually takes.
        const boundedUpdates = boundTraceStepRow(updates);

        for (const [key, value] of Object.entries(boundedUpdates)) {
          if (value !== undefined) {
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }

        if (setClauses.length === 0) return;

        values.push(id);
        const sql = `UPDATE trace_steps SET ${setClauses.join(', ')} WHERE id = ?`;
        rawDb.prepare(sql).run(...values);
      },

      getBySessionId: (sessionId: string): TraceStepRow[] => {
        return getTraceStepsBySessionStmt.all(sessionId) as TraceStepRow[];
      },

      getByRunId: (sessionId: string, runId: string): TraceStepRow[] => {
        return getTraceStepsByRunStmt.all(sessionId, runId) as TraceStepRow[];
      },

      deleteBySessionId: (sessionId: string) => {
        deleteTraceStepsBySessionStmt.run(sessionId);
      },
    },

    scheduledTasks: {
      create: (task: ScheduledTaskRow) => {
        insertScheduledTask.run(
          task.id,
          task.title,
          task.prompt,
          task.cwd,
          task.project_id,
          task.run_at,
          task.next_run_at,
          task.schedule_config,
          task.repeat_every,
          task.repeat_unit,
          task.enabled,
          task.last_run_at,
          task.last_run_session_id,
          task.last_error,
          task.created_at,
          task.updated_at
        );
      },

      update: (id: string, updates: Partial<ScheduledTaskRow>) => {
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }

        if (setClauses.length === 0) return;

        setClauses.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);

        const sql = `UPDATE scheduled_tasks SET ${setClauses.join(', ')} WHERE id = ?`;
        rawDb.prepare(sql).run(...values);
      },

      get: (id: string): ScheduledTaskRow | undefined => {
        return getScheduledTaskStmt.get(id) as ScheduledTaskRow | undefined;
      },

      getAll: (): ScheduledTaskRow[] => {
        return getAllScheduledTasksStmt.all() as ScheduledTaskRow[];
      },

      delete: (id: string) => {
        deleteScheduledTaskStmt.run(id);
      },
    },

    projects: {
      create: (project: ProjectRow) => {
        insertProject.run(
          project.id,
          project.name,
          project.description,
          project.workdir,
          project.config_set_id,
          project.config_model_id,
          project.pipeline_mode,
          project.draft_config_set_id,
          project.draft_config_model_id,
          project.refine_config_set_id,
          project.refine_config_model_id,
          project.preset_id,
          project.instructions,
          project.archived,
          project.created_at,
          project.updated_at
        );
      },

      update: (id: string, updates: Partial<ProjectRow>) => {
        const IMMUTABLE_COLUMNS = new Set(['id', 'created_at']);
        const setClauses: string[] = [];
        const values: unknown[] = [];

        for (const [key, value] of Object.entries(updates)) {
          if (value !== undefined) {
            if (IMMUTABLE_COLUMNS.has(key)) continue;
            validateIdentifier(key);
            setClauses.push(`${key} = ?`);
            values.push(value);
          }
        }

        if (setClauses.length === 0) return;

        setClauses.push('updated_at = ?');
        values.push(Date.now());
        values.push(id);

        const sql = `UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`;
        rawDb.prepare(sql).run(...values);
      },

      get: (id: string): ProjectRow | undefined => {
        return getProjectStmt.get(id) as ProjectRow | undefined;
      },

      getAll: (): ProjectRow[] => {
        return getAllProjectsStmt.all() as ProjectRow[];
      },

      delete: (id: string) => {
        deleteProjectStmt.run(id);
      },
    },

    projectFiles: {
      add: (file: ProjectFileRow) => {
        insertProjectFile.run(file.id, file.project_id, file.file_path, file.added_at);
      },

      remove: (projectId: string, filePath: string) => {
        deleteProjectFileStmt.run(projectId, filePath);
      },

      listByProject: (projectId: string): ProjectFileRow[] => {
        return getProjectFilesStmt.all(projectId) as ProjectFileRow[];
      },

      deleteByProject: (projectId: string) => {
        deleteProjectFilesByProjectStmt.run(projectId);
      },
    },

    // Compatibility layer for old interface
    prepare: (sql: string) => rawDb.prepare(sql),
    exec: (sql: string) => rawDb.exec(sql),
    pragma: (pragma: string) => rawDb.pragma(pragma),
    close: () => {
      rawDb.close();
      db = null;
    },
  };

  log('[Database] SQLite database initialized successfully');
  return db!;
}

/**
 * Get the existing database instance
 */
export function getDatabase(): DatabaseInstance {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    log('[Database] Database closed');
  }
}
