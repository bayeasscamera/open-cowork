/**
 * Tests for MemoryFilesStore: versioned virtual memory files on a real
 * SQLite file (create -> reopen persistence), CAS across two
 * connections, typed conflicts, owner isolation, size/quota limits,
 * unique str_replace matching, and bounded revision history including
 * deletions. Uses the file-based DB directly (no electron imports).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

import {
  MemoryFilesStore,
  MemoryFilesError,
  canonicalizeMemoryPath,
  extractPreview,
} from '../src/main/memory/memory-files-store';

function openTempDb(): { db: Database.Database; dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memory-files-store-'));
  const file = join(dir, 'test.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return { db, dir, file };
}

describe('canonicalizeMemoryPath', () => {
  it('accepts canonical .md paths', () => {
    expect(canonicalizeMemoryPath('/profile.md')).toBe('/profile.md');
    expect(canonicalizeMemoryPath('/projects/api-v2/notes.md')).toBe('/projects/api-v2/notes.md');
  });

  it('rejects traversal, backslash, control chars, and aliases', () => {
    expect(() => canonicalizeMemoryPath('/../etc/passwd.md')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('/a/../b.md')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('\\windows\\path.md')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('/a/b\nc.md')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('/a//b.md')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('/a/.md')).toThrow(MemoryFilesError); // ends with .md but empty segment name ok? no — path is /a/.md, file name ".md"
    expect(() => canonicalizeMemoryPath('profile.md')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('/profile.txt')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('/profile.md/')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('')).toThrow(MemoryFilesError);
    expect(() => canonicalizeMemoryPath('/a/.md')).toThrow(MemoryFilesError);
  });

  it('rejects non-string input', () => {
    expect(() => canonicalizeMemoryPath(undefined as unknown as string)).toThrow(MemoryFilesError);
  });
});

describe('extractPreview', () => {
  it('returns first non-empty line, truncated', () => {
    expect(extractPreview('\n\n  \n# Title\nbody')).toBe('# Title');
    const long = 'x'.repeat(200);
    expect(extractPreview(long).length).toBeLessThanOrEqual(120);
  });
});

describe('MemoryFilesStore', () => {
  let db: Database.Database;
  let dir: string;
  let file: string;
  let store: MemoryFilesStore;

  beforeEach(() => {
    ({ db, dir, file } = openTempDb());
    store = new MemoryFilesStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('schema and persistence across reopen', () => {
    it('creates tables on the existing connection', () => {
      expect(store.isInitialized()).toBe(true);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'memory_files%'")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name).sort();
      expect(names).toContain('memory_files');
      expect(names).toContain('memory_files_history');
    });

    it('persists data across a real close/reopen of the file', () => {
      const created = store.write('user-1', '/profile.md', '# Profile\nAlice', 'new');
      const before = store.read('user-1', '/profile.md');
      expect(before.content).toBe('# Profile\nAlice');
      expect(before.version).toBe(created.version);

      db.close();
      db = new Database(file);
      const reopened = new MemoryFilesStore(db);
      const after = reopened.read('user-1', '/profile.md');
      expect(after.content).toBe('# Profile\nAlice');
      // Version token survives reopen (random UUID persisted, not recomputed).
      expect(after.version).toBe(created.version);
    });

    it('survives reopen with pre-existing foreign tables in the DB', () => {
      db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)');
      store.write('user-1', '/a.md', 'a', 'new');
      db.close();
      db = new Database(file);
      const reopened = new MemoryFilesStore(db);
      expect(reopened.read('user-1', '/a.md').content).toBe('a');
    });
  });

  describe('write / CAS / conflicts', () => {
    it('creates with if_version "new" and rejects "new" on existing', () => {
      const first = store.write('u', '/a.md', 'one', 'new');
      expect(first.revision).toBe(1);
      expect(first.generation).toBe(1);
      expect(first.version).not.toBe('new');
      expect(() => store.write('u', '/a.md', 'two', 'new')).toThrowError(MemoryFilesError);
      try {
        store.write('u', '/a.md', 'two', 'new');
        expect.unreachable();
      } catch (error) {
        const err = error as MemoryFilesError;
        expect(err.code).toBe('version_conflict');
        expect(err.conflict?.currentContent).toBe('one');
        expect(err.conflict?.currentVersion).toBe(first.version);
      }
    });

    it('rejects stale tokens with current content in conflict payload', () => {
      const v1 = store.write('u', '/b.md', 'v1', 'new');
      store.write('u', '/b.md', 'v2', v1.version);
      try {
        store.write('u', '/b.md', 'v3', v1.version); // stale
        expect.unreachable();
      } catch (error) {
        const err = error as MemoryFilesError;
        expect(err.code).toBe('version_conflict');
        expect(err.conflict).toBeDefined();
        expect(err.conflict?.currentVersion).not.toBe(v1.version);
        expect(err.conflict?.currentContent).toBe('v2');
      }
    });

    it('rejects writes to nonexistent path with non-new token', () => {
      try {
        store.write('u', '/ghost.md', 'x', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
        expect.unreachable();
      } catch (error) {
        const err = error as MemoryFilesError;
        expect(err.code).toBe('version_conflict');
        expect(err.conflict?.currentVersion).toBe('new');
      }
    });

    it('rejects invalid version tokens', () => {
      expect(() => store.write('u', '/t.md', 'x', '')).toThrowError(MemoryFilesError);
      try {
        store.write('u', '/t.md', 'x', 'not a token at all!!');
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('invalid_version_token');
      }
    });
  });

  describe('CAS across two independent connections', () => {
    it('second connection sees first connection write and conflicts on stale token', () => {
      const dbA = new Database(file);
      const dbB = new Database(file);
      const storeA = new MemoryFilesStore(dbA);
      const storeB = new MemoryFilesStore(dbB);
      try {
        const v1 = storeA.write('u', '/shared.md', 'from-A', 'new');
        const readB = storeB.read('u', '/shared.md');
        expect(readB.version).toBe(v1.version);
        expect(readB.content).toBe('from-A');

        // A writes again with its token; B's copy of the token is now stale.
        const v2 = storeA.write('u', '/shared.md', 'from-A-2', v1.version);
        expect(v2.version).not.toBe(v1.version);

        try {
          storeB.write('u', '/shared.md', 'from-B', v1.version); // B stale
          expect.unreachable();
        } catch (error) {
          const err = error as MemoryFilesError;
          expect(err.code).toBe('version_conflict');
          expect(err.conflict?.currentContent).toBe('from-A-2');
          expect(err.conflict?.currentVersion).toBe(v2.version);
        }

        // B retries with the fresh token and succeeds.
        const v3 = storeB.write('u', '/shared.md', 'from-B', v2.version);
        expect(v3.revision).toBe(3);
        expect(storeA.read('u', '/shared.md').content).toBe('from-B');
      } finally {
        dbA.close();
        dbB.close();
      }
    });

    it('delete/write race: stale delete conflicts, fresh token succeeds', () => {
      const dbA = new Database(file);
      const dbB = new Database(file);
      const storeA = new MemoryFilesStore(dbA);
      const storeB = new MemoryFilesStore(dbB);
      try {
        const v1 = storeA.write('u', '/race.md', 'content', 'new');
        const v2 = storeA.write('u', '/race.md', 'updated', v1.version);
        try {
          storeB.delete('u', '/race.md', v1.version); // stale
          expect.unreachable();
        } catch (error) {
          expect((error as MemoryFilesError).code).toBe('version_conflict');
        }
        const del = storeB.delete('u', '/race.md', v2.version);
        expect(del.revision).toBe(3);
        expect(() => storeA.read('u', '/race.md')).toThrowError(MemoryFilesError);
      } finally {
        dbA.close();
        dbB.close();
      }
    });
  });

  describe('owner isolation', () => {
    it('keeps owners fully isolated for read/list/write/delete/history', () => {
      const v = store.write('alice', '/secret.md', 'alice data', 'new');
      store.write('bob', '/secret.md', 'bob data', 'new');

      expect(store.read('alice', '/secret.md').content).toBe('alice data');
      expect(store.read('bob', '/secret.md').content).toBe('bob data');

      expect(store.list('alice').map((f) => f.path)).toEqual(['/secret.md']);
      expect(store.list('bob').map((f) => f.path)).toEqual(['/secret.md']);
      expect(store.list('carol')).toEqual([]);

      // Cross-owner token must not authorize a write.
      try {
        store.write('bob', '/secret.md', 'hijack', v.version);
        expect.unreachable();
      } catch (error) {
        const err = error as MemoryFilesError;
        expect(err.code).toBe('version_conflict');
        expect(err.conflict?.currentContent).toBe('bob data');
      }

      expect(store.readHistory('alice', '/secret.md').length).toBe(1);
      expect(store.readHistory('bob', '/secret.md').length).toBe(1);

      store.delete('alice', '/secret.md', v.version);
      expect(() => store.read('alice', '/secret.md')).toThrowError(MemoryFilesError);
      expect(store.read('bob', '/secret.md').content).toBe('bob data'); // untouched
    });

    it('rejects invalid owners', () => {
      expect(() => store.write('', '/a.md', 'x', 'new')).toThrowError(MemoryFilesError);
      expect(() => store.list('')).toThrowError(MemoryFilesError);
      expect(() => store.read('   ', '/a.md')).toThrowError(MemoryFilesError);
      try {
        store.write('', '/a.md', 'x', 'new');
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('invalid_owner');
      }
    });
  });

  describe('limits', () => {
    it('rejects files over the per-file byte cap (utf8-aware)', () => {
      const small = new MemoryFilesStore(db, { maxFileBytes: 10 });
      expect(() => small.write('u', '/big.md', '12345678901', 'new')).toThrowError(
        MemoryFilesError
      );
      try {
        small.write('u', '/big.md', '12345678901', 'new');
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('file_too_large');
      }
      // 10 bytes exactly is allowed.
      expect(small.write('u', '/ok.md', '1234567890', 'new').sizeBytes).toBe(10);
      // Multi-byte chars count as utf8 bytes: 3 é = 6 bytes.
      expect(() => small.write('u', '/uni.md', 'éééééé', 'new')).toThrowError(MemoryFilesError);
      expect(small.write('u', '/uni2.md', 'ééé', 'new').sizeBytes).toBe(6);
    });

    it('enforces file-count quota', () => {
      const tiny = new MemoryFilesStore(db, { maxFiles: 2 });
      tiny.write('u', '/1.md', 'one', 'new');
      tiny.write('u', '/2.md', 'two', 'new');
      try {
        tiny.write('u', '/3.md', 'three', 'new');
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('quota_exceeded');
      }
      // Overwriting an existing file is still fine.
      const v = tiny.read('u', '/1.md');
      expect(tiny.write('u', '/1.md', 'one-updated', v.version).revision).toBe(2);
    });

    it('enforces total-bytes quota (live files)', () => {
      const tiny = new MemoryFilesStore(db, { maxTotalBytes: 100 });
      tiny.write('u', '/a.md', 'x'.repeat(60), 'new');
      tiny.write('u', '/b.md', 'y'.repeat(39), 'new'); // 99 total
      try {
        tiny.write('u', '/c.md', 'zz', 'new'); // would exceed 100
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('quota_exceeded');
      }
      // Growing an existing file beyond the limit also rejects.
      const vb = tiny.read('u', '/b.md');
      expect(() => tiny.write('u', '/b.md', 'y'.repeat(50), vb.version)).toThrowError(
        MemoryFilesError
      );
    });

    it('counts history against the owner footprint but evicts rather than blocking', () => {
      // maxTotalBytes 100: file of 60 bytes + 60-byte history rows; the
      // store evicts oldest history to keep the combined footprint sane.
      const tiny = new MemoryFilesStore(db, { maxTotalBytes: 200 });
      let version = tiny.write('u', '/h.md', 'a'.repeat(60), 'new').version;
      for (let i = 0; i < 5; i += 1) {
        version = tiny.write('u', '/h.md', `${i}`.repeat(60), version).version;
      }
      const usage = tiny.usage('u');
      // History retention is bounded; combined footprint stays bounded too.
      expect(usage.historyEntries).toBeLessThanOrEqual(10);
      expect(usage.liveBytes).toBe(60);
      expect(usage.liveBytes + usage.historyBytes).toBeLessThanOrEqual(200);
    });
  });

  describe('append and str_replace', () => {
    it('appends to an existing file under CAS', () => {
      const v1 = store.write('u', '/log.md', 'line1\n', 'new');
      const v2 = store.append('u', '/log.md', 'line2\n', v1.version);
      expect(store.read('u', '/log.md').content).toBe('line1\nline2\n');
      expect(v2.revision).toBe(2);
      // Stale append fails.
      expect(() => store.append('u', '/log.md', 'line3\n', v1.version)).toThrowError(
        MemoryFilesError
      );
      // Append to missing file fails.
      expect(() => store.append('u', '/nope.md', 'x', 'new')).toThrowError(MemoryFilesError);
      try {
        store.append('u', '/nope.md', 'x', 'new');
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('not_found');
      }
    });

    it('replaces a unique occurrence and rejects ambiguous/missing matches', () => {
      const v1 = store.write('u', '/doc.md', 'alpha beta gamma alpha', 'new');
      // "alpha" occurs twice → ambiguous even though replaceable.
      try {
        store.strReplace('u', '/doc.md', 'alpha', 'ALPHA', v1.version);
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('ambiguous_match');
      }
      // Unique replace works.
      const v2 = store.strReplace('u', '/doc.md', 'beta', 'BETA', v1.version);
      expect(store.read('u', '/doc.md').content).toBe('alpha BETA gamma alpha');
      expect(v2.revision).toBe(2);
      // Missing match.
      try {
        store.strReplace('u', '/doc.md', 'delta', 'x', v2.version);
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('not_found');
      }
      // Overlapping occurrences are counted correctly: "aa" in "aaa" matches twice.
      const v3 = store.write('u', '/ovl.md', 'aaa', 'new');
      try {
        store.strReplace('u', '/ovl.md', 'aa', 'b', v3.version);
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('ambiguous_match');
      }
    });

    it('str_replace result respects the per-file size cap', () => {
      const small = new MemoryFilesStore(db, { maxFileBytes: 10 });
      const v = small.write('u', '/s.md', 'short', 'new');
      expect(() => small.strReplace('u', '/s.md', 'short', 'x'.repeat(11), v.version)).toThrowError(
        MemoryFilesError
      );
    });
  });

  describe('delete and history', () => {
    it('deletes under CAS and keeps a bounded deletion history', () => {
      const v1 = store.write('u', '/del.md', 'content-1', 'new');
      const v2 = store.write('u', '/del.md', 'content-2', v1.version);
      const del = store.delete('u', '/del.md', v2.version);
      expect(del.revision).toBe(3);
      expect(() => store.read('u', '/del.md')).toThrowError(MemoryFilesError);
      try {
        store.read('u', '/del.md');
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('not_found');
      }

      const history = store.readHistory('u', '/del.md');
      expect(history.length).toBe(3);
      expect(history[0]).toMatchObject({ revision: 1, deleted: false, content: 'content-1' });
      expect(history[1]).toMatchObject({ revision: 2, deleted: false, content: 'content-2' });
      expect(history[2]).toMatchObject({
        revision: 3,
        deleted: true,
        content: null,
        version: null,
      });
      // Source attribution is present and trusted (not model-supplied).
      expect(history[2].source.length).toBeGreaterThan(0);
      expect(history[2].owner).toBe('u');
    });

    it('delete conflicts on stale token and not_found on missing', () => {
      const v1 = store.write('u', '/d2.md', 'one', 'new');
      const v2 = store.write('u', '/d2.md', 'two', v1.version);
      expect(() => store.delete('u', '/d2.md', v1.version)).toThrowError(MemoryFilesError);
      expect(() => store.delete('u', '/missing.md', 'new')).toThrowError(MemoryFilesError);
      try {
        store.delete('u', '/missing.md', 'new');
        expect.unreachable();
      } catch (error) {
        // 'new' is a valid token but the file must exist to be deleted.
        expect((error as MemoryFilesError).code).toBe('not_found');
      }
      void v2;
    });

    it('ABA is impossible: delete + recreate with identical content yields a new token', () => {
      const v1 = store.write('u', '/aba.md', 'same-content', 'new');
      store.delete('u', '/aba.md', v1.version);
      // Recreate with identical content — must NOT collide with v1.
      const v2 = store.write('u', '/aba.md', 'same-content', 'new');
      expect(v2.version).not.toBe(v1.version);
      expect(v2.generation).toBe(2); // generation bumped after delete
      // A writer holding the OLD token v1 must fail even though content
      // is byte-identical to the recreated file.
      try {
        store.write('u', '/aba.md', 'same-content', v1.version);
        expect.unreachable();
      } catch (error) {
        const err = error as MemoryFilesError;
        expect(err.code).toBe('version_conflict');
        expect(err.conflict?.currentVersion).toBe(v2.version);
      }
      // History spans generations in order.
      const history = store.readHistory('u', '/aba.md');
      expect(history.map((h) => [h.generation, h.revision, h.deleted])).toEqual([
        [1, 1, false],
        [1, 2, true],
        [2, 1, false],
      ]);
    });

    it('history per path is bounded (last N, including deletions)', () => {
      const bounded = new MemoryFilesStore(db, { historyPerFile: 3 });
      let version = bounded.write('u', '/hist.md', 'r1', 'new').version;
      for (let i = 2; i <= 6; i += 1) {
        version = bounded.write('u', '/hist.md', `r${i}`, version).version;
      }
      const history = bounded.readHistory('u', '/hist.md');
      expect(history.length).toBe(3);
      expect(history.map((h) => h.revision)).toEqual([4, 5, 6]);
      expect(history[history.length - 1].content).toBe('r6');
    });

    it('history entry cap per owner is enforced globally', () => {
      const capped = new MemoryFilesStore(db, {
        historyPerFile: 10,
        maxHistoryEntries: 5,
      });
      capped.write('u', '/p1.md', 'a', 'new');
      capped.write('u', '/p2.md', 'b', 'new');
      for (let i = 0; i < 4; i += 1) {
        const v = capped.read('u', '/p1.md');
        capped.write('u', '/p1.md', `p1-${i}`, v.version);
      }
      // p1 has 5 revisions, p2 has 1 → 6 rows; cap is 5, oldest evicted.
      const usage = capped.usage('u');
      expect(usage.historyEntries).toBeLessThanOrEqual(5);
    });
  });

  describe('list', () => {
    it('lists sorted by path with literal prefix filter and previews', () => {
      store.write('u', '/b.md', 'bee', 'new');
      store.write('u', '/a.md', 'ay', 'new');
      store.write('u', '/projects/x.md', 'ex', 'new');
      store.write('u', '/projects/sub/y.md', 'why', 'new');
      store.write('other', '/projects/z.md', 'zed', 'new');

      const all = store.list('u');
      expect(all.map((f) => f.path)).toEqual([
        '/a.md',
        '/b.md',
        '/projects/sub/y.md',
        '/projects/x.md',
      ]);

      const filtered = store.list('u', { pathPrefix: '/projects/' });
      expect(filtered.map((f) => f.path)).toEqual(['/projects/sub/y.md', '/projects/x.md']);

      // Literal prefix: no glob interpretation.
      const literal = store.list('u', { pathPrefix: '/proj' });
      expect(literal.map((f) => f.path)).toEqual(['/projects/sub/y.md', '/projects/x.md']);

      const withPreview = store.list('u', { includePreview: true });
      expect(withPreview.find((f) => f.path === '/a.md')?.preview).toBe('ay');
      expect('preview' in all[0]).toBe(false);
    });
  });

  describe('read batch', () => {
    it('reads up to 20 paths and reports missing ones', () => {
      store.write('u', '/one.md', '1', 'new');
      store.write('u', '/two.md', '2', 'new');
      const batch = store.read('u', ['/one.md', '/missing.md', '/two.md']);
      expect(batch.files.map((f) => f.path)).toEqual(['/one.md', '/two.md']);
      expect(batch.missing).toEqual(['/missing.md']);
      expect(() => store.read('u', [])).toThrowError(MemoryFilesError);
      const tooMany = Array.from({ length: 21 }, (_, i) => `/${i}.md`);
      expect(() => store.read('u', tooMany)).toThrowError(MemoryFilesError);
    });

    it('single read throws not_found with typed code', () => {
      try {
        store.read('u', '/does-not-exist.md');
        expect.unreachable();
      } catch (error) {
        expect((error as MemoryFilesError).code).toBe('not_found');
      }
    });
  });
});
