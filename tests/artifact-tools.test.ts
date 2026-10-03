import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createArtifactStore } from '../src/main/artifacts/artifact-store-factory';
import type { DatabaseInstance } from '../src/main/db/database';
import { createArtifactTools } from '../src/main/artifacts/artifact-tools';
import { ArtifactExtension } from '../src/main/artifacts/artifact-extension';

function newStore(): ReturnType<typeof createArtifactStore> {
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

/** Invoke a tool by name and parse its JSON payload. */
async function call(
  tools: ReturnType<typeof createArtifactTools>,
  name: string,
  params: unknown
): Promise<Record<string, unknown>> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const res = await tool.execute('call-1', params);
  const first = res.content[0];
  return JSON.parse(first.type === 'text' ? first.text : '');
}

describe('artifact tools', () => {
  it('exposes the documented surface', () => {
    const tools = createArtifactTools({ store: newStore(), sessionId: 's1' });
    expect(tools.map((t) => t.name)).toEqual([
      'artifact_create',
      'artifact_save_version',
      'artifact_list',
      'artifact_read',
      'artifact_delete',
    ]);
  });

  it('creates an artifact bound to the calling session', async () => {
    const store = newStore();
    const tools = createArtifactTools({ store, sessionId: 'session-a' });

    const created = await call(tools, 'artifact_create', {
      title: 'report.md',
      content: '# Findings',
    });

    expect(created.version).toBe(1);
    expect(created.kind).toBe('markdown');
    // The store must actually hold it, under this session.
    expect(store.getWithContent(created.id as string)?.content).toBe('# Findings');
    expect(store.get(created.id as string)?.sessionId).toBe('session-a');
  });

  it('appends a version and keeps the earlier one readable', async () => {
    const store = newStore();
    const tools = createArtifactTools({ store, sessionId: 's1' });
    const created = await call(tools, 'artifact_create', { title: 'a.md', content: 'v1' });

    await call(tools, 'artifact_save_version', {
      artifact_id: created.id,
      content: 'v2',
    });

    const current = await call(tools, 'artifact_read', { artifact_id: created.id });
    expect(current.content).toBe('v2');
    const older = await call(tools, 'artifact_read', {
      artifact_id: created.id,
      version: 1,
    });
    expect(older.content).toBe('v1');
  });

  it('lists only the calling session by default', async () => {
    const store = newStore();
    store.create({ title: 'mine.md', content: 'x', sessionId: 's1' });
    store.create({ title: 'theirs.md', content: 'x', sessionId: 's2' });

    const tools = createArtifactTools({ store, sessionId: 's1' });
    const listed = await call(tools, 'artifact_list', {});
    const artifacts = listed.artifacts as Array<{ title: string }>;
    expect(artifacts.map((a) => a.title)).toEqual(['mine.md']);
  });

  it('omits content from the listing unless asked', async () => {
    const store = newStore();
    store.create({ title: 'a.md', content: 'secret-ish', sessionId: 's1' });
    const tools = createArtifactTools({ store, sessionId: 's1' });

    const plain = (await call(tools, 'artifact_list', {})).artifacts as Array<Record<string, unknown>>;
    expect(plain[0]).not.toHaveProperty('content');

    const withContent = (await call(tools, 'artifact_list', { include_content: true }))
      .artifacts as Array<Record<string, unknown>>;
    expect(withContent[0].content).toBe('secret-ish');
  });

  it('reports a version history without the content', async () => {
    const store = newStore();
    const tools = createArtifactTools({ store, sessionId: 's1' });
    const created = await call(tools, 'artifact_create', { title: 'a.md', content: 'v1' });
    await call(tools, 'artifact_save_version', { artifact_id: created.id, content: 'v2' });

    const history = await call(tools, 'artifact_read', {
      artifact_id: created.id,
      list_versions: true,
    });
    expect(history.versions).toEqual([
      expect.objectContaining({ version: 2 }),
      expect.objectContaining({ version: 1 }),
    ]);
  });

  it('reports missing artifacts instead of throwing', async () => {
    const tools = createArtifactTools({ store: newStore(), sessionId: 's1' });
    expect((await call(tools, 'artifact_read', { artifact_id: 'nope' })).error).toBe('not_found');
    expect(
      (await call(tools, 'artifact_save_version', { artifact_id: 'nope', content: 'x' })).error
    ).toBe('invalid_params');
  });

  it('returns a validation error for bad input rather than throwing', async () => {
    const tools = createArtifactTools({ store: newStore(), sessionId: 's1' });
    expect((await call(tools, 'artifact_create', { title: '  ' , content: 'x' })).error).toBe(
      'invalid_params'
    );
    expect((await call(tools, 'artifact_create', { content: 'x' })).error).toBe('invalid_params');
  });

  it('refuses to delete when there is nobody to confirm', async () => {
    const store = newStore();
    const tools = createArtifactTools({ store, sessionId: 's1' });
    const created = await call(tools, 'artifact_create', { title: 'a.md', content: 'x' });

    const result = await call(tools, 'artifact_delete', { artifact_id: created.id });
    expect(result.error).toBe('confirmation_unavailable');
    // Still there: the refusal has to mean it, not merely report an error.
    expect(store.get(created.id as string)).toBeDefined();
  });

  it('deletes only after the human agrees', async () => {
    const store = newStore();
    const confirmDelete = vi.fn().mockResolvedValue(true);
    const tools = createArtifactTools({ store, sessionId: 's1', confirmDelete });
    const created = await call(tools, 'artifact_create', { title: 'a.md', content: 'x' });

    const result = await call(tools, 'artifact_delete', { artifact_id: created.id });
    expect(result.deleted).toBe(true);
    expect(confirmDelete).toHaveBeenCalledWith('call-1', created.id, 'a.md');
    expect(store.get(created.id as string)).toBeUndefined();
  });

  it('keeps the artifact when the human declines', async () => {
    const store = newStore();
    const tools = createArtifactTools({
      store,
      sessionId: 's1',
      confirmDelete: vi.fn().mockResolvedValue(false),
    });
    const created = await call(tools, 'artifact_create', { title: 'a.md', content: 'x' });

    expect((await call(tools, 'artifact_delete', { artifact_id: created.id })).error).toBe(
      'confirmation_denied'
    );
    expect(store.get(created.id as string)).toBeDefined();
  });

  it('does not ask for confirmation about an artifact that does not exist', async () => {
    const confirmDelete = vi.fn();
    const tools = createArtifactTools({ store: newStore(), sessionId: 's1', confirmDelete });
    expect((await call(tools, 'artifact_delete', { artifact_id: 'nope' })).error).toBe('not_found');
    expect(confirmDelete).not.toHaveBeenCalled();
  });
});

