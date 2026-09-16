/**
 * @module main/utils/process-tree
 *
 * Best-effort descendant reaping for spawned child processes.
 *
 * Stdio-based servers (MCP npx/bunx wrappers, shell launchers) often fork
 * helper processes that are NOT killed when the direct child exits or when the
 * parent app terminates — they get reparented to launchd/services and linger.
 *
 * Strategy: enumerate the process table while the direct child is still alive
 * (its descendants are still attached to it), close the direct child, then
 * SIGTERM, wait a grace period, SIGKILL the recorded descendant pids.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ProcessEdge {
  pid: number;
  ppid: number;
}

/**
 * Parse the output of "ps -axo pid=,ppid=" into pid-ppid edges.
 * Pure and exported for tests.
 */
export function parseProcessTable(output: string): ProcessEdge[] {
  const edges: ProcessEdge[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/);
    if (match) {
      edges.push({ pid: Number(match[1]), ppid: Number(match[2]) });
    }
  }
  return edges;
}

/**
 * Collect all transitive descendants of rootPid via BFS, returned in reverse
 * order (deepest first) so children die before their parents. Pure; guards
 * against self-parented or cyclic entries.
 */
export function collectDescendantPids(edges: ProcessEdge[], rootPid: number): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const edge of edges) {
    if (edge.pid === edge.ppid) continue;
    const siblings = childrenByParent.get(edge.ppid);
    if (siblings) siblings.push(edge.pid);
    else childrenByParent.set(edge.ppid, [edge.pid]);
  }

  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of childrenByParent.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants.reverse();
}

/** Whether a pid still exists (signal 0 probe). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Transitive descendants of pid, deepest first. Empty on Windows (taskkill walks the tree). */
export async function listDescendantPids(pid: number): Promise<number[]> {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return collectDescendantPids(parseProcessTable(stdout), pid);
  } catch {
    return [];
  }
}

/**
 * Terminate a set of pids: SIGTERM everyone, wait graceMs, SIGKILL
 * survivors. Returns the number of pids that were alive when touched.
 * Never throws — orphan reaping must not break a shutdown path.
 */
export async function reapPids(pids: number[], graceMs = 400): Promise<number> {
  let touched = 0;
  for (const pid of pids) {
    if (!isPidAlive(pid)) continue;
    touched += 1;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone / permission — best effort */
    }
  }
  if (touched === 0) return 0;

  await new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());

  for (const pid of pids) {
    if (!isPidAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* racy exit — best effort */
    }
  }
  return touched;
}

/**
 * Convenience: kill a process and its whole subtree. On Windows, taskkill
 * /T /F walks the tree natively. On POSIX, enumerate descendants first, then
 * SIGTERM the root and reap the recorded children. Never throws.
 */
export async function killProcessTree(pid: number, graceMs = 400): Promise<number> {
  if (!Number.isInteger(pid) || pid <= 0) return 0;

  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 3000 });
      return 1;
    } catch {
      return 0; // already gone / access denied — shutdown stays best-effort
    }
  }

  const descendants = await listDescendantPids(pid);
  const rootAlive = isPidAlive(pid);
  if (rootAlive) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* racy exit */
    }
  }
  const reaped = await reapPids(descendants, graceMs);
  return reaped + (rootAlive ? 1 : 0);
}
