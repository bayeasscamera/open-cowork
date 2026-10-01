/**
 * Secrets must never rest in memory storage nor leave for the LLM/embedding
 * provider: redaction happens at ingestion (transcripts), on memory-file
 * writes, and on persisted ingest errors.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { redactSecrets } from '../src/main/utils/secret-redaction';
import { messagesToTranscript } from '../src/main/memory/memory-utils';
import { MemoryFilesStore } from '../src/main/memory/memory-files-store';
import type { Message } from '../src/shared/types';

describe('redactSecrets — extended patterns', () => {
  it('masks AWS, Google, GitLab and npm tokens', () => {
    expect(redactSecrets('key AKIAIOSFODNN7EXAMPLE here')).toBe(
      'key [REDACTED-KEY] here'
    );
    expect(redactSecrets('gkey AIzaSyD12345678901234567890123456789012')).toContain(
      '[REDACTED-KEY]'
    );
    expect(redactSecrets('glpat-abcdefghijklmnopqrstuvwx')).toBe('[REDACTED-TOKEN]');
    expect(redactSecrets('//registry.npmjs.org/:_authToken=npm_abcDEF123456')).toBe(
      '//registry.npmjs.org/:_authToken=[REDACTED]'
    );
  });

  it('still masks the historical patterns', () => {
    expect(redactSecrets('sk-ant-1234567890abcdef')).toBe('[REDACTED-KEY]');
    expect(redactSecrets('sk-proj-1234567890abcdef')).toBe('[REDACTED-KEY]');
    expect(redactSecrets('ghp_123456789012345678901234567890abcd')).toBe('[REDACTED-TOKEN]');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'The API key concept is explained in chapter twelve of the manual.';
    expect(redactSecrets(prose)).toBe(prose);
  });
});

function textMessage(id: string, text: string): Message {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  } as Message;
}

describe('messagesToTranscript — the ingestion choke point', () => {
  it('redacts pasted secrets so storage, extraction and embeddings never see them', () => {
    const turns = messagesToTranscript([
      textMessage('m1', 'my key is sk-ant-1234567890abcdef, use it'),
      textMessage('m2', 'plain discussion about the refactor'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.content).toBe('my key is [REDACTED-KEY], use it');
    expect(turns[1]?.content).toBe('plain discussion about the refactor');
  });
});

describe('MemoryFilesStore — redaction on write paths', () => {
  let db: Database.Database;
  let dir: string;
  let store: MemoryFilesStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memory-secret-redaction-'));
    db = new Database(join(dir, 'test.db'));
    db.pragma('journal_mode = WAL');
    store = new MemoryFilesStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('write() stores redacted bytes, not the secret', () => {
    store.write('user-1', '/keys.md', 'token: ghp_123456789012345678901234567890abcd', 'new');
    const read = store.read('user-1', '/keys.md');
    expect(read.content).not.toContain('ghp_');
    expect(read.content).toContain('[REDACTED-TOKEN]');
  });

  it('append() redacts only the new fragment', () => {
    store.write('user-1', '/notes.md', 'clean start', 'new');
    const v = store.read('user-1', '/notes.md').version;
    store.append('user-1', '/notes.md', ' plus AKIAIOSFODNN7EXAMPLE', v);
    const read = store.read('user-1', '/notes.md');
    expect(read.content).toBe('clean start plus [REDACTED-KEY]');
  });

  it('strReplace() redacts the inserted text', () => {
    store.write('user-1', '/cfg.md', 'value=old', 'new');
    const v = store.read('user-1', '/cfg.md').version;
    store.strReplace('user-1', '/cfg.md', 'old', 'sk-ant-1234567890abcdef', v);
    expect(store.read('user-1', '/cfg.md').content).toBe('value=[REDACTED-KEY]');
  });
});