describe('artifact extension', () => {
  it('hands the tools to the session runtime for the current session', async () => {
    const store = newStore();
    const extension = new ArtifactExtension({ getStore: () => store });

    const result = await extension.beforeSessionRun({ session: { id: 'session-xyz' } });
    expect(result.customTools?.map((t) => t.name)).toContain('artifact_create');

    // The tools must be wired to THIS session, not a captured one.
    const tools = result.customTools ?? [];
    const created = await call(tools, 'artifact_create', { title: 'a.md', content: 'x' });
    expect(store.get(created.id as string)?.sessionId).toBe('session-xyz');
  });

  it('scopes each run to its own session, reusing one instance', async () => {
    const store = newStore();
    const extension = new ArtifactExtension({ getStore: () => store });

    const first = await extension.beforeSessionRun({ session: { id: 's-1' } });
    const second = await extension.beforeSessionRun({ session: { id: 's-2' } });

    const a = await call(first.customTools ?? [], 'artifact_create', {
      title: 'a.md',
      content: 'x',
    });
    await call(second.customTools ?? [], 'artifact_create', { title: 'b.md', content: 'x' });

    expect(store.get(a.id as string)?.sessionId).toBe('s-1');
    expect(store.list({ sessionId: 's-2' }).map((x) => x.title)).toEqual(['b.md']);
  });

  it('passes the project through when the session is in one', async () => {
    const store = newStore();
    const extension = new ArtifactExtension({
      getStore: () => store,
      getProjectId: () => 'project-9',
    });

    const result = await extension.beforeSessionRun({ session: { id: 's-1' } });
    const created = await call(result.customTools ?? [], 'artifact_create', {
      title: 'a.md',
      content: 'x',
    });
    expect(store.get(created.id as string)?.projectId).toBe('project-9');
  });
});