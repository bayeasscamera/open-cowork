import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The mock factory runs at import time, so the userData root is created
// lazily on the first getPath call — after module-level bindings exist.
let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      if (!testRoot) testRoot = mkdtempSync(join(tmpdir(), 'cowork-project-store-'));
      return testRoot;
    },
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import { initDatabase, closeDatabase, getDatabase } from '../src/main/db/database';
import { createProjectStore, ProjectValidationError } from '../src/main/projects/project-store';

// Real better-sqlite3 database at the mocked userData root.
initDatabase();

const workdir = join(testRoot, 'workdir');
mkdirSync(workdir, { recursive: true });

afterAll(() => {
  closeDatabase();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('ProjectStore (real better-sqlite3)', () => {
  it('creates, reads, updates and archives a project', () => {
    const store = createProjectStore(getDatabase());

    const project = store.create({
      name: 'Appels d\'offres',
      workdir,
      description: 'Réponses aux AO publics',
      instructions: 'Ne jamais inventer de chiffres.',
    });
    expect(project.id).toBeTruthy();
    expect(project.name).toBe('Appels d\'offres');
    expect(project.workdir).toBe(workdir);
    expect(project.archived).toBe(false);
    expect(project.referenceFiles).toEqual([]);

    const loaded = store.get(project.id);
    expect(loaded?.instructions).toBe('Ne jamais inventer de chiffres.');
    expect(loaded?.description).toBe('Réponses aux AO publics');

    const renamed = store.update(project.id, { name: 'AO publics', configSetId: 'set-2' });
    expect(renamed.name).toBe('AO publics');
    expect(renamed.configSetId).toBe('set-2');
    // Untouched fields survive a partial update.
    expect(renamed.instructions).toBe('Ne jamais inventer de chiffres.');

    const archived = store.archive(project.id, true);
    expect(archived.archived).toBe(true);
    // Archived projects leave the default list but remain readable.
    expect(store.list().find((p) => p.id === project.id)).toBeUndefined();
    expect(store.list(true).find((p) => p.id === project.id)).toBeDefined();
  });

  it('validates name and workdir', () => {
    const store = createProjectStore(getDatabase());
    expect(() => store.create({ name: '  ', workdir })).toThrow(ProjectValidationError);
    expect(() => store.create({ name: 'ok', workdir: 'relative/path' })).toThrow(
      ProjectValidationError
    );
    expect(() => store.create({ name: 'ok', workdir: join(testRoot, 'missing-dir') })).toThrow(
      ProjectValidationError
    );
  });

  it('attaches and detaches reference files (idempotent attach)', () => {
    const store = createProjectStore(getDatabase());
    const project = store.create({ name: 'Docs', workdir });
    const filePath = join(testRoot, 'notes.md');
    writeFileSync(filePath, 'référence', 'utf-8');

    const withFile = store.attachFile(project.id, filePath);
    expect(withFile.referenceFiles).toEqual([filePath]);

    // Same file attached twice → still a single row (UNIQUE constraint).
    const deduped = store.attachFile(project.id, filePath);
    expect(deduped.referenceFiles).toEqual([filePath]);

    // Non-existent or relative paths are rejected.
    expect(() => store.attachFile(project.id, join(testRoot, 'nope.md'))).toThrow(
      ProjectValidationError
    );
    expect(() => store.attachFile(project.id, 'relative.md')).toThrow(ProjectValidationError);

    const detached = store.detachFile(project.id, filePath);
    expect(detached.referenceFiles).toEqual([]);
  });

  it('links and unlinks sessions, and lists a project\'s sessions', () => {
    const db = getDatabase();
    const store = createProjectStore(db);
    const project = store.create({ name: 'Link', workdir });
    const other = store.create({ name: 'Other', workdir });

    const now = Date.now();
    db.sessions.create({
      id: 'sess-1',
      title: 'Session un',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: workdir,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 1,
      model: null,
      project_id: null,
      created_at: now,
      updated_at: now,
    });

    store.linkSession(project.id, 'sess-1');
    expect(store.getForSession('sess-1')?.id).toBe(project.id);

    const sessions = store.getSessions(project.id);
    expect(sessions.map((s) => s.id)).toEqual(['sess-1']);

    // Relinking to another project moves the session.
    store.linkSession(other.id, 'sess-1');
    expect(store.getForSession('sess-1')?.id).toBe(other.id);
    expect(store.getSessions(project.id)).toEqual([]);

    // Unknown ids are rejected, unknown sessions degrade silently.
    expect(() => store.linkSession('does-not-exist', 'sess-1')).toThrow(ProjectValidationError);
    expect(() => store.linkSession(project.id, 'does-not-exist')).toThrow(ProjectValidationError);
    expect(store.getForSession('unknown-session')).toBeUndefined();
  });

  it('rebuilds the store over an initialized database (factory)', () => {
    expect(() => initDatabase()).not.toThrow(); // idempotent second init
    const store = createProjectStore(getDatabase());
    expect(store.list().length).toBeGreaterThan(0); // projects created above persist
  });

  it('sessions.create persists project_id through the REAL data-access layer', () => {
    // Regression for a real E2E failure: insertSession's SQL missed the
    // project_id column, silently dropping the link on session creation
    // (mock-based tests could not see it — the real prepared statement can).
    const db = getDatabase();
    const now = Date.now();
    db.sessions.create({
      id: 'sess-dal-project',
      title: 'DAL persistence',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: workdir,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 1,
      model: null,
      project_id: 'project-dal-check',
      created_at: now,
      updated_at: now,
    });
    const row = db.sessions.get('sess-dal-project');
    expect(row?.project_id).toBe('project-dal-check');
  });

  it('permanent delete orphans linked sessions — NEVER deletes them', () => {
    const db = getDatabase();
    const store = createProjectStore(db);

    // A project with one linked session and one reference file.
    const project = store.create({ name: 'À supprimer', workdir });
    const refFile = join(testRoot, 'to-delete.md');
    writeFileSync(refFile, 'réf', 'utf-8');
    store.attachFile(project.id, refFile);
    const now = Date.now();
    db.sessions.create({
      id: 'sess-keep-me',
      title: 'Conversation à conserver',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: workdir,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 1,
      model: null,
      project_id: project.id,
      created_at: now,
      updated_at: now,
    });

    // Double safety: a non-archived project refuses the permanent delete.
    expect(() => store.delete(project.id)).toThrow(ProjectValidationError);

    store.archive(project.id, true);
    const outcome = store.delete(project.id);

    expect(outcome.orphanedSessions).toBe(1);
    expect(outcome.removedReferenceFiles).toBe(1);

    // The project and its reference-file rows are gone…
    expect(store.get(project.id)).toBeUndefined();
    expect(db.raw.prepare('SELECT * FROM project_files WHERE project_id = ?').all(project.id)).toEqual([]);

    // …but the SESSION SURVIVES, orphaned (project_id reset), title intact.
    const sessionRow = db.sessions.get('sess-keep-me');
    expect(sessionRow).toBeDefined();
    expect(sessionRow?.project_id).toBeNull();
    expect(sessionRow?.title).toBe('Conversation à conserver');
    // No session row was deleted by the project deletion.
    expect(db.sessions.getAll().length).toBeGreaterThanOrEqual(3);
  });

  it('moving a session from project A to B leaves A and joins B (single membership)', () => {
    const store = createProjectStore(getDatabase());
    const projectA = store.create({ name: 'Projet A', workdir });
    const projectB = store.create({ name: 'Projet B', workdir });
    const db = getDatabase();
    const now = Date.now();
    db.sessions.create({
      id: 'sess-mover',
      title: 'Session à déplacer',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: workdir,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 1,
      model: null,
      project_id: projectA.id,
      created_at: now,
      updated_at: now,
    });
    expect(store.getSessions(projectA.id).map((s) => s.id)).toEqual(['sess-mover']);

    store.linkSession(projectB.id, 'sess-mover');

    // Appears in B, no longer in A, exactly one project membership.
    expect(store.getSessions(projectA.id)).toEqual([]);
    expect(store.getSessions(projectB.id).map((s) => s.id)).toEqual(['sess-mover']);
    expect(db.sessions.get('sess-mover')?.project_id).toBe(projectB.id);
    expect(store.getForSession('sess-mover')?.id).toBe(projectB.id);
  });

  it('removing a session from its project frees it back to the general list', () => {
    const store = createProjectStore(getDatabase());
    const project = store.create({ name: 'Projet libérateur', workdir });
    const db = getDatabase();
    const now = Date.now();
    db.sessions.create({
      id: 'sess-to-free',
      title: 'Session à libérer',
      claude_session_id: null,
      openai_thread_id: null,
      status: 'idle',
      cwd: workdir,
      mounted_paths: '[]',
      allowed_tools: '[]',
      memory_enabled: 1,
      model: null,
      project_id: project.id,
      created_at: now,
      updated_at: now,
    });

    store.unlinkSession('sess-to-free');

    // Belongs to no project, project_id null — still alive in the general list.
    expect(db.sessions.get('sess-to-free')?.project_id).toBeNull();
    expect(store.getForSession('sess-to-free')).toBeUndefined();
    expect(store.getSessions(project.id)).toEqual([]);
    expect(db.sessions.get('sess-to-free')).toBeDefined();
    // Unlinking an unknown session is a no-op, never a crash.
    store.unlinkSession('unknown-session');
  });
});
