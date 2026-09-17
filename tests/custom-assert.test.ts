import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInstance } from '../src/main/db/database';
import type { Session } from '../src/shared/types';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root, getVersion: () => 'test' } }));
vi.mock('../src/main/config/config-store', () => ({
  configStore: { get: (key: string) => key === 'memoryEnabled' ? true : undefined, getAll: () => ({ memoryEnabled: true, memoryRuntime: { storageRoot: state.root, maxNavSteps: 1, useEmbedding: false } }) },
  PROVIDER_PRESETS: {},
}));
import { MemoryService } from '../src/main/memory/memory-service';
import { MemoryExtension } from '../src/main/memory/memory-extension';

let db: Database.Database | undefined;
afterEach(() => {
  db?.close();
  if (state.root) rmSync(state.root, { recursive: true, force: true });
});

it('exposes write and append through the real memory extension with an isolated local host', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'cowork-memory-registration-'));
  db = new Database(':memory:');
  const service = new MemoryService({ raw: db } as DatabaseInstance, {
    personalHost: { owner: 'local-installation', isSessionEnabled: () => true },
    llmClient: { complete: async () => ({ text: '' }), embed: async () => [] },
  });
  const session: Session = {
    id: 'test', title: 'test', status: 'idle', mountedPaths: [], allowedTools: [],
    memoryEnabled: true, createdAt: 1, updatedAt: 1,
  };
  await service.buildPromptPrefix(session, 'Remember a durable preference');
  const result = await new MemoryExtension(service).beforeSessionRun({
    session, prompt: 'Remember a durable preference', existingMessages: [], isColdStart: true,
  });
  expect(result.systemContext).toContain('virtual paths stored in SQLite');
  expect(result.customTools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['memory_write', 'memory_append']));
  const write = result.customTools?.find(tool => tool.name === 'memory_write');
  const output = await write?.execute('write-test', { path: '/profile.md', content: 'test preference', if_version: 'new' }, undefined, undefined, {} as never);
  expect(output?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('version') });
  expect(db.prepare('SELECT content FROM memory_files WHERE path = ?').get('/profile.md')).toEqual({ content: 'test preference' });
});
