/**
 * Workspace isolation + definitive deletion.
 *
 * Proofs:
 *  - strict retrieval never surfaces another workspace's chunks/sessions,
 *    even when they are the most relevant (the old -0.03 boost leaked them);
 *  - unattributed (legacy null) items still count as shared;
 *  - hardDelete removes live content AND revision history;
 *  - isWorkspaceVisible encodes the rule in one testable place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { isWorkspaceVisible } from '../src/main/memory/memory-utils';
import { ExperienceMemoryStore } from '../src/main/memory/experience-memory-store';
import { MemoryFilesStore } from '../src/main/memory/memory-files-store';

describe('isWorkspaceVisible', () => {
  it('same workspace is visible', () => {
    expect(isWorkspaceVisible('/a/b', '/a/b')).toBe(true);
  });
  it('another workspace is never visible', () => {
    expect(isWorkspaceVisible('/a/other', '/a/b')).toBe(false);
  });
  it('unattributed items count as shared', () => {
    expect(isWorkspaceVisible(null, '/a/b')).toBe(true);
    expect(isWorkspaceVisible(undefined, '/a/b')).toBe(true);
  });
  it('no session workspace means no scoping', () => {
    expect(isWorkspaceVisible('/a/other', null)).toBe(true);
  });
});

function writeFixture(dir: string): string {
  const file = join(dir, 'experience_memory.json');
  writeFileSync(
    file,
    JSON.stringify({
      sessions: [
        {
          id: 's-local',
          session_id: 'sess-local',
          source_workspace: '/work/local',
          summary: 'local deployment notes',
        },
        {
          id: 's-foreign',
          session_id: 'sess-foreign',
          source_workspace: '/work/other',
          summary: 'foreign deployment notes',
        },
      ],
      chunks: [
        {
          id: 'c-local',
          session_id: 'sess-local',
          source_workspace: '/work/local',
          summary: 'local deployment notes',
          raw_text: 'local secret deployment steps',
        },
        {
          id: 'c-foreign',
          session_id: 'sess-foreign',
          source_workspace: '/work/other',
          summary: 'foreign deployment notes with the exact query words deployment notes',
          raw_text: 'foreign secret deployment steps with the exact query words',
        },
      ],
    }),
    'utf8'
  );
  return file;
}

describe('retrieveProgressive strict workspace', () => {
  let dir: string;
  let store: ExperienceMemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-workspace-'));
    store = new ExperienceMemoryStore(writeFixture(dir));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes foreign chunks even when they match best', () => {
    const retrieval = store.retrieveProgressive('foreign secret deployment steps exact query', {
      chunkTopK: 10,
      sessionTopK: 5,
      currentWorkspace: '/work/local',
      strictWorkspace: true,
    });
    const ids = retrieval.broadSummaries.map((item) => item.id);
    expect(ids).not.toContain('c-foreign');
    expect(ids).not.toContain('sess-foreign');
    expect(ids).toContain('c-local');
  });

  it('legacy loose mode still ranks foreign content (documented old behavior)', () => {
    const retrieval = store.retrieveProgressive('foreign secret deployment steps exact query', {
      chunkTopK: 10,
      sessionTopK: 5,
      currentWorkspace: '/work/local',
    });
    const ids = retrieval.broadSummaries.map((item) => item.id);
    expect(ids).toContain('c-foreign');
  });
});

describe('MemoryFilesStore.hardDelete', () => {
  let db: Database.Database;
  let dir: string;
  let store: MemoryFilesStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-harddelete-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = new MemoryFilesStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('purges live content and revision history', () => {
    store.write('user-1', '/secret.md', 'version one', 'new');
    const v1 = store.read('user-1', '/secret.md').version;
    store.append('user-1', '/secret.md', ' version two', v1);
    expect(store.readHistory('user-1', '/secret.md').length).toBeGreaterThan(0);

    const v2 = store.read('user-1', '/secret.md').version;
    store.hardDelete('user-1', '/secret.md', v2);

    expect(() => store.read('user-1', '/secret.md')).toThrow();
    expect(store.readHistory('user-1', '/secret.md')).toEqual([]);
  });

  it('plain delete keeps history for recovery', () => {
    store.write('user-1', '/note.md', 'keep me in history', 'new');
    const v = store.read('user-1', '/note.md').version;
    store.delete('user-1', '/note.md', v);
    expect(store.readHistory('user-1', '/note.md').length).toBeGreaterThan(0);
  });
});
