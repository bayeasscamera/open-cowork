/**
 * Bounded clone for plugin sources.
 *
 * Reuses `scrubEnv` and `killGroup` from machine-access/command-runner rather
 * than reinventing them: a clone that inherited the app's environment would hand
 * every credential in it to whatever the repository's config evaluates, and a
 * clone without a process-group kill leaves orphans behind when it times out.
 *
 * Hardening, and why each line matters:
 *  - https only. An `ext::` or `file://` remote makes git a file reader or a
 *    command executor; both are ways to turn "install a plugin" into something
 *    else entirely.
 *  - `--depth 1`: a shallow clone cannot be used to walk history, and it is
 *    dramatically faster.
 *  - hooks disabled: `git clone` does not run remote hooks, but a submodule or a
 *    smudge filter can, and this makes that explicit rather than assumed.
 *  - `--` before the URL: an argument that looks like a flag cannot become one.
 *  - no credential prompts: a clone that can hang waiting for input is a clone
 *    that never returns. `GIT_TERMINAL_PROMPT=0` fails fast instead.
 *
 * The clone result is data, never code: nothing is executed until the caller has
 * shown the user the review payload and received an approval.
 */

import { spawn } from 'child_process';
import { scrubEnv, killGroup } from '../../machine-access/command-runner';
import { log, logWarn } from '../../utils/logger';

export interface CloneRequest {
  readonly url: string;
  readonly destination: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface CloneResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** Injected so tests never spawn a real git process. */
export type ProcessSpawner = typeof spawn;

export const DEFAULT_CLONE_TIMEOUT_MS = 120_000;
export const DEFAULT_CLONE_MAX_OUTPUT = 64 * 1024;

export function isHttpsUrl(candidate: string): boolean {
  try {
    return new URL(candidate).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface CloneDeps {
  readonly spawnProcess?: ProcessSpawner;
  readonly now?: () => number;
}

/**
 * Shallow-clone a plugin repository into `destination`.
 *
 * Returns the process outcome; it does NOT validate the result. The caller must
 * run `buildInstallReview` on what landed and obtain an approval before anything
 * is loaded.
 */
export async function clonePlugin(
  request: CloneRequest,
  deps: CloneDeps = {}
): Promise<CloneResult> {
  const startedAt = (deps.now ?? Date.now)();
  if (!isHttpsUrl(request.url)) {
    return {
      ok: false,
      stdout: '',
      stderr: 'Only https:// plugin sources are accepted.',
      exitCode: null,
      timedOut: false,
      durationMs: 0,
    };
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
  const maxOutput = request.maxOutputBytes ?? DEFAULT_CLONE_MAX_OUTPUT;
  const spawner = deps.spawnProcess ?? spawn;
  const args = [
    'clone',
    '--depth',
    '1',
    '--no-tags',
    '--config',
    'core.hooksPath=/dev/null',
    '--config',
    'protocol.ext.allow=never',
    '--',
    request.url,
    request.destination,
  ];

  const env = scrubEnv({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' });

  return new Promise<CloneResult>((resolve) => {
    const child = spawner('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (chunk: Buffer, into: 'out' | 'err'): void => {
      const text = chunk.toString('utf-8');
      if (into === 'out') {
        if (stdout.length < maxOutput) stdout += text;
      } else if (stderr.length < maxOutput) {
        stderr += text;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      logWarn(`[Mods] git clone timed out after ${timeoutMs}ms — killing the process group`);
      killGroup(child.pid);
    }, timeoutMs);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0 && !timedOut,
        stdout,
        stderr,
        exitCode,
        timedOut,
        durationMs: (deps.now ?? Date.now)() - startedAt,
      });
    };

    child.on('error', (error) => {
      stderr += `${stderr ? '\n' : ''}${error.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Marketplace index — a plain JSON list of { id, name, url, sha? }.
 *
 * Read as DATA only. An index is untrusted input like any other: it is fetched,
 * parsed and displayed, and nothing in it is executed or trusted for a decision.
 * A `sha` is shown so a user can compare, not verified for them — the real
 * guarantee is the fingerprint they approve afterwards.
 */
export interface MarketplaceEntry {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly author?: string;
  readonly sha?: string;
  readonly description?: string;
}

export interface MarketplaceIndex {
  readonly version: 1;
  readonly mods: readonly MarketplaceEntry[];
}

export function parseMarketplaceIndex(raw: string): { ok: true; index: MarketplaceIndex } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `Index is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'Index must be a JSON object.' };
  }
  const candidate = parsed as { version?: unknown; mods?: unknown };
  if (candidate.version !== 1) {
    return { ok: false, error: 'Unsupported index version — expected 1.' };
  }
  if (!Array.isArray(candidate.mods)) {
    return { ok: false, error: 'Index has no "mods" array.' };
  }
  const mods: MarketplaceEntry[] = [];
  for (const item of candidate.mods) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: 'Each index entry must be an object.' };
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || typeof entry.name !== 'string' || typeof entry.url !== 'string') {
      return { ok: false, error: 'Each index entry needs id, name and url strings.' };
    }
    if (!isHttpsUrl(entry.url)) {
      return { ok: false, error: `Entry "${entry.id}" does not use an https URL.` };
    }
    mods.push({
      id: entry.id,
      name: entry.name,
      url: entry.url,
      ...(typeof entry.author === 'string' ? { author: entry.author } : {}),
      ...(typeof entry.sha === 'string' ? { sha: entry.sha } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
    });
  }
  return { ok: true, index: { version: 1, mods } };
}

export function logCloneOutcome(result: CloneResult, source: string): void {
  if (result.ok) {
    log(`[Mods] Cloned plugin source ${source} in ${result.durationMs}ms`);
    return;
  }
  logWarn(
    `[Mods] Clone of ${source} failed (exit ${result.exitCode ?? 'none'}${result.timedOut ? ', timed out' : ''}): ${result.stderr.trim().slice(0, 400)}`
  );
}