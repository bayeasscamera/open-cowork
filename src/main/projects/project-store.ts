/**
 * @module main/projects/project-store
 *
 * CRUD service for Projects — a named group of sessions sharing a working
 * context (workdir, persistent instructions, reference files, optional
 * ConfigSet). Persistence lives in better-sqlite3 (projects + project_files
 * tables, sessions.project_id link column).
 *
 * Conventions:
 * - No destructive delete: projects are archived (archived = 1).
 * - Reference files are absolute paths read at session start; they are never
 *   mounted writable — the sandbox confinement stays untouched.
 */

import { randomUUID } from 'crypto';
import { existsSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { getDatabase, type DatabaseInstance, type ProjectRow, type SessionRow } from '../db/database';
import type { PipelineMode, Project } from '../../shared/types';
import { normalizePipelineMode } from './two-stage-pipeline';
import { log, logError } from '../utils/logger';

interface CreateProjectInput {
  name: string;
  workdir: string;
  description?: string;
  configSetId?: string;
  /** Model pinned inside the selected ConfigSet (absent = its active model). */
  modelId?: string;
  /** Answer pipeline (absent = 'single', the legacy behavior). */
  pipelineMode?: PipelineMode;
  /** Draft-pass ConfigSet for two-stage mode (absent = global active ConfigSet). */
  draftConfigSetId?: string;
  draftModelId?: string;
  /** Refine-pass ConfigSet for two-stage mode (absent = pipeline disabled). */
  refineConfigSetId?: string;
  refineModelId?: string;
  instructions?: string;
}

interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  workdir?: string;
  configSetId?: string | null;
  modelId?: string | null;
  pipelineMode?: PipelineMode;
  draftConfigSetId?: string | null;
  draftModelId?: string | null;
  refineConfigSetId?: string | null;
  refineModelId?: string | null;
  instructions?: string | null;
  archived?: boolean;
}

export class ProjectValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectValidationError';
  }
}

function rowToProject(
  row: ProjectRow,
  referenceFiles: string[]
): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    workdir: row.workdir,
    configSetId: row.config_set_id,
    modelId: row.config_model_id,
    pipelineMode: normalizePipelineMode(row.pipeline_mode),
    draftConfigSetId: row.draft_config_set_id ?? null,
    draftModelId: row.draft_config_model_id ?? null,
    refineConfigSetId: row.refine_config_set_id ?? null,
    refineModelId: row.refine_config_model_id ?? null,
    instructions: row.instructions,
    archived: row.archived === 1,
    referenceFiles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Validate a workdir: non-empty, absolute, existing directory. */
function validateWorkdir(workdir: string): string {
  const trimmed = workdir.trim();
  if (!trimmed) throw new ProjectValidationError('Project workspace path is required');
  if (!isAbsolute(trimmed)) {
    throw new ProjectValidationError('Project workspace path must be absolute');
  }
  const resolved = resolve(trimmed);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new ProjectValidationError(`Project workspace is not an existing directory: ${resolved}`);
  }
  return resolved;
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ProjectValidationError('Project name is required');
  return trimmed;
}

export class ProjectStore {
  constructor(
    private readonly deps: {
      projects: {
        create: (row: ProjectRow) => void;
        update: (id: string, updates: Partial<ProjectRow>) => void;
        get: (id: string) => ProjectRow | undefined;
        getAll: () => ProjectRow[];
        delete: (id: string) => void;
      };
      projectFiles: {
        add: (file: { id: string; project_id: string; file_path: string; added_at: number }) => void;
        remove: (projectId: string, filePath: string) => void;
        listByProject: (projectId: string) => Array<{ file_path: string }>;
        deleteByProject: (projectId: string) => void;
      };
      sessions: {
        get: (id: string) => SessionRow | undefined;
        update: (id: string, updates: Partial<SessionRow>) => void;
      };
      rawQuery: <T>(sql: string, ...params: unknown[]) => T[];
    }
  ) {}

