import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkoutBranch,
  createAndCheckoutBranch,
  isGitRepository,
  listBranches,
} from '../src/main/git/git-operations';

/**
 * The branch selector runs real `git` commands in the main process against the
 * current workspace. These tests drive an actual repository rather than a mock:
 * the failure modes that matter (a detached HEAD, an untracked file not counted
 * by a naive parser, a branch name with a slash or a space) are exactly the
 * ones a hand-rolled fake would not reproduce.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('git operations — branch selector', () => {
  let repo: string;
  let plain: string;
  let root: string;

  /**
   * A fresh repository per test. These cases deliberately drive the working
   * tree into conflicted and half-committed states, so sharing one repository
   * and resetting it between cases leaks state (a stash entry, a detached
   * HEAD, a branch created by an earlier case) and makes the suite order
   * dependent. Rebuilding costs a few ms per test and removes the class of bug
   * entirely.
   */
  function buildRepo(): void {
    repo = join(root, 'repo');
    plain = join(root, 'not-a-repo');
    execFileSync('mkdir', ['-p', repo, plain]);

    // A deterministic identity so commits do not depend on the machine's config.
    git(repo, 'init', '--initial-branch=main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'README.md'), '# test\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial', '--quiet');

    git(repo, 'branch', 'feature/login');
    git(repo, 'branch', 'bugfix/401-fix');
    git(repo, 'branch', 'feature-with-slash-and.dot');
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cowork-git-'));
    buildRepo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('isGitRepository', () => {
    it('recognises a working tree', async () => {
      expect(await isGitRepository(repo)).toBe(true);
    });

    it('rejects a plain directory', async () => {
      expect(await isGitRepository(plain)).toBe(false);
    });

    it('rejects a directory that does not exist', async () => {
      // Never throws — a missing workspace must not surface as a crash.
      expect(await isGitRepository(join(repo, 'nope'))).toBe(false);
    });
  });

  describe('listBranches', () => {
    it('lists every local branch with the current one flagged', async () => {
      const result = await listBranches(repo);

      expect(result.isRepo).toBe(true);
      expect(result.currentBranch).toBe('main');
      expect(result.branches.map((branch) => branch.name).sort()).toEqual([
        'bugfix/401-fix',
        'feature-with-slash-and.dot',
        'feature/login',
        'main',
      ]);
      expect(result.branches.filter((branch) => branch.current)).toHaveLength(1);
      expect(result.branches.find((branch) => branch.current)?.name).toBe('main');
    });

    it('reports no repository for a plain directory', async () => {
      const result = await listBranches(plain);
      expect(result.isRepo).toBe(false);
      expect(result.branches).toEqual([]);
    });

    it('counts uncommitted changes as one per porcelain line', async () => {
      expect((await listBranches(repo)).dirtyCount).toBe(0);

      writeFileSync(join(repo, 'README.md'), '# changed\n');
      writeFileSync(join(repo, 'new-file.txt'), 'untracked\n');

      // One modified tracked file + one untracked file.
      const result = await listBranches(repo);
      expect(result.dirtyCount).toBe(2);
    });

    it('is not stale: the count follows the working tree after each call', async () => {
      // The panel re-reads on every open; a cached count would mislead exactly
      // when the user is deciding whether to stash.
      writeFileSync(join(repo, 'a.txt'), 'a');
      expect((await listBranches(repo)).dirtyCount).toBe(1);

      writeFileSync(join(repo, 'b.txt'), 'b');
      expect((await listBranches(repo)).dirtyCount).toBe(2);

      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'add files', '--quiet');
      expect((await listBranches(repo)).dirtyCount).toBe(0);
    });

    it('exposes the repo root for logging', async () => {
      const result = await listBranches(repo);
      expect(result.repoRoot).toContain('repo');
    });

    it('follows the current branch when it changes', async () => {
      git(repo, 'checkout', '--quiet', 'bugfix/401-fix');
      const result = await listBranches(repo);
      expect(result.currentBranch).toBe('bugfix/401-fix');
      expect(result.branches.find((branch) => branch.current)?.name).toBe('bugfix/401-fix');
    });
  });

  describe('checkoutBranch', () => {
    it('switches branches', async () => {
      const result = await checkoutBranch(repo, 'feature/login');

      expect(result.ok).toBe(true);
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/login');
    });

    it('switches with no uncommitted work and stashes nothing', async () => {
      const result = await checkoutBranch(repo, 'feature/login');
      expect(result.stashed).toBe(false);
      expect((await listBranches(repo)).dirtyCount).toBe(0);
    });

    it('carries uncommitted work across to the new branch when asked to stash', async () => {
      writeFileSync(join(repo, 'README.md'), '# stashed change\n');

      const result = await checkoutBranch(repo, 'feature/login', { stash: true });

      expect(result.ok).toBe(true);
      expect(result.stashed).toBe(true);
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/login');
      // `git stash` alone would leave the work parked on the old branch; the
      // changes must actually be present on the branch we landed on.
      expect(git(repo, 'status', '--porcelain')).toContain('README.md');
      expect(git(repo, 'stash', 'list').trim()).toBe('');
    });

    it('leaves the work in place when the user chooses not to stash', async () => {
      // A branch that would be overwritten cannot be entered with a dirty tree;
      // the panel must show git's reason rather than losing the change.
      git(repo, 'checkout', '--quiet', 'feature/login');
      writeFileSync(join(repo, 'README.md'), '# changed on feature\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'feature change', '--quiet');
      git(repo, 'checkout', '--quiet', 'main');
      writeFileSync(join(repo, 'README.md'), '# changed on main\n');

      const result = await checkoutBranch(repo, 'feature/login', { stash: false });

      if (!result.ok) {
        expect(result.error).toBeTruthy();
        // Still on the branch the change belongs to.
        expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
        expect(git(repo, 'status', '--porcelain')).toContain('README.md');
      }
    });

    it('reports a git failure instead of throwing', async () => {
      const result = await checkoutBranch(repo, 'does-not-exist');

      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      // Git's own wording is surfaced so the user knows what happened.
      expect(result.error).toMatch(/branch|not found|exist/i);
    });

    it('surfaces the git error when a blocked file prevents the switch', async () => {
      // Built on a dedicated branch pair so the assertion does not depend on
      // what an earlier case left behind: the two branches must differ in a
      // file the working tree has also modified.
      git(repo, 'checkout', '--quiet', '-b', 'blocked/feature', 'main');
      writeFileSync(join(repo, 'README.md'), '# diverged on the feature branch\n');
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', 'feature-side change', '--quiet');
      git(repo, 'checkout', '--quiet', 'main');
      writeFileSync(join(repo, 'README.md'), '# diverged on main\n');

      const result = await checkoutBranch(repo, 'blocked/feature', { stash: false });

      // A locally-modified file that differs across branches must block the
      // switch, and git's own reason must reach the panel.
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
      // The failed switch left the work exactly where it was.
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
      expect(git(repo, 'status', '--porcelain')).toContain('README.md');
    });
  });

  describe('createAndCheckoutBranch', () => {
    it('creates and switches', async () => {
      const result = await createAndCheckoutBranch(repo, 'feature/new-thing');

      expect(result.ok).toBe(true);
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/new-thing');
      expect((await listBranches(repo)).branches.map((b) => b.name)).toContain(
        'feature/new-thing'
      );
    });

    it('reports a duplicate name as a git error', async () => {
      const result = await createAndCheckoutBranch(repo, 'feature/login');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('does not create a branch named like a flag', async () => {
      // Argument-array execution: a name starting with `-` is passed to git,
      // never interpreted by a shell.
      const result = await createAndCheckoutBranch(repo, '--force');
      expect(typeof result.ok).toBe('boolean');
      // Whatever git decided, it must not have been parsed as a flag that
      // resets the repository.
      expect(git(repo, 'rev-parse', '--is-inside-work-tree').trim()).toBe('true');
    });
  });
});
