/**
 * @module main/machine-access/grant-store
 *
 * Folder grants (spec 2.1) + per-project autonomy levels (spec 2.3).
 *
 * Hard rule: a grant can ONLY be created by the user (native folder picker
 * or explicit confirm button). The agent may *request* access — that yields
 * an AccessRequest the UI shows, never a grant. `addGrant` enforces this by
 * requiring `origin: 'user'` and throwing otherwise, so no caller can
 * "forget" and self-grant.
 */

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { isPathWithinRoot } from '../tools/path-containment';
import type { AutonomyLevel, FolderGrant, GrantAccess, GrantScope } from './types';
import { DEFAULT_AUTONOMY_LEVEL } from './types';

export interface GrantInput {
  path: string;
  access: GrantAccess;
  scope: GrantScope;
  expiresAt?: number;
}

export interface AccessRequest {
  id: string;
  wantedPath: string;
  reason: string;
  createdAt: number;
}

export type GrantOrigin = 'user' | 'agent';

export interface GrantDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
}

function canonicalizeGrantPath(input: string): string {
  const normalized = input.normalize('NFC');
  try {
    return fs.realpathSync(normalized);
  } catch {
    return normalized;
  }
}

export function requestAccess(wantedPath: string, reason: string, now = Date.now()): AccessRequest {
  return { id: randomUUID(), wantedPath, reason, createdAt: now };
}

export class GrantStore {
  private memory = new Map<string, FolderGrant>();
  private autonomy = new Map<string, AutonomyLevel>();
  constructor(private readonly db: GrantDb | null = null) {
    try {
      this.db?.exec(
        'CREATE TABLE IF NOT EXISTS access_grants (id TEXT PRIMARY KEY, path TEXT NOT NULL, access TEXT NOT NULL, scope TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL)'
      );
      this.db?.exec(
        'CREATE TABLE IF NOT EXISTS project_autonomy (project_id TEXT PRIMARY KEY, level TEXT NOT NULL, updated_at INTEGER NOT NULL)'
      );
      if (this.db) {
        const rows = this.db
          .prepare('SELECT id, path, access, scope, expires_at, created_at FROM access_grants')
          .all() as Array<{
          id: string;
          path: string;
          access: GrantAccess;
          scope: GrantScope;
          expires_at: number | null;
          created_at: number;
        }>;
        for (const row of rows) {
          this.memory.set(row.id, {
            id: row.id,
            path: row.path,
            access: row.access,
            scope: row.scope,
            expiresAt: row.expires_at ?? undefined,
            createdAt: row.created_at,
          });
        }
        const levels = this.db
          .prepare('SELECT project_id, level FROM project_autonomy')
          .all() as Array<{ project_id: string; level: AutonomyLevel }>;
        for (const row of levels) this.autonomy.set(row.project_id, row.level);
      }
    } catch {
      // Best effort: memory store still works without persistence.
    }
  }

  /** Only `origin: 'user'` succeeds. The agent path must use requestAccess(). */
  addGrant(input: GrantInput, origin: GrantOrigin, now = Date.now()): FolderGrant {
    if (origin !== 'user') {
      throw new Error('Grants can only be created by the user (native picker or confirm button).');
    }
    if (!input.path || input.path.trim().length === 0) throw new Error('Grant path is empty.');
    const grant: FolderGrant = {
      id: randomUUID(),
      path: canonicalizeGrantPath(input.path),
      access: input.access,
      scope: input.scope,
      expiresAt: input.expiresAt,
      createdAt: now,
    };
    this.memory.set(grant.id, grant);
    try {
      this.db
        ?.prepare(
          'INSERT OR REPLACE INTO access_grants (id, path, access, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(grant.id, grant.path, grant.access, grant.scope, grant.expiresAt ?? null, grant.createdAt);
    } catch {
      // persistence is best effort
    }
    return grant;
  }

  revokeGrant(id: string): boolean {
    const existed = this.memory.delete(id);
    try {
      this.db?.prepare('DELETE FROM access_grants WHERE id = ?').run(id);
    } catch {
      // ignore
    }
    return existed;
  }

  list(now = Date.now()): FolderGrant[] {
    return [...this.memory.values()].filter((g) => g.expiresAt === undefined || g.expiresAt > now);
  }

  /** Sub-folders inherit; a symlink escaping the grant never counts (checked at resolve time). */
  covers(realPath: string, needsWrite: boolean, platform: NodeJS.Platform = process.platform, now = Date.now()): boolean {
    const caseInsensitive = platform !== 'linux';
    for (const grant of this.list(now)) {
      if (needsWrite && grant.access !== 'read-write') continue;
      if (isPathWithinRoot(realPath, grant.path, caseInsensitive)) return true;
    }
    return false;
  }

  getAutonomy(projectId: string): AutonomyLevel {
    return this.autonomy.get(projectId) ?? DEFAULT_AUTONOMY_LEVEL;
  }

  setAutonomy(projectId: string, level: AutonomyLevel, now = Date.now()): void {
    const valid: AutonomyLevel[] = ['ask-always', 'read-free', 'extended-trust', 'allow-all'];
    if (!valid.includes(level)) throw new Error(`Unknown autonomy level: ${level}`);
    this.autonomy.set(projectId, level);
    try {
      this.db
        ?.prepare('INSERT OR REPLACE INTO project_autonomy (project_id, level, updated_at) VALUES (?, ?, ?)')
        .run(projectId, level, now);
    } catch {
      // ignore
    }
  }
}
