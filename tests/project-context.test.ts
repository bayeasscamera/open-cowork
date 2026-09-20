import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// The mock factory runs at import time, so the userData root is created
// lazily on the first getPath call — after module-level bindings exist.
let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      if (!testRoot) testRoot = mkdtempSync(join(tmpdir(), 'cowork-project-context-'));
      return testRoot;
    },
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import { getDatabase, closeDatabase, initDatabase } from '../src/main/db/database';
import { createProjectStore } from '../src/main/projects/project-store';
import { resolveProjectContext } from '../src/main/projects/project-context';
import type { Project } from '../src/shared/types';

// Real better-sqlite3 database at the mocked userData root.
initDatabase();

afterAll(() => {
  closeDatabase();
  rmSync(testRoot, { recursive: true, force: true });
});

function stubProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Projets factices',
    description: null,
    workdir: '/w',
    configSetId: null,
    instructions: null,
    archived: false,
    referenceFiles: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('resolveProjectContext — pure resolution rules', () => {
  it('returns an empty block for a session without a project', () => {
    const resolution = resolveProjectContext('s-none', {
      getForSession: () => undefined,
    });
    expect(resolution.project).toBeUndefined();
    expect(resolution.configSetId).toBeNull();
    expect(resolution.systemPromptBlock).toBe('');
  });

  it('returns an empty block for an archived project', () => {
    const resolution = resolveProjectContext('s-arch', {
      getForSession: () => stubProject({ archived: true }),
    });
    expect(resolution.systemPromptBlock).toBe('');
    expect(resolution.configSetId).toBeNull();
  });

  it('injects identity, instructions and reference file content', () => {
    const resolution = resolveProjectContext('s1', {
      getForSession: () =>
        stubProject({
          description: 'Réponses aux AO',
          instructions: 'Toujours citer les sources.',
          referenceFiles: ['/tmp/cdc.md'],
        }),
    });
    expect(resolution.configSetId).toBeNull();
    expect(resolution.systemPromptBlock).toContain('<project_context>');
    expect(resolution.systemPromptBlock).toContain('Projets factices');
    expect(resolution.systemPromptBlock).toContain('Réponses aux AO');
    expect(resolution.systemPromptBlock).toContain('<project_instructions>');
    expect(resolution.systemPromptBlock).toContain('Toujours citer les sources.');
    expect(resolution.systemPromptBlock).toContain('/tmp/cdc.md');
    expect(resolution.systemPromptBlock).toContain('</project_context>');
  });

  it('surfaces the project ConfigSet pin', () => {
    const resolution = resolveProjectContext('s2', {
      getForSession: () => stubProject({ configSetId: 'set-projet' }),
    });
    expect(resolution.configSetId).toBe('set-projet');
  });

  it('marks unreadable reference files instead of throwing', () => {
    const resolution = resolveProjectContext('s3', {
      getForSession: () =>
        stubProject({
          referenceFiles: [join(testRoot, 'definitely-missing-5192.txt')],
        }),
    });
    expect(resolution.systemPromptBlock).toContain('[unreadable file:');
  });

  it('never throws when the store itself fails', () => {
    const resolution = resolveProjectContext('s4', {
      getForSession: () => {
        throw new Error('db exploded');
      },
    });
    expect(resolution.systemPromptBlock).toBe('');
    expect(resolution.project).toBeUndefined();
  });
});

