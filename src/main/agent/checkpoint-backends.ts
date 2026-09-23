/**
 * @module main/agent/checkpoint-backends
 *
 * Real filesystem and git implementations of the checkpoint backends. Kept in a
 * separate module so the manager itself stays pure and unit-testable.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { FileSnapshotBackend, GitRunResult, GitRunner } from './checkpoint-manager';

/** Filesystem snapshot backend rooted at the workspace. */
export function createFsSnapshotBackend(workspaceRoot: string): FileSnapshotBackend {
  const resolve = (file: string) => path.resolve(workspaceRoot, file);

  return {
    async capture(paths: string[]): Promise<Map<string, string | null>> {
      const snapshot = new Map<string, string | null>();
      for (const file of paths) {
        snapshot.set(file, await readFileOrNull(resolve(file)));
      }
      return snapshot;
    },
    async restore(snapshot: Map<string, string | null>): Promise<void> {
      for (const [file, content] of snapshot) {
        const absolute = resolve(file);
        if (content === null) {
          await fs.rm(absolute, { force: true });
          continue;
        }
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, content, 'utf8');
      }
    },
    async read(file: string): Promise<string | null> {
      return readFileOrNull(resolve(file));
    },
  };
}

async function readFileOrNull(absolute: string): Promise<string | null> {
  try {
    return await fs.readFile(absolute, 'utf8');
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      return null;
    }
    throw error;
  }
}

/** Git runner that never throws on a non-zero exit code. */
export function createGitRunner(workspaceRoot: string): GitRunner {
  return {
    run(args: string[]): Promise<GitRunResult> {
      return new Promise<GitRunResult>((resolve) => {
        execFile(
          'git',
          args,
          { cwd: workspaceRoot, timeout: 15_000, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const exitCode =
              error && typeof (error as { code?: number }).code === 'number'
                ? ((error as { code?: number }).code as number)
                : error
                  ? 1
                  : 0;
            resolve({ exitCode, stdout: stdout ?? '', stderr: stderr ?? '' });
          }
        );
      });
    },
  };
}
