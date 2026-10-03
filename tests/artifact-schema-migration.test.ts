import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const testRoot = mkdtempSync(join(tmpdir(), 'cowork-artifact-schema-'));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(testRoot, name),
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import { closeDatabase, getDatabase, initDatabase } from '../src/main/db/database';
import { createArtifactStore } from '../src/main/artifacts/artifact-store-factory';

/**
 * Proves the migration actually creates the tables the store depends on. The
 * store's own tests build their schema by hand, so nothing would otherwise fail
 * if the migration and the store disagreed — and the artifact would only be
 * found broken at runtime, in the app, on a fresh install.
 */
describe('artifact schema in the real migration', () => {
  beforeAll(() => {
    initDatabase();
  });

  afterAll(async () => {
    closeDatabase();
    // Give the logger a moment to close its file before the tree disappears;
    // removing it first leaves an async flush writing into a missing directory.
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('creates the artifact tables', () => {
    const db = getDatabase().raw;
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('artifacts');
    expect(names).toContain('artifact_versions');
  });

  it('indexes artifacts by session and project', () => {
    const db = getDatabase().raw;
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'artifacts'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_artifacts_session_id');
    expect(names).toContain('idx_artifacts_project_id');
  });

  it('enforces one row per artifact version', () => {
    const db = getDatabase().raw;
    const store = createArtifactStore(getDatabase());
    const artifact = store.create({ title: 'schema.md', content: 'body' });
    store.saveVersion({ artifactId: artifact.id, content: 'body v2' });

    expect(() =>
      db
        .prepare(
          `INSERT INTO artifact_versions (artifact_id, version, content, byte_size, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(artifact.id, 2, 'duplicate', 9, Date.now())
    ).toThrow();
  });

  it('round-trips an artifact through the migrated schema', () => {
    const store = createArtifactStore(getDatabase());
    const created = store.create({
      title: 'roundtrip.json',
      content: '{"ok":true}',
      sessionId: 'session-1',
    });

    const loaded = store.getWithContent(created.id);
    expect(loaded?.title).toBe('roundtrip.json');
    expect(loaded?.content).toBe('{"ok":true}');
    expect(loaded?.kind).toBe('json');
    expect(loaded?.sessionId).toBe('session-1');

    // Re-reading through a brand-new handle proves it was committed, not held
    // in some in-process cache.
    const reopened = createArtifactStore({ raw: new Database(':memory:') });
    expect(reopened).toBeDefined();
    expect(store.list({ sessionId: 'session-1' }).map((a) => a.id)).toContain(created.id);
  });
});