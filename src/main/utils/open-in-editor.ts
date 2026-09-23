/**
 * @module main/utils/open-in-editor
 *
 * Open a workspace file in the user's editor, optionally at a given line.
 *
 * The renderer never picks the editor or the root: the caller passes the
 * session workspace root, the target is validated to be a real file inside
 * that root, and only then is a known editor URI scheme tried. When no known
 * editor is installed the file falls back to the OS default application, so
 * the action always has a defined outcome instead of a broken protocol dialog.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { shell } from 'electron';
import { log, logWarn } from './logger';
import { resolveWorkspaceFile } from './workspace-path';

export interface EditorCandidate {
  id: string;
  /** URI scheme understood by the editor, e.g. 'vscode'. */
  scheme: string;
  /** macOS application bundle names to probe. */
  appNames: string[];
  /** Command names probed on PATH on the other platforms. */
  binaries: string[];
}

export const EDITOR_CANDIDATES: readonly EditorCandidate[] = [
  { id: 'vscode', scheme: 'vscode', appNames: ['Visual Studio Code.app'], binaries: ['code'] },
  { id: 'cursor', scheme: 'cursor', appNames: ['Cursor.app'], binaries: ['cursor'] },
  { id: 'windsurf', scheme: 'windsurf', appNames: ['Windsurf.app'], binaries: ['windsurf'] },
  { id: 'zed', scheme: 'zed', appNames: ['Zed.app'], binaries: ['zed'] },
  { id: 'sublime', scheme: 'subl', appNames: ['Sublime Text.app'], binaries: ['subl'] },
];

export interface EditorDetectionEnvironment {
  platform: NodeJS.Platform;
  home: string;
  /** PATH entries; only used when platform is not darwin. */
  pathEntries: string[];
  exists: (candidate: string) => boolean;
}

/**
 * Editor schemes installed on the machine, in preference order. Probing the
 * real application/binary instead of blindly opening a scheme avoids the
 * 'no application is set to open this URL' system dialog.
 */
export function detectEditorSchemes(env: EditorDetectionEnvironment): string[] {
  const found: string[] = [];
  for (const candidate of EDITOR_CANDIDATES) {
    const installed =
      env.platform === 'darwin'
        ? candidate.appNames.some(
            (name) =>
              env.exists(join('/Applications', name)) ||
              env.exists(join(env.home, 'Applications', name))
          )
        : candidate.binaries.some((binary) =>
            env.pathEntries.some((entry) => {
              if (!entry) return false;
              if (env.exists(join(entry, binary))) return true;
              if (env.platform === 'win32') {
                return (
                  env.exists(join(entry, binary + '.cmd')) ||
                  env.exists(join(entry, binary + '.exe'))
                );
              }
              return false;
            })
          );
    if (installed) found.push(candidate.scheme);
  }
  return found;
}

export function detectInstalledEditorSchemes(): string[] {
  return detectEditorSchemes({
    platform: process.platform,
    home: homedir(),
    pathEntries: (process.env.PATH ?? '').split(delimiter),
    exists: existsSync,
  });
}

/** Line numbers are clamped to a sane range; anything else means 'no line'. */
export function normalizeEditorLine(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const line = Math.floor(value);
  if (line < 1 || line > 1_000_000) return null;
  return line;
}

const EDITOR_URL_BUILDERS: Record<string, (target: string, line: number | null) => string> = {
  subl: (target, line) => {
    const url = 'subl://open?url=file://' + encodeURI(target);
    return line === null ? url : url + '&line=' + line;
  },
};

/** Build the deep link that opens a file (and line) in a known editor. */
export function buildEditorUrl(scheme: string, filePath: string, line: number | null): string {
  const normalized = filePath.replace(/\\/g, '/');
  const builder = EDITOR_URL_BUILDERS[scheme];
  if (builder) return builder(normalized, line);
  const base = scheme + '://file/' + encodeURI(normalized.replace(/^\//, ''));
  return line === null ? base : base + ':' + line + ':1';
}

export interface EditorOpener {
  openExternal(url: string): Promise<void>;
  /** Returns an error message when the OS could not open the path. */
  openPath(target: string): Promise<string>;
}

export function createShellEditorOpener(): EditorOpener {
  return {
    openExternal: (url) => shell.openExternal(url),
    openPath: (target) => shell.openPath(target),
  };
}

export interface OpenInEditorRequest {
  /** Session workspace root the target must live inside. */
  root: string;
  /** Absolute or root-relative path of the file to open. */
  path: unknown;
  line?: number | null;
  /** Schemes to try, in order; detected from the machine by default. */
  schemes?: readonly string[];
}

export interface OpenInEditorResult {
  success: boolean;
  /** How the file was opened: an editor scheme, or 'default'. */
  method?: string;
  error?: string;
}

export async function openFileInEditor(
  request: OpenInEditorRequest,
  opener: EditorOpener = createShellEditorOpener()
): Promise<OpenInEditorResult> {
  const target = resolveWorkspaceFile(request.root, request.path);
  if (!target) {
    logWarn('[openInEditor] refused a target outside the workspace, or missing');
    return { success: false, error: 'invalid_target' };
  }
  const line = normalizeEditorLine(request.line ?? null);
  const schemes = request.schemes ?? detectInstalledEditorSchemes();
  for (const scheme of schemes) {
    try {
      await opener.openExternal(buildEditorUrl(scheme, target, line));
      log('[openInEditor] opened with scheme:', scheme);
      return { success: true, method: scheme };
    } catch {
      // Editor not installed, or the scheme has no handler: try the next one.
    }
  }
  try {
    const failure = await opener.openPath(target);
    if (failure) {
      logWarn('[openInEditor] the default application refused the file');
      return { success: false, error: 'open_failed' };
    }
    return { success: true, method: 'default' };
  } catch {
    logWarn('[openInEditor] the default application failed to open the file');
    return { success: false, error: 'open_failed' };
  }
}
