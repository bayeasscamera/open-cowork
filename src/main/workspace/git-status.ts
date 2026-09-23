/**
 * @module main/workspace/git-status
 *
 * Cowork 4.0 — Phase 6: structured `git status` for the control center. The
 * parser is pure so the porcelain format is covered by unit tests.
 */

import type { GitFileChange, GitStatusSummary } from '../../shared/control-center-types';
import type { GitRunner } from '../agent/checkpoint-manager';

export function emptyGitStatus(error?: string): GitStatusSummary {
  const summary: GitStatusSummary = {
    available: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: true,
    staged: [],
    modified: [],
    untracked: [],
    deleted: [],
    changes: [],
  };
  if (error) {
    summary.error = error;
  }
  return summary;
}

function unquotePath(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

export function parseGitStatusOutput(output: string): GitStatusSummary {
  const summary = emptyGitStatus();
  summary.available = true;

  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3).trim();
      const bracket = header.indexOf('[');
      const nameAndUpstream = (bracket >= 0 ? header.slice(0, bracket) : header).trim();
      const counts = bracket >= 0 ? header.slice(bracket) : '';

      const ahead = counts.match(/ahead (\d+)/);
      const behind = counts.match(/behind (\d+)/);
      if (ahead) {
        summary.ahead = Number(ahead[1]);
      }
      if (behind) {
        summary.behind = Number(behind[1]);
      }

      if (nameAndUpstream.includes('(no branch)')) {
        summary.branch = null;
        summary.upstream = null;
        continue;
      }
      const noCommits = nameAndUpstream.match(/^No commits yet on (.+)$/);
      if (noCommits) {
        summary.branch = noCommits[1].trim();
        continue;
      }
      const [branchName, upstreamName] = nameAndUpstream.split('...');
      summary.branch = branchName ? branchName.trim() : null;
      summary.upstream = upstreamName ? upstreamName.trim() : null;
      continue;
    }

    const indexStatus = line[0] ?? ' ';
    const workTreeStatus = line[1] ?? ' ';
    let filePath = unquotePath(line.slice(3));
    const renameArrow = filePath.indexOf(' -> ');
    if (renameArrow >= 0) {
      filePath = unquotePath(filePath.slice(renameArrow + 4).trim());
    }
    if (!filePath) {
      continue;
    }

    const change: GitFileChange = {
      path: filePath,
      indexStatus,
      workTreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
    };
    summary.changes.push(change);

    if (indexStatus === '?' && workTreeStatus === '?') {
      summary.untracked.push(filePath);
      continue;
    }
    if (change.staged) {
      summary.staged.push(filePath);
    }
    if (indexStatus === 'D' || workTreeStatus === 'D') {
      summary.deleted.push(filePath);
    } else if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
      summary.modified.push(filePath);
    }
  }

  summary.clean = summary.changes.length === 0;
  return summary;
}

export async function readGitStatus(git: GitRunner): Promise<GitStatusSummary> {
  try {
    const result = await git.run(['status', '--porcelain=v1', '--branch']);
    if (result.exitCode !== 0) {
      return emptyGitStatus(result.stderr.trim() || 'git status failed');
    }
    return parseGitStatusOutput(result.stdout);
  } catch (error: unknown) {
    return emptyGitStatus(error instanceof Error ? error.message : String(error));
  }
}
