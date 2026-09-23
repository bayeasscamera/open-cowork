import { describe, expect, it } from 'vitest';
import { emptyGitStatus, parseGitStatusOutput, readGitStatus } from '../src/main/workspace/git-status';
import type { GitRunner } from '../src/main/agent/checkpoint-manager';

const runner = (result: { exitCode: number; stdout?: string; stderr?: string }): GitRunner => ({
  run: async () => ({ exitCode: result.exitCode, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }),
});

describe('parseGitStatusOutput', () => {
  it('parses a branch with an upstream and ahead/behind counts', () => {
    const status = parseGitStatusOutput('## main...origin/main [ahead 1, behind 2]\n');
    expect(status).toMatchObject({
      available: true,
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
      clean: true,
    });
  });

  it('handles a detached HEAD and a branch without upstream', () => {
    expect(parseGitStatusOutput('## HEAD (no branch)').branch).toBeNull();
    const local = parseGitStatusOutput('## feature/x');
    expect(local.branch).toBe('feature/x');
    expect(local.upstream).toBeNull();
  });

  it('handles a repository without commits', () => {
    expect(parseGitStatusOutput('## No commits yet on main').branch).toBe('main');
  });

  it('classifies staged, modified, deleted and untracked files', () => {
    const output = [
      '## main...origin/main',
      'M  src/staged.ts',
      ' M src/modified.ts',
      'MM src/both.ts',
      'D  src/deleted-staged.ts',
      ' D src/deleted-worktree.ts',
      '?? src/new.ts',
    ].join('\n');

    const status = parseGitStatusOutput(output);
    expect(status.clean).toBe(false);
    expect(status.staged).toEqual(['src/staged.ts', 'src/both.ts', 'src/deleted-staged.ts']);
    expect(status.modified).toEqual(['src/modified.ts', 'src/both.ts']);
    expect(status.deleted).toEqual(['src/deleted-staged.ts', 'src/deleted-worktree.ts']);
    expect(status.untracked).toEqual(['src/new.ts']);
    expect(status.changes).toHaveLength(6);
    expect(status.changes[0]).toEqual({
      path: 'src/staged.ts',
      indexStatus: 'M',
      workTreeStatus: ' ',
      staged: true,
    });
  });

  it('keeps the new path of a rename and unquotes escaped paths', () => {
    const status = parseGitStatusOutput('R  old/name.ts -> new/name.ts\n?? "src/with space.ts"');
    expect(status.staged).toEqual(['new/name.ts']);
    expect(status.untracked).toEqual(['src/with space.ts']);
  });

  it('reports a clean tree with no changes', () => {
    expect(parseGitStatusOutput('## main\n')).toMatchObject({ clean: true, changes: [] });
  });
});

describe('readGitStatus', () => {
  it('returns the parsed porcelain output', async () => {
    const status = await readGitStatus(runner({ exitCode: 0, stdout: '## main\n M a.ts\n' }));
    expect(status.available).toBe(true);
    expect(status.modified).toEqual(['a.ts']);
  });

  it('degrades gracefully on a non-zero exit or a throwing runner', async () => {
    const failed = await readGitStatus(runner({ exitCode: 128, stderr: 'not a git repository' }));
    expect(failed.available).toBe(false);
    expect(failed.error).toBe('not a git repository');

    const throwing: GitRunner = {
      run: async () => {
        throw new Error('git missing');
      },
    };
    expect((await readGitStatus(throwing)).error).toBe('git missing');
  });

  it('builds an unavailable summary with emptyGitStatus', () => {
    expect(emptyGitStatus().available).toBe(false);
    expect(emptyGitStatus('boom').error).toBe('boom');
  });
});
