/**
 * @module main/documents/document-doc
 *
 * Live co-editing of a workspace document (Markdown first). Both the user
 * (panel) and the agent (write/edit tools) touch the SAME file on disk; sync
 * is done by re-reading the file — agent→UI via the panel's poll, UI→agent
 * because the agent re-reads files like any workspace file.
 *
 * Confinement: the path must resolve inside the session workspace (same
 * realpath-based rule as the agent's file tools). Conflict detection: writes
 * carry the mtime the editor last saw — if the file changed on disk since
 * then (agent edit), the write is refused instead of silently clobbering.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isPathWithinRoot } from '../tools/path-containment';
import { logError } from '../utils/logger';

interface ReadDocResult {
  ok: boolean;
  content?: string;
  mtimeMs?: number;
  error?: string;
}

interface WriteDocResult {
  ok: boolean;
  status: 'written' | 'conflict' | 'error';
  mtimeMs?: number;
  error?: string;
}

/** Resolve a doc path against the workspace and confine it (realpath-aware). */
function resolveConfined(cwd: string, docPath: string): string | null {
  try {
    const resolved = path.resolve(cwd, docPath);
    const realCwd = fs.realpathSync(cwd);
    if (!isPathWithinRoot(fs.realpathSync(path.dirname(resolved)), realCwd)) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

export function readWorkspaceDoc(cwd: string, docPath: string): ReadDocResult {
  try {
    const resolved = resolveConfined(cwd, docPath);
    if (!resolved) return { ok: false, error: 'Path is outside the workspace' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File not found' };
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: 'Not a file' };
    return {
      ok: true,
      content: fs.readFileSync(resolved, 'utf-8'),
      mtimeMs: stat.mtimeMs,
    };
  } catch (err) {
    logError('[DocumentDoc] Read failed:', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write the user's edit. `baseMtimeMs` is the mtime the editor last saw: when
 * the file changed on disk after that (the agent edited meanwhile), the write
 * is REFUSED with status 'conflict' — the UI warns instead of clobbering.
 * Pass force=true to overwrite anyway after the user confirms.
 */
export function writeWorkspaceDoc(
  cwd: string,
  docPath: string,
  content: string,
  options: { baseMtimeMs?: number; force?: boolean } = {}
): WriteDocResult {
  try {
    const resolved = resolveConfined(cwd, docPath);
    if (!resolved) return { ok: false, status: 'error', error: 'Path is outside the workspace' };

    if (fs.existsSync(resolved) && options.baseMtimeMs !== undefined && !options.force) {
      const current = fs.statSync(resolved).mtimeMs;
      // 1500ms slack for filesystem timestamp granularity.
      if (current > options.baseMtimeMs + 1500) {
        return {
          ok: false,
          status: 'conflict',
          mtimeMs: current,
          error: 'The file was modified by the agent while you were editing.',
        };
      }
    }

    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, 'utf-8');
    const mtimeMs = fs.statSync(resolved).mtimeMs;
    return { ok: true, status: 'written', mtimeMs };
  } catch (err) {
    logError('[DocumentDoc] Write failed:', err);
    return { ok: false, status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/** List workspace Markdown files (shallow + one level) for the open picker. */
export function listWorkspaceDocs(cwd: string): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 1) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (/\.(md|markdown|txt)$/i.test(entry.name)) {
        try {
          out.push({ path: path.relative(cwd, full), mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          // unreadable entry — skip
        }
      }
    }
  };
  visit(cwd, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 50);
}