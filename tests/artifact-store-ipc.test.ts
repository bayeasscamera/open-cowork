import Database from 'better-sqlite3';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createArtifactStore } from '../src/main/artifacts/artifact-store-factory';
import type { DatabaseInstance } from '../src/main/db/database';
import { registerArtifactStoreIpcHandlers } from '../src/main/ipc/artifact-store-handlers';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

import { registerArtifactStoreIpcHandlers as register } from '../src/main/ipc/artifact-store-handlers';

function newStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, title TEXT NOT NULL,
      kind TEXT NOT NULL, current_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE artifact_versions (
      artifact_id TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL,
      mime_type TEXT, byte_size INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      PRIMARY KEY (artifact_id, version)
    )
  `);
  return createArtifactStore({ raw: db } as unknown as DatabaseInstance);
}

const invoke = async (channel: string, ...args: unknown[]) => {
  const fn = mocks.handlers.get(channel);
  if (!fn) throw new Error(`no handler: ${channel}`);
  return fn({}, ...args);
};

describe('artifact store IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
  });

  it('registers the persistent channels', () => {
    register({ getStore: newStore, getProjectId: () => null });
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'artifacts.persistent.delete',
      'artifacts.persistent.get',
      'artifacts.persistent.list',
      'artifacts.persistent.version',
      'artifacts.persistent.versions',
    ]);
  });

  it('lists the session artifacts without content', async () => {
    const store = newStore();
    store.create({ title: 'a.md', content: 'body', sessionId: 's1' });
    register({ getStore: () => store, getProjectId: () => null });

    const listed = (await invoke('artifacts.persistent.list', 's1')) as Array<
      Record<string, unknown>
    >;
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe('a.md');
    // Metadata only: the list must not drag every version's content along.
    expect(listed[0]).not.toHaveProperty('content');
  });

  it('returns nothing without a session rather than listing everything', async () => {
    const store = newStore();
    store.create({ title: 'a.md', content: 'x', sessionId: 's1' });
    register({ getStore: () => store, getProjectId: () => null });

    expect(await invoke('artifacts.persistent.list', null)).toEqual([]);
  });

  it('refuses to read an artifact belonging to another session', async () => {
    const store = newStore();
    const artifact = store.create({ title: 'a.md', content: 'x', sessionId: 's1' });
    register({ getStore: () => store, getProjectId: () => null });

    // The renderer names the session it is looking at; the handler verifies it
    // rather than trusting the caller's claim.
    expect(await invoke('artifacts.persistent.get', 's2', artifact.id)).toBeNull();
    expect(await invoke('artifacts.persistent.get', 's1', artifact.id)).toMatchObject({
      content: 'x',
    });
  });

  it('refuses to list an earlier version across sessions', async () => {
    const store = newStore();
    const artifact = store.create({ title: 'a.md', content: 'v1', sessionId: 's1' });
    store.saveVersion({ artifactId: artifact.id, content: 'v2' });
    register({ getStore: () => store, getProjectId: () => null });

    expect(await invoke('artifacts.persistent.versions', 's2', artifact.id)).toEqual([]);
    expect(await invoke('artifacts.persistent.version', 's2', artifact.id, 1)).toBeNull();
  });

  it('lists version metadata without content', async () => {
    const store = newStore();
    const artifact = store.create({ title: 'a.md', content: 'v1', sessionId: 's1' });
    store.saveVersion({ artifactId: artifact.id, content: 'v2' });
    register({ getStore: () => store, getProjectId: () => null });

    const versions = (await invoke('artifacts.persistent.versions', 's1', artifact.id)) as Array<
      Record<string, unknown>
    >;
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).not.toHaveProperty('content');
  });

  it('reads an earlier version for comparison', async () => {
    const store = newStore();
    const artifact = store.create({ title: 'a.md', content: 'v1', sessionId: 's1' });
    store.saveVersion({ artifactId: artifact.id, content: 'v2' });
    register({ getStore: () => store, getProjectId: () => null });

    expect(await invoke('artifacts.persistent.version', 's1', artifact.id, 1)).toMatchObject({
      content: 'v1',
    });
    expect(await invoke('artifacts.persistent.version', 's1', artifact.id, 99)).toBeNull();
  });

  it('spans the project when the session is in one', async () => {
    const store = newStore();
    store.create({ title: 'mine.md', content: 'x', sessionId: 's1', projectId: 'p1' });
    store.create({ title: 'other.md', content: 'x', sessionId: 's2', projectId: 'p1' });
    store.create({ title: 'elsewhere.md', content: 'x', sessionId: 's3', projectId: 'p2' });
    register({
      getStore: () => store,
      getProjectId: (sessionId) => (sessionId === 's3' ? 'p2' : 'p1'),
    });

    const session = (await invoke('artifacts.persistent.list', 's1', 'session')) as Array<{
      title: string;
    }>;
    expect(session.map((a) => a.title)).toEqual(['mine.md']);

    const project = (await invoke('artifacts.persistent.list', 's1', 'project')) as Array<{
      title: string;
    }>;
    expect(project.map((a) => a.title).sort()).toEqual(['mine.md', 'other.md']);
  });

  it('returns nothing for project scope when the session has no project', async () => {
    const store = newStore();
    store.create({ title: 'a.md', content: 'x', sessionId: 's1' });
    register({ getStore: () => store, getProjectId: () => null });
    expect(await invoke('artifacts.persistent.list', 's1', 'project')).toEqual([]);
  });

  it('refuses to delete when no confirmation is available', async () => {
    const store = newStore();
    const artifact = store.create({ title: 'a.md', content: 'x', sessionId: 's1' });
    register({ getStore: () => store, getProjectId: () => null });

    expect(await invoke('artifacts.persistent.delete', 's1', artifact.id)).toEqual({
      success: false,
      error: 'confirmation_unavailable',
    });
    expect(store.get(artifact.id)).toBeDefined();
  });

  it('deletes once the human agrees', async () => {
    const store = newStore();
    const artifact = store.create({ title: 'a.md', content: 'x', sessionId: 's1' });
    const confirmDelete = vi.fn().mockResolvedValue(true);
    register({ getStore: () => store, getProjectId: () => null, confirmDelete });

    expect(await invoke('artifacts.persistent.delete', 's1', artifact.id)).toEqual({
      success: true,
    });
    expect(confirmDelete).toHaveBeenCalledWith(artifact.id, 'a.md');
    expect(store.get(artifact.id)).toBeUndefined();
  });

  it('keeps the artifact when the human declines', async () => {
    const store = newStore();
    const artifact = store.create({ title: 'a.md', content: 'x', sessionId: 's1' });
    register({
      getStore: () => store,
      getProjectId: () => null,
      confirmDelete: vi.fn().mockResolvedValue(false),
    });

    expect(await invoke('artifacts.persistent.delete', 's1', artifact.id)).toEqual({
      success: false,
      error: 'confirmation_denied',
    });
    expect(store.get(artifact.id)).toBeDefined();
  });

  it('refuses to delete across sessions, without even asking', async () => {
    const store = newStore();
    const artifact = store.create({ title: 'a.md', content: 'x', sessionId: 's1' });
    const confirmDelete = vi.fn();
    register({ getStore: () => store, getProjectId: () => null, confirmDelete });

    expect(await invoke('artifacts.persistent.delete', 's2', artifact.id)).toEqual({
      success: false,
      error: 'not_found',
    });
    // Must not prompt for an artifact the caller is not allowed to see.
    expect(confirmDelete).not.toHaveBeenCalled();
    expect(store.get(artifact.id)).toBeDefined();
  });
});

describe('artifact IPC registration in the app', () => {
  it('is registered with a confirmation callback', () => {
    // The unit tests construct the context directly; this asserts the app wires
    // the real dialog, without which deletion would always refuse.
    const index = require('node:fs').readFileSync(
      require('node:path').resolve(process.cwd(), 'src/main/index.ts'),
      'utf8'
    );
    expect(index).toContain('registerArtifactStoreIpcHandlers({');
    expect(index).toContain('confirmDelete: async');
    expect(index).toContain('getStore: getArtifactStore');
  });
});