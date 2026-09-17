/**
 * Versioned virtual memory files store.
 *
 * Implements the "virtual memory files" backend described in
 * installation-memoire.md, backed by an existing better-sqlite3
 * connection (WAL). All operations are synchronous and CAS-based:
 * every mutation takes an `ifVersion` token read beforehand and is
 * executed inside an IMMEDIATE transaction, so a stale token results
 * in a typed conflict carrying the current content/version.
 *
 * Key invariants:
 * - Owner isolation: `owner` is supplied by the trusted caller on every
 *   method (never taken from model output). `source` is a trusted
 *   constructor option recording which backend wrote the data.
 * - Logical paths are canonical absolute .md paths (`/a/b.md`).
 * - Per-file size cap, file-count quota, total-bytes quota; revision
 *   history is bounded per path AND per owner (count + bytes, with
 *   history counted into the owner's total footprint).
 * - Version tokens are random UUIDs: rewriting identical content, and
 *   even delete/recreate cycles, always produce a new token (no ABA).
 *   A monotonic per-file revision plus a generation counter (bumped on
 *   recreate) keep history ordering unambiguous across generations.
 * - Bounded per-file revision history (including deletion markers) is
 *   written transactionally for recovery; use readHistory().
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

/** Machine-readable error codes for MemoryFilesError. */
export type MemoryFilesErrorCode =
  | 'invalid_path'
  | 'invalid_owner'
  | 'invalid_input'
  | 'file_too_large'
  | 'quota_exceeded'
  | 'not_found'
  | 'version_conflict'
  | 'ambiguous_match'
  | 'invalid_version_token'
  | 'db_error';

/**
 * Typed error thrown by all MemoryFilesStore operations.
 * `conflict` carries the current content/version on version conflicts.
 */
export class MemoryFilesError extends Error {
  readonly code: MemoryFilesErrorCode;
  readonly conflict?: { readonly currentContent: string; readonly currentVersion: string };

  constructor(
    code: MemoryFilesErrorCode,
    message: string,
    conflict?: { currentContent: string; currentVersion: string }
  ) {
    super(message);
    this.name = 'MemoryFilesError';
    this.code = code;
    this.conflict = conflict;
  }
}

/** Summary entry returned by list(). */
export interface MemoryFileSummary {
  readonly path: string;
  readonly sizeBytes: number;
  readonly version: string;
  readonly updatedAt: number;
  /** One-line preview, present only when includePreview was set. */
  readonly preview?: string;
}

/** Full single-file read result. */
export interface MemoryFileRead {
  readonly path: string;
  readonly content: string;
  readonly version: string;
  readonly sizeBytes: number;
  readonly updatedAt: number;
}

/** Batch read result: found files plus explicitly reported missing paths. */
export interface MemoryFileBatchRead {
  readonly files: MemoryFileRead[];
  readonly missing: string[];
}

/** Result of a successful create/replace/append/str_replace. */
export interface MemoryWriteResult {
  readonly path: string;
  /** Fresh opaque version token (UUID). Persist it for the next CAS op. */
  readonly version: string;
  readonly sizeBytes: number;
  /** Monotonic per-file revision within the current generation (starts at 1). */
  readonly revision: number;
  /** Generation counter, bumped on every create that follows a delete. */
  readonly generation: number;
}

/** Result of a successful delete. */
export interface MemoryDeleteResult {
  readonly path: string;
  readonly revision: number;
  readonly generation: number;
  readonly timestamp: number;
}

/** Historical revision entry (including deletion markers). */
export interface MemoryFileRevision {
  readonly revision: number;
  readonly generation: number;
  readonly content: string | null; // null when deleted
  readonly version: string | null; // null when deleted
  readonly sizeBytes: number;
  readonly deleted: boolean;
  readonly source: string;
  readonly owner: string;
  readonly timestamp: number;
}

/** Footprint statistics returned by usage(). */
export interface MemoryFilesUsage {
  readonly files: number;
  readonly liveBytes: number;
  readonly historyEntries: number;
  readonly historyBytes: number;
  readonly limits: Required<MemoryFilesStoreOptions>;
}