  list(includeArchived = false): Project[] {
    const rows = this.deps.projects.getAll();
    return rows
      .filter((row) => includeArchived || row.archived === 0)
      .map((row) => rowToProject(row, this.deps.projectFiles.listByProject(row.id).map((f) => f.file_path)));
  }

  get(projectId: string): Project | undefined {
    const row = this.deps.projects.get(projectId);
    if (!row) return undefined;
    return rowToProject(row, this.deps.projectFiles.listByProject(projectId).map((f) => f.file_path));
  }

  create(input: CreateProjectInput): Project {
    const name = validateName(input.name);
    const workdir = validateWorkdir(input.workdir);
    const now = Date.now();
    const row: ProjectRow = {
      id: `project-${randomUUID()}`,
      name,
      description: input.description?.trim() || null,
      workdir,
      config_set_id: input.configSetId?.trim() || null,
      config_model_id: input.modelId?.trim() || null,
      pipeline_mode: normalizePipelineMode(input.pipelineMode),
      draft_config_set_id: input.draftConfigSetId?.trim() || null,
      draft_config_model_id: input.draftModelId?.trim() || null,
      refine_config_set_id: input.refineConfigSetId?.trim() || null,
      refine_config_model_id: input.refineModelId?.trim() || null,
      instructions: input.instructions?.trim() || null,
      archived: 0,
      created_at: now,
      updated_at: now,
    };
    this.deps.projects.create(row);
    log('[ProjectStore] Created project:', row.name, '→', row.workdir);
    return rowToProject(row, []);
  }

  update(projectId: string, input: UpdateProjectInput): Project {
    const existing = this.deps.projects.get(projectId);
    if (!existing) throw new ProjectValidationError(`Project not found: ${projectId}`);

    const updates: Partial<ProjectRow> = {};
    if (input.name !== undefined) updates.name = validateName(input.name);
    if (input.workdir !== undefined) updates.workdir = validateWorkdir(input.workdir);
    if (input.description !== undefined) updates.description = input.description?.trim() || null;
    if (input.configSetId !== undefined) updates.config_set_id = input.configSetId?.trim() || null;
    if (input.modelId !== undefined) updates.config_model_id = input.modelId?.trim() || null;
    if (input.pipelineMode !== undefined) {
      updates.pipeline_mode = normalizePipelineMode(input.pipelineMode);
    }
    if (input.draftConfigSetId !== undefined) {
      updates.draft_config_set_id = input.draftConfigSetId?.trim() || null;
    }
    if (input.draftModelId !== undefined) {
      updates.draft_config_model_id = input.draftModelId?.trim() || null;
    }
    if (input.refineConfigSetId !== undefined) {
      updates.refine_config_set_id = input.refineConfigSetId?.trim() || null;
    }
    if (input.refineModelId !== undefined) {
      updates.refine_config_model_id = input.refineModelId?.trim() || null;
    }
    if (input.instructions !== undefined) updates.instructions = input.instructions?.trim() || null;
    if (input.archived !== undefined) updates.archived = input.archived ? 1 : 0;

    if (Object.keys(updates).length > 0) {
      this.deps.projects.update(projectId, updates);
    }
    const updated = this.get(projectId);
    if (!updated) throw new ProjectValidationError(`Project vanished during update: ${projectId}`);
    return updated;
  }

  archive(projectId: string, archived: boolean): Project {
    return this.update(projectId, { archived });
  }

  /**
   * Permanently delete an ARCHIVED project (double safety: archive first).
   * Linked sessions are ORPHANED — their project_id is reset to null, they are
   * NEVER deleted (conversations are the user's data, not the project's).
   * Reference-file associations are removed from the database; the files
   * themselves on disk are the user's and stay untouched.
   */
  delete(projectId: string): { orphanedSessions: number; removedReferenceFiles: number } {
    const project = this.get(projectId);
    if (!project) throw new ProjectValidationError(`Project not found: ${projectId}`);
    if (!project.archived) {
      throw new ProjectValidationError(
        'Archive the project before deleting it — permanent delete works only on archived projects'
      );
    }

    // Orphan the linked sessions (never delete them) via the existing DAL
    // update path — one dynamic UPDATE per session, sessions are few.
    const linked = this.getSessions(projectId);
    for (const session of linked) {
      this.deps.sessions.update(session.id, { project_id: null });
    }

    // Remove reference-file associations, then the project row.
    const removedReferenceFiles = project.referenceFiles.length;
    this.deps.projectFiles.deleteByProject(projectId);
    this.deps.projects.delete(projectId);
    log(
      `[ProjectStore] Deleted project "${project.name}": ${linked.length} session(s) orphaned ` +
        `(kept), ${removedReferenceFiles} reference-file association(s) removed`
    );
    return { orphanedSessions: linked.length, removedReferenceFiles };
  }

