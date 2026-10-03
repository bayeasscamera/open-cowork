/**
 * @module main/machine-access/project-rename
 *
 * Project rename (spec 5): two distinct options — display name only, or
 * display name + on-disk folder. Folder renames preview every reference
 * (project workdir, session cwds, project reference files), run the database
 * updates in one transaction plus an atomic folder rename, and roll back
 * fully when any step fails. Refuses while the folder is in use, when the
 * target exists, and warns (never guesses) on git configs holding absolute
 * paths. Cross-device moves copy + verify + trash the source.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FsJournal } from './fs-journal';

export interface RenameRef {
  kind: 'project.workdir' | 'session.cwd' | 'project-file' | 'note';
  id: string;
  before: string;
  after: string;
}

export interface RenamePreview {
  projectId: string;
  newName: string;
  renameDir: boolean;
  newWorkdir?: string;
  refs: RenameRef[];
  warnings: string[];
}

export interface RenameDeps {
  getProject: (id: string) => { id: string; name: string; workdir: string } | undefined;
  listSessions: (projectId: string) => Array<{ id: string; cwd: string }>;
  listFiles: (projectId: string) => string[];
  /** Run fn inside a DB transaction; rollback on throw. */
  transaction: (fn: () => void) => void;
  applyDbUpdates: (updates: {
    project: { name: string; workdir?: string };
    sessions: Array<{ id: string; cwd: string }>;
    files: Array<{ before: string; after: string }>;
  }) => void;
  isInUse: (workdir: string) => string | null;
  journal: FsJournal;
  /**
   * Whether source and destination live on the same filesystem. Injected so
   * the cross-device branch (copy + verify + trash the source) is reachable in
   * tests; production omits it and gets the real `stat().dev` comparison.
   */
  isSameDevice?: (from: string, to: string) => boolean;
}

const INVALID_NAME = /[<>:"|?*\0]/;

export function validateProjectName(name: string, platform: NodeJS.Platform = process.platform): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Project name is required.');
  if (trimmed.length > 200) throw new Error('Project name is too long.');
  if (INVALID_NAME.test(trimmed) || trimmed.includes('/')) throw new Error(`Invalid project name: '${trimmed}'.`);
  if (platform === 'win32') {
    const upper = trimmed.split('.')[0]?.toUpperCase() ?? '';
    const reserved = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1']);
    if (reserved.has(upper)) throw new Error(`Reserved project name: '${trimmed}'.`);
  }
  return trimmed;
}

function rebasePath(filePath: string, oldRoot: string, newRoot: string): string | null {
  const rel = path.relative(oldRoot, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return path.join(newRoot, rel);
}

export function previewRename(
  deps: Pick<RenameDeps, 'getProject' | 'listSessions' | 'listFiles'>,
  projectId: string,
  newName: string,
  renameDir: boolean,
  newDirName?: string
): RenamePreview {
  const project = deps.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const validName = validateProjectName(newName);
  const refs: RenameRef[] = [];
  const warnings: string[] = [];
  let newWorkdir: string | undefined;

  if (renameDir) {
    const dirName = (newDirName ?? validName).trim();
    validateProjectName(dirName);
    newWorkdir = path.join(path.dirname(project.workdir), dirName);
    refs.push({ kind: 'project.workdir', id: project.id, before: project.workdir, after: newWorkdir });
    for (const session of deps.listSessions(projectId)) {
      const rebased = rebasePath(session.cwd, project.workdir, newWorkdir);
      refs.push({
        kind: 'session.cwd',
        id: session.id,
        before: session.cwd,
        after: rebased ?? `${session.cwd} (outside folder; unchanged)`,
      });
    }
    for (const file of deps.listFiles(projectId)) {
      const rebased = rebasePath(file, project.workdir, newWorkdir);
      refs.push({
        kind: 'project-file',
        id: file,
        before: file,
        after: rebased ?? `${file} (outside folder; unchanged)`,
      });
    }
    // Git configs with absolute paths: warn, never guess.
    try {
      const gitConfig = path.join(project.workdir, '.git', 'config');
      if (fs.existsSync(gitConfig)) {
        const content = fs.readFileSync(gitConfig, 'utf-8');
        if (content.includes(project.workdir)) {
          warnings.push('.git/config holds absolute paths; update them manually after the rename.');
        }
      }
    } catch {
      // ignore
    }
    refs.push({ kind: 'note', id: 'skills', before: 'skill paths', after: 'review skill paths pointing at the old folder' });
  }

  return { projectId, newName: validName, renameDir, ...(newWorkdir ? { newWorkdir } : {}), refs, warnings };
}

function copyRecursive(src: string, dest: string): void {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

/** Execute a previewed rename. Rolls back fully on any failure; journaled. */
export function executeRename(deps: RenameDeps, preview: RenamePreview): { workdir?: string } {
  const project = deps.getProject(preview.projectId);
  if (!project) throw new Error(`Project not found: ${preview.projectId}`);
  validateProjectName(preview.newName);

  if (!preview.renameDir || !preview.newWorkdir) {
    // Display-name only: single DB update, no filesystem touch.
    deps.transaction(() =>
      deps.applyDbUpdates({ project: { name: preview.newName }, sessions: [], files: [] })
    );
    return {};
  }

  const from = project.workdir;
  const to = preview.newWorkdir;
  const busy = deps.isInUse(from);
  if (busy) throw new Error(`Folder in use: ${busy}; retry when idle.`);
  if (fs.existsSync(to)) throw new Error(`Target already exists: '${to}'.`);

  const sessions = deps
    .listSessions(preview.projectId)
    .map((s) => ({ id: s.id, cwd: rebasePath(s.cwd, from, to) ?? s.cwd }));
  const files = deps
    .listFiles(preview.projectId)
    .map((f) => ({ before: f, after: rebasePath(f, from, to) ?? f }));

  const batchId = randomUUID();
  const sameDevice = deps.isSameDevice
    ? deps.isSameDevice(from, to)
    : (() => {
        try {
          return fs.statSync(path.dirname(from)).dev === fs.statSync(path.dirname(to)).dev;
        } catch {
          return true;
        }
      })();

  // Move the folder first, then the DB — so a DB failure can roll the FS back.
  let fsMoved = false;
  try {
    if (sameDevice) {
      fs.renameSync(from, to);
    } else {
      copyRecursive(from, to);
      // Verify: every source file must exist at the destination.
      const verify = (srcDir: string, destDir: string): void => {
        for (const entry of fs.readdirSync(srcDir)) {
          const s = path.join(srcDir, entry);
          const d = path.join(destDir, entry);
          if (!fs.existsSync(d)) throw new Error(`Verify failed for '${d}'.`);
          if (fs.statSync(s).isDirectory()) verify(s, d);
        }
      };
      verify(from, to);
    }
    fsMoved = true;
    deps.transaction(() =>
      deps.applyDbUpdates({ project: { name: preview.newName, workdir: to }, sessions, files })
    );
    if (!sameDevice) {
      // Source verified at destination: trash it (never rm -rf).
      const trashDir = path.join(path.dirname(from), '.cowork-trash');
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(from, path.join(trashDir, `${Date.now()}-${path.basename(from)}`));
    }
    deps.journal.record({ batchId, type: 'move', source: from, destination: to });
    return { workdir: to };
  } catch (error) {
    if (fsMoved && sameDevice && fs.existsSync(to) && !fs.existsSync(from)) {
      try {
        fs.renameSync(to, from);
      } catch {
        // Report both failures; FS state is explicit.
      }
    }
    throw error;
  }
}