export interface MemoryFilesStoreOptions {
  /** Max UTF-8 bytes per file. Default 100_000. */
  maxFileBytes?: number;
  /** Max number of live files per owner. Default 1000. */
  maxFiles?: number;
  /** Max total UTF-8 bytes per owner (live files + retained history). Default 10 MB. */
  maxTotalBytes?: number;
  /** Revisions kept per path, including deletion markers. Default 10. */
  historyPerFile?: number;
  /**
   * Hard cap on history rows per owner (safety net over the combined
   * bytes quota). Default 10_000.
   */
  maxHistoryEntries?: number;
  /** Trusted source label recorded in history (never model-controlled). */
  source?: string;
}

interface FileRow {
  path: string;
  content: string;
  version: string;
  revision: number;
  generation: number;
  size_bytes: number;
  updated_at: number;
}

interface RevisionRow {
  revision: number;
  generation: number;
  content: string | null;
  version: string | null;
  size_bytes: number;
  deleted: number;
  source: string;
  owner: string;
  timestamp: number;
}

const PREVIEW_MAX_CHARS = 120;
const MAX_BATCH_READ = 20;
const MAX_PATH_LENGTH = 512;
const SPECIAL_TOKEN_NEW = 'new';
const DEFAULT_MAX_FILE_BYTES = 100_000;
const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_HISTORY_PER_FILE = 10;
const DEFAULT_MAX_HISTORY_ENTRIES = 10_000;
const DEFAULT_SOURCE = 'memory-files-backend';

/**
 * Extract a single-line preview from file content (first non-empty line,
 * truncated). Exported for reuse by tool layers.
 */
export function extractPreview(content: string, maxChars = PREVIEW_MAX_CHARS): string {
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? '';
  const collapsed = firstLine.trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Validate and canonicalize a logical memory file path.
 * Accepted: `/something.md`, `/dir/sub/name.md`.
 * Rejected: traversal (`..`), backslashes, control characters, missing
 * or non-.md extension, empty segments (`//`), trailing slash, empty
 * string, and over-long paths. Canonical form is returned unchanged so
 * aliases cannot collide.
 */
export function canonicalizeMemoryPath(rawPath: string): string {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new MemoryFilesError('invalid_path', 'Path must be a non-empty string.');
  }
  if (rawPath.includes('\\')) {
    throw new MemoryFilesError('invalid_path', 'Backslashes are not allowed in memory paths.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(rawPath)) {
    throw new MemoryFilesError(
      'invalid_path',
      'Control characters are not allowed in memory paths.'
    );
  }
  if (!rawPath.startsWith('/')) {
    throw new MemoryFilesError('invalid_path', 'Memory paths must be absolute and start with "/".');
  }
  if (rawPath.includes('//')) {
    throw new MemoryFilesError('invalid_path', 'Empty path segments are not allowed.');
  }
  if (rawPath.endsWith('/')) {
    throw new MemoryFilesError('invalid_path', 'Memory paths must end with a file name.');
  }
  if (rawPath.includes('..')) {
    throw new MemoryFilesError('invalid_path', 'Path traversal is not allowed.');
  }
  const segments = rawPath.slice(1).split('/');
  for (const segment of segments) {
    if (
      segment === '.' ||
      segment === '..' ||
      segment === '.md' ||
      segment.trim() !== segment ||
      segment.endsWith('.') ||
      segment.normalize('NFC') !== segment ||
      /%[0-9a-f]{2}/i.test(segment)
    ) {
      throw new MemoryFilesError('invalid_path', 'Path segments "." and ".." are not allowed.');
    }
  }
  if (!rawPath.endsWith('.md')) {
    throw new MemoryFilesError('invalid_path', 'Memory files must use the ".md" extension.');
  }
  if (rawPath.length > MAX_PATH_LENGTH) {
    throw new MemoryFilesError(
      'invalid_path',
      `Memory path is too long (max ${MAX_PATH_LENGTH} chars).`
    );
  }
  return rawPath;
}

function assertOwner(owner: string): void {
  if (typeof owner !== 'string' || owner.trim().length === 0 || owner.length > 256) {
    throw new MemoryFilesError(
      'invalid_owner',
      'Owner must be a non-empty string (max 256 chars).'
    );
  }
}

function utf8ByteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

function newVersionToken(): string {
  return randomUUID();
}

function isValidVersionToken(token: unknown): boolean {
  return (
    typeof token === 'string' &&
    (token === SPECIAL_TOKEN_NEW ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token))
  );
}

