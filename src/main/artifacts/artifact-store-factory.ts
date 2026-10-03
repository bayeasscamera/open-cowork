/**
 * @module main/artifacts/artifact-store-factory
 *
 * Wires an ArtifactStore over the application database. Kept separate from the
 * store itself so the store stays testable against injected fakes, matching how
 * ProjectStore is structured.
 */

import type { DatabaseInstance } from '../db/database';
import { getDatabase, runWithWriteLockRetry } from '../db/database';
import { ArtifactStore } from './artifact-store';

/** Row shapes as they come back from SQLite, before mapping to the domain. */
interface ArtifactRowDb {
  id: string;
  session_id: string | null;
  project_id: string | null;
  title: string;
  kind: string;
  current_version: number;
  created_at: number;
  updated_at: number;
}

interface ArtifactVersionRowDb {
  artifact_id: string;
  version: number;
  content: string;
  mime_type: string | null;
  byte_size: number;
  created_at: number;
}

/** Wire an ArtifactStore over the application database instance. */
export function createArtifactStore(db: DatabaseInstance): ArtifactStore {
  const raw = db.raw;
  return new ArtifactStore({
    artifacts: {
      create: (row) =>
        raw
          .prepare(
            `INSERT INTO artifacts
              (id, session_id, project_id, title, kind, current_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.id,
            row.session_id,
            row.project_id,
            row.title,
            row.kind,
            row.current_version,
            row.created_at,
            row.updated_at
          ),
      update: (id, updates) => {
        const map: Record<string, unknown> = {
          session_id: updates.session_id,
          project_id: updates.project_id,
          title: updates.title,
          kind: updates.kind,
          current_version: updates.current_version,
          updated_at: updates.updated_at,
        };
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [column, value] of Object.entries(map)) {
          if (value === undefined) continue;
          sets.push(`${column} = ?`);
          params.push(value);
        }
        if (sets.length === 0) return;
        raw.prepare(`UPDATE artifacts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      },
      get: (id) => raw.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as ArtifactRowDb,
      delete: (id) => {
        raw.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
      },
      listBySession: (sessionId) =>
        raw
          .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY updated_at DESC')
          .all(sessionId) as ArtifactRowDb[],
      listByProject: (projectId) =>
        raw
          .prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY updated_at DESC')
          .all(projectId) as ArtifactRowDb[],
      listAll: () => raw.prepare('SELECT * FROM artifacts ORDER BY updated_at DESC').all() as ArtifactRowDb[],
    },
    versions: {
      insert: (row) =>
        raw
          .prepare(
            `INSERT INTO artifact_versions
              (artifact_id, version, content, mime_type, byte_size, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            row.artifact_id,
            row.version,
            row.content,
            row.mime_type,
            row.byte_size,
            row.created_at
          ),
      get: (artifactId, version) =>
        raw
          .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?')
          .get(artifactId, version) as ArtifactVersionRowDb | undefined,
      latest: (artifactId) =>
        raw
          .prepare(
            'SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC LIMIT 1'
          )
          .get(artifactId) as ArtifactVersionRowDb | undefined,
      list: (artifactId) =>
        raw
          .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC')
          .all(artifactId) as ArtifactVersionRowDb[],
      deleteByArtifact: (artifactId) => {
        raw.prepare('DELETE FROM artifact_versions WHERE artifact_id = ?').run(artifactId);
      },
    },
    // A version row and its header must land together: a header pointing at a
    // missing version would render as empty content, and an orphaned version
    // would be invisible.
    transaction: <T>(fn: () => T): T =>
      runWithWriteLockRetry('artifact write', () => {
        raw.exec('BEGIN IMMEDIATE');
        try {
          const result = fn();
          raw.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            // A rollback failure must not mask the original error.
          }
          throw error;
        }
      }),
  });
}

let sharedStore: ArtifactStore | null = null;

/**
 * Shared store over the application database. Throws when called before
 * initDatabase(), which matches the project store's contract.
 */
export function getSharedArtifactStore(): ArtifactStore {
  if (!sharedStore) {
    sharedStore = createArtifactStore(getDatabase());
  }
  return sharedStore;
}

/** Reset the shared instance. Test-only. */
export function resetSharedArtifactStore(): void {
  sharedStore = null;
}