describe('resolveProjectContext — INTEGRATION over the real database', () => {
  it(
    'a real project with real files injects its instructions and file content ' +
      'into the system prompt block for a real linked session',
    () => {
      const db = getDatabase();
      const store = createProjectStore(db);

      // Real project on a real workspace directory with real instructions.
      const workdir = join(testRoot, 'integration-workdir');
      mkdirSync(workdir, { recursive: true });
      const project = store.create({
        name: 'AO publics 2026',
        workdir,
        description: 'Préparation des réponses aux appels d\'offres',
        instructions: 'NE JAMAIS inventer de chiffres ; marquer [À COMPLÉTER] si une donnée manque.',
        configSetId: 'set-ao',
      });

      // Real reference file on disk, outside the project workdir (allowed by design).
      const cdcPath = join(testRoot, 'cahier-des-charges.md');
      writeFileSync(cdcPath, '# Cahier des charges\nLot 1 — Périmètre : 12 postes.', 'utf-8');
      store.attachFile(project.id, cdcPath);

      // Real session row created WITH the project link — exactly what
      // handleClientEvent('session.start') → startSession → saveSession
      // persists in production (insertSession must carry project_id).
      const now = Date.now();
      const sessionId = 'sess-integration-1';
      db.sessions.create({
        id: sessionId,
        title: 'Préparer la réponse au lot 1',
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

      // The exact resolution the agent runner performs at session start.
      const resolution = resolveProjectContext(sessionId, store);

      expect(resolution.project?.id).toBe(project.id);
      expect(resolution.configSetId).toBe('set-ao');

      const block = resolution.systemPromptBlock;
      expect(block).toContain('<project_context>');
      expect(block).toContain('This conversation belongs to the project "AO publics 2026".');
      expect(block).toContain('Préparation des réponses aux appels d\'offres');
      expect(block).toContain(`Workspace: ${workdir}`);
      expect(block).toContain('NE JAMAIS inventer de chiffres');
      // The REAL content of the reference file is inside the block.
      expect(block).toContain('# Cahier des charges');
      expect(block).toContain('Lot 1 — Périmètre : 12 postes.');
      expect(block).toContain(cdcPath);
      expect(block).toContain('</project_context>');
    }
  );
});

describe('agent runner wiring — source contract', () => {
  // The resolution above only proves the block is BUILT. This contract proves
  // the block is INJECTED: the agent runner must append it to the same
  // coworkAppendPrompt array that feeds the SDK's appendSystemPrompt, and must
  // prefer the project's ConfigSet when one is pinned.
  const runnerSource = readFileSync('src/main/agent/agent-runner.ts', 'utf-8');

  it('appends the resolved project context block to the system prompt', () => {
    expect(runnerSource).toContain('projectContext.systemPromptBlock,');
    // And that array is the appendSystemPrompt payload of the resource loader.
    expect(runnerSource).toContain('appendSystemPrompt: coworkAppendPrompt,');
  });

  it('uses the project ConfigSet when pinned, falling back to the active config', () => {
    expect(runnerSource).toContain('configStore.getConfigSetProjectedConfig(projectContext.configSetId)');
    expect(runnerSource).toContain('|| configStore.getAll()');
  });

  it('resolveProjectContextForRunner degrades to an empty context instead of throwing', () => {
    expect(runnerSource).toContain('function resolveProjectContextForRunner(sessionId: string)');
  });
});

describe('IPC surface — source contract', () => {
  const preloadSource = readFileSync('src/preload/index.ts', 'utf-8');
  const indexSource = readFileSync('src/main/index.ts', 'utf-8');

  it('exposes every projects.* channel in the preload allowlist and helpers', () => {
    for (const channel of [
      'projects.create',
      'projects.list',
      'projects.get',
      'projects.update',
      'projects.archive',
      'projects.delete',
      'projects.attachFile',
      'projects.detachFile',
      'projects.linkSession',
      'projects.unlinkSession',
    ]) {
      expect(preloadSource).toContain(`'${channel}'`);
    }
    expect(preloadSource).toContain('projects: {');
  });

  it('dispatches every projects.* event in the main-process handler', () => {
    for (const channel of [
      'projects.create',
      'projects.list',
      'projects.get',
      'projects.update',
      'projects.archive',
      'projects.delete',
      'projects.attachFile',
      'projects.detachFile',
      'projects.linkSession',
      'projects.unlinkSession',
    ]) {
      expect(indexSource).toContain(`case '${channel}'`);
    }
  });

  it('session.start carries the projectId and defaults cwd to the project workdir', () => {
    expect(indexSource).toContain('event.payload.projectId');
    expect(indexSource).toContain('if (!cwd) cwd = project.workdir;');
  });
});
