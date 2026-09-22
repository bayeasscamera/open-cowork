/**
 * Shared helpers for the WSL/Lima sandbox synchronization layers.
 *
 * Both SandboxSync and LimaSync copy a host workspace into an isolated
 * in-VM directory using the same rsync invocation, the same exclusion
 * list and the same POSIX single-quote escaping, and both guard the
 * destructive cleanup with the same realpath containment check. Only the
 * transport (wsl vs limactl) and the host path space differ, so those
 * pieces live here once.
 */

/** Validate sessionId to prevent command injection via path traversal. */
export function validateSessionId(sessionId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
}

/** Directories/files to exclude from sync (to improve performance). */
export const SYNC_EXCLUDES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '*.pyc',
  '.next',
  '.cache',
  'coverage',
  '.nyc_output',
  'venv',
  '.venv',
  'env',
  '.env.local',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * Escape a filesystem path for safe interpolation into a POSIX single-quoted
 * shell string. Single quotes in the path are replaced with the sequence
 * '\'' (end quote, literal single-quote, reopen quote), the standard POSIX
 * technique. The returned value does NOT include the surrounding delimiters.
 */
export function shellEscapePath(p: string): string {
  return p.replace(/'/g, "'\\''");
}

/** Mirror a directory tree into the VM sandbox (or back out of it). */
export function buildRsyncCommand(sourceDir: string, destinationDir: string): string {
  const excludeArgs = SYNC_EXCLUDES.map((entry) => `--exclude="${entry}"`).join(' ');
  return `rsync -av --delete ${excludeArgs} '${shellEscapePath(sourceDir)}/' '${shellEscapePath(destinationDir)}/'`;
}

/** Copy a single file inside the VM. */
export function buildCopyCommand(sourcePath: string, destinationPath: string): string {
  return `cp '${shellEscapePath(sourcePath)}' '${shellEscapePath(destinationPath)}'`;
}

/** The sandbox root that contains a session sandbox directory. */
export function sandboxRootOf(sandboxPath: string): string {
  return sandboxPath.substring(0, sandboxPath.lastIndexOf('/'));
}

/**
 * Confirm that the realpath of a sandbox directory is still contained in the
 * sandbox root derived from its logical path, so `rm -rf` cannot follow a
 * symlink out of the sandbox.
 */
export function isRealPathWithinSandboxRoot(realPath: string, sandboxPath: string): boolean {
  return realPath.startsWith(sandboxRootOf(sandboxPath) + '/');
}
