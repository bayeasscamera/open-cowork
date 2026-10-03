import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  ArtifactValidationError,
  MAX_ARTIFACT_BYTES,
  inferArtifactKind,
} from '../src/main/artifacts/artifact-store';
import { createArtifactStore } from '../src/main/artifacts/artifact-store-factory';
import type { DatabaseInstance } from '../src/main/db/database';

/**
 * These run against a real SQLite database rather than fakes. The schema is
 * half the contract here: a store that works against an injected double would
 * still fail if the table definitions, the primary key, or the transaction
 * boundary were wrong.
 */
function newStore(): { store: ArtifactStore; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      project_id TEXT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      current_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE artifact_versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      mime_type TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (artifact_id, version)
    )
  `);
  db.exec('CREATE INDEX idx_artifacts_session_id ON artifacts(session_id)');
  db.exec('CREATE INDEX idx_artifacts_project_id ON artifacts(project_id)');
  // The factory takes a DatabaseInstance, of which `raw` is the part it uses.
  return { store: createArtifactStore({ raw: db } as unknown as DatabaseInstance), db };
}

describe('artifact kind inference', () => {
  it.each([
    ['notes.md', 'markdown'],
    ['data.json', 'json'],
    ['page.html', 'html'],
    ['main.ts', 'code'],
    ['app.py', 'code'],
    ['photo.png', 'image'],
    ['README', 'text'],
  ])('classifies %s as %s', (title, expected) => {
    expect(inferArtifactKind(title)).toBe(expected);
  });

  it('lets an explicit mime type win over the extension', () => {
    expect(inferArtifactKind('mystery.dat', 'application/json')).toBe('json');
    expect(inferArtifactKind('mystery.md', 'image/png')).toBe('image');
  });
});

describe('artifact store', () => {
  it('creates an artifact with its first version', () => {
    const { store } = newStore();
    const artifact = store.create({ title: 'notes.md', content: '# hello' });

    expect(artifact.currentVersion).toBe(1);
    expect(artifact.kind).toBe('markdown');
    expect(store.getWithContent(artifact.id)?.content).toBe('# hello');
  });

  it('keeps every version instead of overwriting', () => {
    const { store } = newStore();
    const artifact = store.create({ title: 'notes.md', content: 'v1' });

    store.saveVersion({ artifactId: artifact.id, content: 'v2' });
    const updated = store.saveVersion({ artifactId: artifact.id, content: 'v3' });

    expect(updated.currentVersion).toBe(3);
    // Current content is the newest.
    expect(store.getWithContent(artifact.id)?.content).toBe('v3');
    // Older versions remain readable, which is the point of keeping history.
    expect(store.getVersion(artifact.id, 1)?.content).toBe('v1');
    expect(store.getVersion(artifact.id, 2)?.content).toBe('v2');
    expect(store.versions(artifact.id).map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it('survives the source file disappearing, because content is stored', () => {
    const { store } = newStore();
    const artifact = store.create({ title: 'report.md', content: 'persisted' });

    // No filesystem involvement at all: the content is in the database, so it
    // outlives whatever produced it.
    expect(store.getWithContent(artifact.id)?.content).toBe('persisted');
    expect(store.getVersion(artifact.id, 1)?.content).toBe('persisted');
  });

  it('renames through a new version without creating a second artifact', () => {
    const { store } = newStore();
    const artifact = store.create({ title: 'draft.md', content: 'body' });

    const updated = store.saveVersion({
      artifactId: artifact.id,
      content: 'body',
      title: 'final.md',
    });

    expect(updated.title).toBe('final.md');
    expect(updated.currentVersion).toBe(2);
    expect(store.list()).toHaveLength(1);
  });

  it('lists by session and by project', () => {
    const { store } = newStore();
    store.create({ title: 'a.md', content: 'a', sessionId: 's1' });
    store.create({ title: 'b.md', content: 'b', sessionId: 's2', projectId: 'p1' });
    store.create({ title: 'c.md', content: 'c', sessionId: 's1', projectId: 'p1' });

    expect(store.list({ sessionId: 's1' }).map((a) => a.title).sort()).toEqual(['a.md', 'c.md']);
    expect(store.list({ projectId: 'p1' }).map((a) => a.title).sort()).toEqual(['b.md', 'c.md']);
    expect(store.list()).toHaveLength(3);
  });

  it('deletes the artifact and all of its versions', () => {
    const { store, db } = newStore();
    const artifact = store.create({ title: 'a.md', content: 'a' });
    store.saveVersion({ artifactId: artifact.id, content: 'b' });

    expect(store.delete(artifact.id)).toBe(true);
    expect(store.get(artifact.id)).toBeUndefined();
    expect(store.getVersion(artifact.id, 1)).toBeUndefined();
    const orphans = db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(artifact.id) as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('reports nothing to delete for an unknown id', () => {
    const { store } = newStore();
    expect(store.delete('artifact-missing')).toBe(false);
  });

  it('refuses an empty title', () => {
    const { store } = newStore();
    expect(() => store.create({ title: '   ', content: 'x' })).toThrow(ArtifactValidationError);
  });

  it('refuses content beyond the storage cap', () => {
    const { store } = newStore();
    const tooBig = 'x'.repeat(MAX_ARTIFACT_BYTES + 1);
    expect(() => store.create({ title: 'big.txt', content: tooBig })).toThrow(
      ArtifactValidationError
    );
  });

  it('refuses to append a version to an unknown artifact', () => {
    const { store } = newStore();
    expect(() => store.saveVersion({ artifactId: 'nope', content: 'x' })).toThrow(
      ArtifactValidationError
    );
  });

  it('leaves no orphan version when a write fails midway', () => {
    const { store, db } = newStore();
    const artifact = store.create({ title: 'a.md', content: 'a' });

    // Force the second write of a save to collide on the primary key, so the
    // failure happens after the version row is inserted and can only be undone
    // by the transaction.
    //
    // Note the failure has to be a data error (DML), not a schema one: SQLite
    // implicitly commits DDL, so dropping a table would escape the transaction
    // and make this test pass for the wrong reason.
    const current = store.get(artifact.id) as { currentVersion: number };
    db.prepare(
      `CREATE TRIGGER fail_header_update BEFORE UPDATE ON artifacts
       BEGIN SELECT RAISE(ABORT, 'forced failure'); END`
    ).run();

    expect(() => store.saveVersion({ artifactId: artifact.id, content: 'b' })).toThrow();
    db.exec('DROP TRIGGER fail_header_update');

    // Everything the failed save wrote must be gone: the header is back to the
    // version it held before, and the new version row does not exist. A header
    // advanced without its content would render as an empty artifact.
    const header = store.get(artifact.id) as { currentVersion: number };
    expect(header.currentVersion).toBe(current.currentVersion);
    expect(store.getVersion(artifact.id, 2)).toBeUndefined();
    expect(store.getWithContent(artifact.id)?.content).toBe('a');
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id = ?')
      .get(artifact.id) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('stores the byte size rather than the character count', () => {
    const { store } = newStore();
    const artifact = store.create({ title: 'accented.txt', content: 'ééééé' });
    expect(store.getVersion(artifact.id, 1)?.byteSize).toBe(10);
  });
});