/**
 * Versioned virtual memory files store. All operations are synchronous;
 * mutations run in IMMEDIATE transactions on the supplied connection.
 * Tables are created idempotently in the constructor — no new database
 * connection and no async resources are created.
 */
export class MemoryFilesStore {
  private readonly db: Database.Database;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly historyPerFile: number;
  private readonly maxHistoryEntries: number;
  private readonly source: string;
  private initialized = false;

  constructor(db: Database.Database, options: MemoryFilesStoreOptions = {}) {
    this.db = db;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.historyPerFile = options.historyPerFile ?? DEFAULT_HISTORY_PER_FILE;
    this.maxHistoryEntries = options.maxHistoryEntries ?? DEFAULT_MAX_HISTORY_ENTRIES;
    this.source = options.source ?? DEFAULT_SOURCE;
    for (const value of [
      this.maxFileBytes,
      this.maxFiles,
      this.maxTotalBytes,
      this.historyPerFile,
      this.maxHistoryEntries,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new MemoryFilesError('invalid_input', 'Store limits must be positive safe integers.');
      }
    }
    if (
      this.maxFileBytes > DEFAULT_MAX_FILE_BYTES ||
      this.historyPerFile > DEFAULT_HISTORY_PER_FILE ||
      this.maxFiles > DEFAULT_MAX_FILES ||
      this.maxTotalBytes > DEFAULT_MAX_TOTAL_BYTES ||
      this.maxHistoryEntries > DEFAULT_MAX_HISTORY_ENTRIES
    ) {
      throw new MemoryFilesError(
        'invalid_input',
        'Store limits cannot exceed the built-in safety caps.'
      );
    }
    if (
      typeof this.source !== 'string' ||
      this.source.trim().length === 0 ||
      this.source.length > 128
    ) {
      throw new MemoryFilesError(
        'invalid_input',
        'source must be a non-empty string (max 128 chars).'
      );
    }
    this.initialize();
  }

