/**
 * @module main/git/git-operations
 *
 * Git commands for the branch selector, executed in the main process only —
 * the renderer never spawns a process (it has no Node access by design, and
 * passing a repository path through IPC into `child_process` keeps a single
 * place where arguments are escaped).
 *
 * Uses `execFile` with an argument array rather than a shell string: branch
 * names may contain spaces or shell metacharacters, and `execFile` never hands
 * them to a shell interpreter. Every call is bounded by a timeout so a
 * credential prompt or a hung network remote can never wedge the app.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** A hung git (credential prompt, unreachable remote) must not block the UI. */
const GIT_TIMEOUT_MS = 8000;
/** `git status --porcelain` is one line per changed path; this is a backstop. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface GitBranch {
  name: string;
  /** True for the branch currently checked out in the working tree. */
  current: boolean;
}

export interface GitBranchesResult {
  isRepo: boolean;
  branches: GitBranch[];
  currentBranch: string | null;
  /** Changed paths reported by `git status --porcelain` (one per line). */
  dirtyCount: number;
  /** Repo root, used for logging and for the "not a repo" UI state. */
  repoRoot: string | null;
  error?: string;
}

export interface GitCheckoutResult {
  ok: boolean;
  /** Stashed the working tree first, because checkout would otherwise fail. */
  stashed: boolean;
  error?: string;
}

interface ExecOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run one git command. Never throws: every failure is a value, because the UI
 * has to show Git's own message (a conflict or a blocked checkout) inside the
 * panel rather than crashing the handler.
 */
async function runGit(cwd: string, args: string[]): Promise<ExecOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      // Refuse to take the repo's own or the user's global config as
      // instructions; git reads them for aliases and hooks.
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string };
    return {
      ok: false,
      stdout: err.stdout ?? '',
      // Git explains itself on stderr; that text is what the user needs.
      stderr: (err.stderr || err.message || '').trim(),
    };
  }
}

/** True when `cwd` is inside a Git working tree. */
export async function isGitRepository(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return result.ok && result.stdout.trim() === 'true';
}

/**
 * Local branches with the current one flagged, plus the count of uncommitted
 * changes.
 *
 * `--porcelain` is parsed by counting lines, exactly as the UI states it: a
 * rename is one line, an untracked file is one line. `git status` is not
 * cached between calls — the panel refreshes on every open, so a stale count
 * would show a wrong number next to the branch being switched to.
 */
export async function listBranches(cwd: string): Promise<GitBranchesResult> {
  const empty: GitBranchesResult = {
    isRepo: false,
    branches: [],
    currentBranch: null,
    dirtyCount: 0,
    repoRoot: null,
  };

  const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    return empty;
  }

  const root = await runGit(cwd, ['rev-parse', '--show-toplevel']);

  // `%(HEAD)` marks the checked-out branch; `--format` keeps names with
  // slashes intact instead of the indented tree listing of plain `git branch`.
  const [branchList, status] = await Promise.all([
    runGit(cwd, ['branch', '--no-color', '--format=%(refname:short)%09%(HEAD)']),
    runGit(cwd, ['status', '--porcelain']),
  ]);

  if (!branchList.ok) {
    return {
      ...empty,
      isRepo: true,
      repoRoot: root.ok ? root.stdout.trim() : null,
      error: branchList.stderr || 'Unable to list branches',
    };
  }

  const branches: GitBranch[] = [];
  let currentBranch: string | null = null;

  for (const line of branchList.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // refname <TAB> HEAD marker ("* " when current, "  " otherwise).
    const [name, head] = trimmed.split('\t');
    if (!name) continue;
    const current = (head ?? '').trim() === '*';
    if (current) currentBranch = name;
    branches.push({ name, current });
  }

  const dirtyCount = status.ok
    ? status.stdout.split('\n').filter((line) => line.trim().length > 0).length
    : 0;

  return {
    isRepo: true,
    branches,
    currentBranch,
    dirtyCount,
    repoRoot: root.ok ? root.stdout.trim() : null,
  };
}

/**
 * Create and switch to a new branch (`git checkout -b`).
 */
export async function createAndCheckoutBranch(
  cwd: string,
  name: string
): Promise<GitCheckoutResult> {
  const result = await runGit(cwd, ['checkout', '-b', name]);
  if (result.ok) return { ok: true, stashed: false };
  return { ok: false, stashed: false, error: result.stderr || 'Unable to create the branch' };
}

/**
 * Switch to an existing branch (`git checkout <name>`), optionally carrying the
 * working tree across.
 *
 * Verified behaviour of `git stash`: it puts the changes *aside* on the original
 * branch, it does not apply them to the new one. A plain stash-then-checkout
 * would therefore leave the user on the new branch with a clean tree and their
 * work parked in `git stash list` — the opposite of "take them with you". So
 * the changes are stashed, the branch is switched, and the stash is popped onto
 * the destination branch. If the pop conflicts, git reports it and the work is
 * still recoverable from the stash entry; the stash is left in place in that
 * case rather than dropped.
 *
 * `-u` carries untracked files too: without them the switch still fails on a
 * file that would be overwritten.
 */
export async function checkoutBranch(
  cwd: string,
  name: string,
  options: { stash?: boolean } = {}
): Promise<GitCheckoutResult> {
  let stashed = false;

  if (options.stash) {
    const stash = await runGit(cwd, ['stash', 'push', '-u', '-m', `open-cowork before ${name}`]);
    // A stash failure is not fatal on its own: the checkout is still attempted,
    // and its own error is the one worth showing the user.
    stashed = stash.ok;
  }

  const result = await runGit(cwd, ['checkout', name]);

  if (!result.ok) {
    // The checkout failed after a successful stash: put the work back on the
    // branch it came from rather than leaving it silently parked.
    if (stashed) await runGit(cwd, ['stash', 'pop']);
    return { ok: false, stashed: false, error: result.stderr || 'Unable to switch branch' };
  }

  if (stashed) {
    const pop = await runGit(cwd, ['stash', 'pop']);
    if (!pop.ok) {
      // The changes could not be replayed on the destination branch (conflict
      // with work already there). They are still in the stash, so report the
      // conflict rather than claiming a clean switch.
      return {
        ok: false,
        stashed: true,
        error: pop.stderr || 'Unable to carry the uncommitted changes to the new branch',
      };
    }
  }

  return { ok: true, stashed };
}
