/**
 * @module main/mods/builtin-mods
 *
 * The four built-in mods, all local-only. Registration order matters: the
 * security-redactor runs AFTER telemetry (it sees the final content), and
 * the diff-collector's "before" snapshot must be taken before any write.
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from '../utils/logger';
import { redactSecrets } from '../utils/secret-redaction';
import type { CoworkMod, ModsToolCall, ModsToolResult } from './mods-runtime';

// ---------------------------------------------------------------------------
// 1. telemetry — local-only tool-call log lines; never any network send.
// ---------------------------------------------------------------------------

const telemetryMod: CoworkMod = {
  id: 'telemetry',
  label: 'Telemetry (local)',
  description: 'Records every tool call to the local application log. No network.',
  onPostToolUse: (call: ModsToolCall) => {
    log(`[Mods:telemetry] tool=${call.toolName} session=${call.sessionId}`);
  },
};

// ---------------------------------------------------------------------------
// 2. security-redactor — strips secrets from tool outputs before they
//    reach the model context or the renderer. Uses the shared redaction
//    rules from utils/secret-redaction (single source of truth).
// ---------------------------------------------------------------------------

/** Redact every recognized secret pattern from a text. Exported for tests. */
export { redactSecrets };

export const securityRedactorMod: CoworkMod = {
  id: 'security-redactor',
  label: 'Security redactor',
  description:
    'Filters tokens, API keys and connection strings out of tool outputs before they reach the model or the UI.',
  onPostToolUse: (_call: ModsToolCall, result: ModsToolResult) => {
    const redacted = redactSecrets(result.content);
    if (redacted !== result.content) {
      log(`[Mods:security-redactor] redacted secrets from a ${_call.toolName} output`);
      return { replaceContent: redacted };
    }
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// 3. domain-loader — project-domain conventions from the workspace, merged
//    into the system prompt (complements AGENTS.md; never replaces it).
// ---------------------------------------------------------------------------

const DOMAIN_CONVENTIONS_FILE = path.join('.cowork', 'domain-conventions.md');

export const domainLoaderMod: CoworkMod = {
  id: 'domain-loader',
  label: 'Domain conventions loader',
  description:
    'Loads workspace domain conventions (.cowork/domain-conventions.md) into the system prompt.',
  getContextAdditions: (cwd: string): string => {
    try {
      const file = path.join(cwd, DOMAIN_CONVENTIONS_FILE);
      if (!fs.existsSync(file)) return '';
      const content = fs.readFileSync(file, 'utf-8').trim();
      if (!content) return '';
      return `<domain_conventions>\n${content}\n</domain_conventions>`;
    } catch {
      return ''; // unreadable conventions never break the session
    }
  },
};

// ---------------------------------------------------------------------------
// 4. diff-collector — feeds the live diff panel: snapshots the target file
//    before write/edit, captures the result after, and exposes per-session
//    per-file diffs with line counts and a naive unified-style diff text.
// ---------------------------------------------------------------------------

interface DiffFileEntry {
  path: string;
  before: string | null;
  after: string | null;
  added: number;
  removed: number;
  diff: string;
  updatedAt: number;
}

const WRITE_TOOLS = new Set(['write', 'edit']);

const MAX_LCS_LINES = 2000;

interface LineDiff {
  added: number;
  removed: number;
  text: string;
}

/** Split without the phantom trailing empty line of a trailing newline. */
function toLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Bounded LCS line diff. Files over MAX_LCS_LINES fall back to whole-block. */
function lineDiff(before: string | null, after: string | null): LineDiff {
  if (before === null && after === null) return { added: 0, removed: 0, text: '' };
  if (before === null) {
    const lines = toLines(after!);
    return { added: lines.length, removed: 0, text: lines.map((l) => `+ ${l}`).join('\n') };
  }
  if (after === null) {
    const lines = toLines(before);
    return { added: 0, removed: lines.length, text: lines.map((l) => `- ${l}`).join('\n') };
  }
  const beforeLines = toLines(before);
  const afterLines = toLines(after);

  // Trim the common prefix and suffix (covers most edits cheaply).
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const midBefore = beforeLines.slice(prefix, beforeLines.length - suffix);
  const midAfter = afterLines.slice(prefix, afterLines.length - suffix);

  if (midBefore.length === 0 && midAfter.length === 0) {
    return { added: 0, removed: 0, text: '' };
  }
  if (midBefore.length > MAX_LCS_LINES || midAfter.length > MAX_LCS_LINES) {
    // Honest fallback for huge files: report the whole changed block.
    return {
      added: midAfter.length,
      removed: midBefore.length,
      text: [
        ...midBefore.map((l) => `- ${l}`),
        ...midAfter.map((l) => `+ ${l}`),
      ].join('\n'),
    };
  }

  // LCS table (mid sections are bounded).
  const rows = midBefore.length;
  const cols = midAfter.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = midBefore[i] === midAfter[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const parts: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (midBefore[i] === midAfter[j]) {
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      parts.push(`- ${midBefore[i]}`);
      removed += 1;
      i += 1;
    } else {
      parts.push(`+ ${midAfter[j]}`);
      added += 1;
      j += 1;
    }
  }
  while (i < rows) {
    parts.push(`- ${midBefore[i]}`);
    removed += 1;
    i += 1;
  }
  while (j < cols) {
    parts.push(`+ ${midAfter[j]}`);
    added += 1;
    j += 1;
  }
  return { added, removed, text: parts.join('\n') };
}

/** Real (symlink-resolved) target for containment checks; macOS process cwd
 * can be /private/var while mkdtemp paths say /var — lexical compare fails. */
function realTargetPath(target: string): string {
  const parent = path.dirname(target);
  const base = path.basename(target);
  try {
    return path.join(fs.realpathSync(parent), base);
  } catch {
    return target;
  }
}

function realRootPath(root: string): string {
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

function isWithinRoot(rawTarget: string, root: string): boolean {
  const target = realTargetPath(rawTarget);
  const realRoot = realRootPath(root);
  return target.startsWith(realRoot + path.sep) || target === realRoot;
}

export class DiffCollector {
  /** sessionId → Map<path, DiffFileEntry> */
  private readonly sessions = new Map<string, Map<string, DiffFileEntry>>();

  private store(sessionId: string): Map<string, DiffFileEntry> {
    let files = this.sessions.get(sessionId);
    if (!files) {
      files = new Map();
      this.sessions.set(sessionId, files);
    }
    return files;
  }

  /** Snapshot the file content before a write/edit executes (read-only). */
  captureBefore(sessionId: string, rawPath: string, cwd: string): void {
    const target = path.resolve(cwd, rawPath);
    if (!isWithinRoot(target, cwd)) return;
    try {
      const files = this.store(sessionId);
      // Only the FIRST write in the session is the true "before".
      if (!files.has(target)) {
        const exists = fs.existsSync(target) && fs.statSync(target).isFile();
        files.set(target, {
          path: target,
          before: exists ? fs.readFileSync(target, 'utf-8') : null,
          after: null,
          added: 0,
          removed: 0,
          diff: '',
          updatedAt: Date.now(),
        });
      }
    } catch {
      // unreadable target never breaks the tool call
    }
  }

  /** Capture the file content after the write/edit completed. */
  captureAfter(sessionId: string, rawPath: string, cwd: string): void {
    const target = path.resolve(cwd, rawPath);
    if (!isWithinRoot(target, cwd)) return;
    try {
      const files = this.store(sessionId);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        // File deleted by the operation: keep the snapshot, after=null.
        const entry = files.get(target);
        if (entry) {
          entry.after = null;
          const result = lineDiff(entry.before, null);
          entry.added = result.added;
          entry.removed = result.removed;
          entry.diff = result.text;
          entry.updatedAt = Date.now();
        }
        return;
      }
      const after = fs.readFileSync(target, 'utf-8');
      const entry = files.get(target);
      if (!entry) {
        // A write happened without a pre-snapshot (e.g. mod disabled mid-run):
        // record with before=null — still useful as a "created/modified" entry.
        files.set(target, {
          path: target,
          before: null,
          after,
          added: 0,
          removed: 0,
          diff: '',
          updatedAt: Date.now(),
        });
      } else {
        entry.after = after;
      }
      const stored = files.get(target)!;
      const result = lineDiff(stored.before, stored.after);
      stored.added = result.added;
      stored.removed = result.removed;
      stored.diff = result.text;
      stored.updatedAt = Date.now();
    } catch {
      // unreadable target never breaks the tool call
    }
  }

  summary(sessionId: string): Array<{
    path: string;
    added: number;
    removed: number;
    updatedAt: number;
    before: string | null;
    after: string | null;
    diff: string;
  }> {
    const files = this.sessions.get(sessionId);
    if (!files) return [];
    return [...files.values()]
      .filter((entry) => entry.after !== undefined || entry.before !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({
        path: entry.path,
        added: entry.added,
        removed: entry.removed,
        updatedAt: entry.updatedAt,
        before: entry.before,
        after: entry.after,
        diff: entry.diff,
      }));
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

const diffCollector = new DiffCollector();

function targetPathOf(args: Record<string, unknown>): string | null {
  const raw = (args as { path?: unknown }).path;
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

const diffCollectorMod: CoworkMod = {
  id: 'diff-panel',
  label: 'Live diff panel',
  description:
    'Collects per-session file changes (before/after) from write/edit calls and feeds the live diff panel.',
  onPreToolUse: (call: ModsToolCall) => {
    if (!WRITE_TOOLS.has(call.toolName)) return undefined;
    const target = targetPathOf(call.args);
    if (!target) return undefined;
    diffCollector.captureBefore(call.sessionId, target, process.cwd());
    return undefined;
  },
  onPostToolUse: (call: ModsToolCall) => {
    if (!WRITE_TOOLS.has(call.toolName)) return undefined;
    const target = targetPathOf(call.args);
    if (!target) return undefined;
    diffCollector.captureAfter(call.sessionId, target, process.cwd());
    return undefined;
  },
};

export function getDiffCollector(): DiffCollector {
  return diffCollector;
}

/** The registry contents in registration order. */
export function createBuiltinMods(): CoworkMod[] {
  return [telemetryMod, diffCollectorMod, domainLoaderMod, securityRedactorMod];
}