  private initialize(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_files (
          owner      TEXT NOT NULL,
          path       TEXT NOT NULL,
          content    TEXT NOT NULL,
          version    TEXT NOT NULL,
          revision   INTEGER NOT NULL,
          generation INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (owner, path)
        )
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_files_history (
          owner      TEXT NOT NULL,
          path       TEXT NOT NULL,
          generation INTEGER NOT NULL,
          revision   INTEGER NOT NULL,
          content    TEXT,
          version    TEXT,
          size_bytes INTEGER NOT NULL,
          deleted    INTEGER NOT NULL DEFAULT 0,
          source     TEXT NOT NULL,
          timestamp  INTEGER NOT NULL,
          PRIMARY KEY (owner, path, generation, revision)
        )
      `);
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_files_owner_path ON memory_files (owner, path)'
      );
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_memory_files_history_owner_ts ON memory_files_history (owner, timestamp)'
      );
      this.initialized = true;
    } catch (error) {
      throw new MemoryFilesError('db_error', 'Memory file database operation failed.');
    }
  }

  /** True when the schema has been created on the connection. */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * List files for an owner, sorted by path. `pathPrefix` is a literal
   * (non-glob) string prefix, e.g. `/projects/` (matching is a plain
   * startsWith — wildcards are not interpreted). Set `includePreview`
   * to add a one-line preview per file.
   */
  list(
    owner: string,
    options: { pathPrefix?: string; includePreview?: boolean } = {}
  ): MemoryFileSummary[] {
    assertOwner(owner);
    let prefix = '';
    if (options.pathPrefix !== undefined) {
      prefix = options.pathPrefix;
      if (prefix.length > 0) {
        if (!prefix.startsWith('/') || prefix.includes('\\') || prefix.includes('..')) {
          throw new MemoryFilesError('invalid_path', `Invalid path prefix: ${prefix}`);
        }
        if (
          // eslint-disable-next-line no-control-regex
          /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(prefix)
        ) {
          throw new MemoryFilesError(
            'invalid_path',
            'Control characters are not allowed in path prefix.'
          );
        }
      }
    }
    try {
      const rows = this.db
        .prepare(
          `SELECT path, size_bytes, version, updated_at, content
           FROM memory_files
           WHERE owner = ? AND substr(path, 1, ?) = ?
           ORDER BY path ASC`
        )
        .all(owner, [...prefix].length, prefix) as Array<
        Pick<FileRow, 'path' | 'size_bytes' | 'version' | 'updated_at' | 'content'>
      >;
      return rows.map((row) => ({
        path: row.path,
        sizeBytes: row.size_bytes,
        version: row.version,
        updatedAt: row.updated_at,
        ...(options.includePreview ? { preview: extractPreview(row.content) } : {}),
      }));
    } catch (error) {
      if (error instanceof MemoryFilesError) throw error;
      throw new MemoryFilesError('db_error', 'Memory file database operation failed.');
    }
  }

  /** Read a single file. Throws not_found when missing. */
  read(owner: string, path: string): MemoryFileRead;
  /** Read up to 20 files; missing paths are reported, not thrown. */
  read(owner: string, paths: string[]): MemoryFileBatchRead;
  read(owner: string, path: string | string[]): MemoryFileRead | MemoryFileBatchRead {
    assertOwner(owner);
    if (!Array.isArray(path)) {
      const canonical = canonicalizeMemoryPath(path);
      const row = this.getRow(owner, canonical);
      if (!row) {
        throw new MemoryFilesError('not_found', `Memory file not found: ${canonical}`);
      }
      return {
        path: row.path,
        content: row.content,
        version: row.version,
        sizeBytes: row.size_bytes,
        updatedAt: row.updated_at,
      };
    }
    if (path.length === 0) {
      throw new MemoryFilesError('invalid_input', 'Read requires at least one path.');
    }
    if (path.length > MAX_BATCH_READ) {
      throw new MemoryFilesError(
        'invalid_input',
        `Read supports at most ${MAX_BATCH_READ} paths per call.`
      );
    }
    const files: MemoryFileRead[] = [];
    const missing: string[] = [];
    for (const raw of path) {
      const canonical = canonicalizeMemoryPath(raw);
      const row = this.getRow(owner, canonical);
      if (row) {
        files.push({
          path: row.path,
          content: row.content,
          version: row.version,
          sizeBytes: row.size_bytes,
          updatedAt: row.updated_at,
        });
      } else {
        missing.push(canonical);
      }
    }
    return { files, missing };
  }

  /**
   * Create or replace a file. `ifVersion` must be 'new' to create, or
   * the token returned by a previous read/write. On mismatch a
   * version_conflict error carrying current content/version is thrown.
   */
  write(owner: string, path: string, content: string, ifVersion: string): MemoryWriteResult {
    assertOwner(owner);
    const canonical = canonicalizeMemoryPath(path);
    this.assertContent(content);
    this.assertToken(ifVersion);
    try {
      const run = this.db.transaction(
        (currentOwner: string, p: string, c: string, token: string) => {
          const existing = this.getRow(currentOwner, p);
          const size = utf8ByteLength(c);
          if (existing === null) {
            if (token !== SPECIAL_TOKEN_NEW) {
              throw new MemoryFilesError(
                'version_conflict',
                `Memory file ${p} does not exist but if_version was not 'new'.`,
                { currentContent: '', currentVersion: SPECIAL_TOKEN_NEW }
              );
            }
            const generation = this.nextGeneration(currentOwner, p);
            this.assertQuotas(currentOwner, {
              newFile: true,
              liveBytesDelta: size,
            });
            const revision = 1;
            const version = newVersionToken();
            this.db
              .prepare(
                `INSERT INTO memory_files (owner, path, content, version, revision, generation, size_bytes, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(currentOwner, p, c, version, revision, generation, size, Date.now());
            this.recordHistory(currentOwner, p, generation, revision, c, version, size, false);
            return { path: p, version, sizeBytes: size, revision, generation };
          }
          if (token === SPECIAL_TOKEN_NEW) {
            throw new MemoryFilesError(
              'version_conflict',
              `Memory file ${p} already exists; if_version was 'new'.`,
              { currentContent: existing.content, currentVersion: existing.version }
            );
          }
          if (existing.version !== token) {
            throw new MemoryFilesError(
              'version_conflict',
              `Version conflict on memory file ${p}.`,
              {
                currentContent: existing.content,
                currentVersion: existing.version,
              }
            );
          }
          const sizeDelta = size - existing.size_bytes;
          this.assertQuotas(currentOwner, {
            newFile: false,
            liveBytesDelta: sizeDelta,
          });
          const revision = existing.revision + 1;
          const version = newVersionToken();
          this.db
            .prepare(
              `UPDATE memory_files
               SET content = ?, version = ?, revision = ?, size_bytes = ?, updated_at = ?
               WHERE owner = ? AND path = ?`
            )
            .run(c, version, revision, size, Date.now(), currentOwner, p);
          this.recordHistory(
            currentOwner,
            p,
            existing.generation,
            revision,
            c,
            version,
            size,
            false
          );
          return { path: p, version, sizeBytes: size, revision, generation: existing.generation };
        }
      );
      const result = run.immediate(owner, canonical, content, ifVersion);
      return {
        path: result.path,
        version: result.version,
        sizeBytes: result.sizeBytes,
        revision: result.revision,
        generation: result.generation,
      };
    } catch (error) {
      if (error instanceof MemoryFilesError) throw error;
      throw new MemoryFilesError('db_error', 'Memory file database operation failed.');
    }
  }

  /**
   * Append content to an existing file. The file must exist and match
   * `ifVersion`. CAS is preserved: the merged content is written under
   * the same IMMEDIATE transaction as the version check inside write().
   */
  append(owner: string, path: string, content: string, ifVersion: string): MemoryWriteResult {
    assertOwner(owner);
    if (typeof content !== 'string' || content.length === 0) {
      throw new MemoryFilesError('invalid_input', 'Append content must be a non-empty string.');
    }
    return this.transform(owner, path, ifVersion, (existing) => `${existing}${content}`);
  }

  /**
   * Replace an exact, unique occurrence of `oldStr` with `newStr`.
   * Zero occurrences → not_found; more than one occurrence (counted
   * overlap-safely) → ambiguous_match.
   */
  strReplace(
    owner: string,
    path: string,
    oldStr: string,
    newStr: string,
    ifVersion: string
  ): MemoryWriteResult {
    assertOwner(owner);
    if (typeof oldStr !== 'string' || oldStr.length === 0) {
      throw new MemoryFilesError('invalid_input', 'old_str must be a non-empty string.');
    }
    if (typeof newStr !== 'string') {
      throw new MemoryFilesError('invalid_input', 'new_str must be a string.');
    }
    return this.transform(owner, path, ifVersion, (content) => {
      const first = content.indexOf(oldStr);
      if (first === -1) {
        throw new MemoryFilesError('not_found', 'old_str not found in memory file.');
      }
      // Searching from the next character detects overlapping matches.
      if (content.indexOf(oldStr, first + 1) !== -1) {
        throw new MemoryFilesError('ambiguous_match', 'old_str must match exactly one location.');
      }
      return `${content.slice(0, first)}${newStr}${content.slice(first + oldStr.length)}`;
    });
  }

  /**
   * Delete a file (a deletion marker is kept in bounded history).
   * `ifVersion` must match the current token.
   */
  delete(owner: string, path: string, ifVersion: string): MemoryDeleteResult {
    assertOwner(owner);
    const canonical = canonicalizeMemoryPath(path);
    this.assertToken(ifVersion);
    try {
      const run = this.db.transaction((currentOwner: string, p: string, token: string) => {
        const existing = this.getRow(currentOwner, p);
        if (!existing) {
          throw new MemoryFilesError('not_found', `Memory file not found: ${p}`);
        }
        if (existing.version !== token) {
          throw new MemoryFilesError('version_conflict', `Version conflict on memory file ${p}.`, {
            currentContent: existing.content,
            currentVersion: existing.version,
          });
        }
        const revision = existing.revision + 1;
        const timestamp = Date.now();
        this.db
          .prepare('DELETE FROM memory_files WHERE owner = ? AND path = ?')
          .run(currentOwner, p);
        this.recordHistory(
          currentOwner,
          p,
          existing.generation,
          revision,
          null,
          null,
          0,
          true,
          timestamp
        );
        this.enforceHistoryQuotas(currentOwner);
        return { path: p, revision, generation: existing.generation, timestamp };
      });
      return run.immediate(owner, canonical, ifVersion);
    } catch (error) {
      if (error instanceof MemoryFilesError) throw error;
      throw new MemoryFilesError('db_error', 'Memory file database operation failed.');
    }
  }

  /**
   * Read bounded revision history for a path (last N revisions across
   * generations, oldest-first, including deletion markers). Enables
   * recovery/restore flows and tests.
   */
  readHistory(owner: string, path: string): MemoryFileRevision[] {
    assertOwner(owner);
    const canonical = canonicalizeMemoryPath(path);
    try {
      const rows = this.db
        .prepare(
          `SELECT revision, generation, content, version, size_bytes, deleted, source, owner, timestamp
           FROM memory_files_history
           WHERE owner = ? AND path = ?
           ORDER BY generation DESC, revision DESC LIMIT ?`
        )
        .all(owner, canonical, this.historyPerFile) as RevisionRow[];
      return rows
        .slice()
        .reverse()
        .map((row) => ({
          revision: row.revision,
          generation: row.generation,
          content: row.content,
          version: row.version,
          sizeBytes: row.size_bytes,
          deleted: row.deleted !== 0,
          source: row.source,
          owner: row.owner,
          timestamp: row.timestamp,
        }));
    } catch (error) {
      throw new MemoryFilesError('db_error', 'Memory file database operation failed.');
    }
  }

  /** Current usage statistics for an owner (live files + history). */
  usage(owner: string): MemoryFilesUsage {
    assertOwner(owner);
    return this.guard(() => {
      const live = this.db
        .prepare(
          'SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS total FROM memory_files WHERE owner = ?'
        )
        .get(owner) as { files: number; total: number };
      const history = this.db
        .prepare(
          'SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes), 0) AS total FROM memory_files_history WHERE owner = ?'
        )
        .get(owner) as { entries: number; total: number };
      return {
        files: live.files,
        liveBytes: live.total,
        historyEntries: history.entries,
        historyBytes: history.total,
        limits: {
          maxFileBytes: this.maxFileBytes,
          maxFiles: this.maxFiles,
          maxTotalBytes: this.maxTotalBytes,
          historyPerFile: this.historyPerFile,
          maxHistoryEntries: this.maxHistoryEntries,
          source: this.source,
        },
      };
    });
  }

  private assertContent(content: string): void {
    if (typeof content !== 'string') {
      throw new MemoryFilesError('invalid_input', 'Content must be a string.');
    }
    const size = utf8ByteLength(content);
    if (size > this.maxFileBytes) {
      throw new MemoryFilesError(
        'file_too_large',
        `Content is ${size} bytes; limit is ${this.maxFileBytes}.`
      );
    }
  }

  private assertToken(ifVersion: string): void {
    if (!isValidVersionToken(ifVersion)) {
      throw new MemoryFilesError(
        'invalid_version_token',
        `if_version must be 'new' or a valid version token, received: ${String(ifVersion).slice(0, 64)}`
      );
    }
  }

  private assertQuotas(owner: string, delta: { newFile: boolean; liveBytesDelta: number }): void {
    const live = this.db
      .prepare(
        'SELECT COUNT(*) AS files, COALESCE(SUM(size_bytes), 0) AS total FROM memory_files WHERE owner = ?'
      )
      .get(owner) as { files: number; total: number };

    if (delta.newFile && live.files + 1 > this.maxFiles) {
      throw new MemoryFilesError(
        'quota_exceeded',
        `File-count quota reached (${this.maxFiles} files).`
      );
    }
    // Live-file footprint must stay under the owner quota. History growth
    // is absorbed by enforceHistoryQuotas(), which evicts the oldest
    // history rows (per path first, then per owner) until the combined
    // footprint (live + history) fits again.
    if (live.total + delta.liveBytesDelta > this.maxTotalBytes) {
      throw new MemoryFilesError(
        'quota_exceeded',
        `Total-bytes quota exceeded (limit ${this.maxTotalBytes}).`
      );
    }
  }

  /**
   * Bound history per owner: per-path retention, then global entry cap,
   * then global byte cap and the combined (live + history) quota, by
   * evicting oldest rows first.
   */
  private enforceHistoryQuotas(owner: string): void {
    // 1. Global entry cap.
    const count = this.db
      .prepare('SELECT COUNT(*) AS c FROM memory_files_history WHERE owner = ?')
      .get(owner) as { c: number };
    if (count.c > this.maxHistoryEntries) {
      const excess = count.c - this.maxHistoryEntries;
      this.db
        .prepare(
          `DELETE FROM memory_files_history
           WHERE owner = ? AND rowid IN (
             SELECT rowid FROM memory_files_history WHERE owner = ?
             ORDER BY timestamp ASC, rowid ASC LIMIT ?
           )`
        )
        .run(owner, owner, excess);
    }
    // 2. Combined (live + history) bytes footprint, then pure history cap.
    const liveRow = this.db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM memory_files WHERE owner = ?')
      .get(owner) as { total: number };
    const historyRows = this.db
      .prepare(
        `SELECT rowid, size_bytes FROM memory_files_history
         WHERE owner = ? ORDER BY timestamp ASC, rowid ASC`
      )
      .all(owner) as Array<{ rowid: number; size_bytes: number }>;
    let historyBytes = historyRows.reduce((sum, row) => sum + row.size_bytes, 0);
    const combinedLimit = Math.max(this.maxTotalBytes, liveRow.total);
    let combined = liveRow.total + historyBytes;
    let idx = 0;
    const toEvict: number[] = [];
    while (combined > combinedLimit && idx < historyRows.length) {
      toEvict.push(historyRows[idx].rowid);
      combined -= historyRows[idx].size_bytes;
      historyBytes -= historyRows[idx].size_bytes;
      idx += 1;
    }
    // Hard history-bytes ceiling (safety net independent of combined cap).
    const historyByteLimit = Math.max(this.maxTotalBytes, this.maxFileBytes * 4);
    while (historyBytes > historyByteLimit && idx < historyRows.length) {
      toEvict.push(historyRows[idx].rowid);
      historyBytes -= historyRows[idx].size_bytes;
      idx += 1;
    }
    if (toEvict.length > 0) {
      const placeholders = toEvict.map(() => '?').join(', ');
      this.db
        .prepare(`DELETE FROM memory_files_history WHERE owner = ? AND rowid IN (${placeholders})`)
        .run(owner, ...toEvict);
    }
  }

  private recordHistory(
    owner: string,
    path: string,
    generation: number,
    revision: number,
    content: string | null,
    version: string | null,
    sizeBytes: number,
    deleted: boolean,
    timestamp = Date.now()
  ): void {
    this.db
      .prepare(
        `INSERT INTO memory_files_history
         (owner, path, generation, revision, content, version, size_bytes, deleted, source, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        owner,
        path,
        generation,
        revision,
        content,
        version,
        sizeBytes,
        deleted ? 1 : 0,
        this.source,
        timestamp
      );
    // Per-path bound: keep only the last historyPerFile revisions.
    this.db
      .prepare(
        `DELETE FROM memory_files_history
         WHERE owner = ? AND path = ? AND rowid IN (
           SELECT rowid FROM memory_files_history
           WHERE owner = ? AND path = ?
           ORDER BY generation DESC, revision DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(owner, path, owner, path, this.historyPerFile);
    this.enforceHistoryQuotas(owner);
  }

  private nextGeneration(owner: string, path: string): number {
    const row = this.db
      .prepare(
        'SELECT COALESCE(MAX(generation), 0) AS maxGen FROM memory_files_history WHERE owner = ? AND path = ?'
      )
      .get(owner, path) as { maxGen: number };
    return row.maxGen + 1;
  }

  private transform(
    owner: string,
    path: string,
    ifVersion: string,
    update: (content: string) => string
  ): MemoryWriteResult {
    const canonical = canonicalizeMemoryPath(path);
    this.assertToken(ifVersion);
    return this.guard(() =>
      this.db
        .transaction(() => {
          const current = this.getRow(owner, canonical);
          if (!current) throw new MemoryFilesError('not_found', 'Memory file not found.');
          if (current.version !== ifVersion) {
            throw new MemoryFilesError('version_conflict', 'Memory file version conflict.', {
              currentContent: current.content,
              currentVersion: current.version,
            });
          }
          return this.write(owner, canonical, update(current.content), ifVersion);
        })
        .immediate()
    );
  }

  private guard<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof MemoryFilesError) throw error;
      // Do not expose driver messages, which can contain stored content.
      throw new MemoryFilesError('db_error', 'Memory file database operation failed.');
    }
  }

  private getRow(owner: string, path: string): FileRow | null {
    return this.guard(() => {
      const row = this.db
        .prepare(
          `SELECT path, content, version, revision, generation, size_bytes, updated_at
           FROM memory_files WHERE owner = ? AND path = ?`
        )
        .get(owner, path) as FileRow | undefined;
      return row ?? null;
    });
  }
}