  attachFile(projectId: string, filePath: string): Project {
    const project = this.get(projectId);
    if (!project) throw new ProjectValidationError(`Project not found: ${projectId}`);

    const trimmed = filePath.trim();
    if (!isAbsolute(trimmed)) {
      throw new ProjectValidationError('Reference file path must be absolute');
    }
    const resolved = resolve(trimmed);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new ProjectValidationError(`Reference file is not an existing file: ${resolved}`);
    }
    // Idempotent: UNIQUE(project_id, file_path) + INSERT OR IGNORE in the DAL.
    this.deps.projectFiles.add({
      id: `pfile-${randomUUID()}`,
      project_id: projectId,
      file_path: resolved,
      added_at: Date.now(),
    });
    log('[ProjectStore] Attached reference file to project:', project.name, '→', resolved);
    const updated = this.get(projectId);
    if (!updated) throw new ProjectValidationError(`Project vanished: ${projectId}`);
    return updated;
  }

  detachFile(projectId: string, filePath: string): Project {
    const project = this.get(projectId);
    if (!project) throw new ProjectValidationError(`Project not found: ${projectId}`);
    this.deps.projectFiles.remove(projectId, resolve(filePath.trim()));
    return this.get(projectId)!;
  }

  /**
   * Bind a session to a project. The session keeps its own identity — the link
   * is just the sessions.project_id column. Throws when either side is unknown.
   */
  linkSession(projectId: string, sessionId: string): void {
    const project = this.get(projectId);
    if (!project) throw new ProjectValidationError(`Project not found: ${projectId}`);
    const session = this.deps.sessions.get(sessionId);
    if (!session) throw new ProjectValidationError(`Session not found: ${sessionId}`);
    this.deps.sessions.update(sessionId, { project_id: projectId });
    log('[ProjectStore] Linked session to project:', sessionId, '→', project.name);
  }

  unlinkSession(sessionId: string): void {
    const session = this.deps.sessions.get(sessionId);
    if (!session) return;
    this.deps.sessions.update(sessionId, { project_id: null });
  }

  /** Sessions bound to a project, newest activity first. */
  getSessions(projectId: string): SessionRow[] {
    return this.deps.rawQuery<SessionRow>(
      'SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC',
      projectId
    );
  }

  /** The project a session belongs to, when any. Never throws. */
  getForSession(sessionId: string): Project | undefined {
    try {
      const session = this.deps.sessions.get(sessionId);
      const projectId = session?.project_id;
      if (!projectId) return undefined;
      return this.get(projectId);
    } catch (err) {
      logError('[ProjectStore] Failed resolving project for session:', sessionId, err);
      return undefined;
    }
  }
}

/** Wire a ProjectStore over the application database instance. */
export function createProjectStore(db: DatabaseInstance): ProjectStore {
  return new ProjectStore({
    projects: db.projects,
    projectFiles: db.projectFiles,
    sessions: db.sessions,
    rawQuery: <T>(sql: string, ...params: unknown[]) =>
      db.raw.prepare(sql).all(...params) as T[],
  });
}

let sharedStore: ProjectStore | null = null;

/**
 * Shared store over the application database. Lazily wires itself once the DB
 * is initialized; throws only when called before initDatabase() (callers in
 * the agent runner degrade to an empty project context on that error).
 */
export function getSharedProjectStore(): ProjectStore {
  if (!sharedStore) {
    sharedStore = createProjectStore(getDatabase());
  }
  return sharedStore;
}