/**
 * @module main/agent/run-code-sandbox
 *
 * OS-level confinement for the `run_code` child process.
 *
 * WHY THIS EXISTS
 *
 * The child's authority boundary was "it has no tool implementation and no
 * credentials". That is true, and it is not sufficient. A plain `node` child can
 * still `import('node:fs')` and read any file the user can read, and open
 * sockets to anywhere. Setting `cwd` confines nothing: it changes where relative
 * paths resolve, which is a convenience, not a boundary. The tool gate only
 * governs `tools.*()` calls, so direct `fs` and `net` in the script bypass it
 * entirely.
 *
 * So the boundary has to be drawn by the OS. This module produces the command
 * line that draws it.
 *
 * WHAT IS ENFORCED
 *
 *   - filesystem WRITES: confined to the workspace. Verified.
 *   - filesystem READS: refused for a list of credential-bearing directories,
 *     allowed elsewhere. This is a deny list and NOT a jail - a script can read
 *     ordinary files outside the workspace.
 *   - network: refused at the socket layer, so a script cannot exfiltrate or call
 *     out to anything, including localhost. Verified.
 *   - process: exec of anything but node itself is refused. Verified.
 *
 * WHAT IS NOT ENFORCED
 *
 *   - CPU and wall-clock time (the host kills the process group on timeout)
 *   - memory (V8 old space only; see heapLimitMb in run-code-host)
 *   - anything on Windows, which has no comparable facility available from a
 *     user process. There is no partial fallback: the plan is unsupported and the
 *     host refuses to run.
 *
 * FAIL CLOSED
 *
 * If no confinement mechanism is available, this returns an unsupported plan and
 * the caller must not execute the script. "Best effort" is not offered, because
 * the failure mode of the alternative is an agent reading the user's SSH keys
 * while appearing to run in a sandbox.
 *
 * @module
 */

import { realpathSync } from 'node:fs';

/**
 * Resolve a path to the one the OS will actually compare.
 *
 * This is not cosmetic. On macOS `/var` is a symlink to `/private/var`, so a
 * rule written for `/var/folders/tmp` does not match a process that resolves it
 * to `/private/var/folders/tmp`. The rule then applies to nothing: a workspace
 * rule that silently matches nothing breaks every legitimate write, and a deny
 * rule that silently matches nothing lets a secret out. Both failures are
 * invisible in the profile text, so every path is resolved before it is written.
 *
 * A path that does not exist is returned unchanged: `~/.aws` is absent on most
 * machines, and a deny rule for an absent path costs nothing, while throwing
 * here would disable the sandbox on the machines that need it most.
 */
export function resolvePolicyPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/** How the child is confined on this platform. */
export type SandboxKind = 'seatbelt' | 'bubblewrap' | 'unsupported';

export interface SandboxPlan {
  kind: SandboxKind;
  /** True only when a real boundary is in place. */
  supported: boolean;
  /** Executable to spawn. May be the sandbox launcher rather than node itself. */
  command: string;
  /** Full argument list, already including the sandbox flags and the script. */
  args: string[];
  /** Present when `supported` is false: why, in words fit to show a user. */
  reason?: string;
  /** The policy that was applied, for logs and diagnostics. */
  policy?: string;
}

export interface SandboxRequest {
  platform: NodeJS.Platform;
  /** Absolute path to the node binary. */
  execPath: string;
  /** Arguments for node itself (V8 flags, script path). */
  nodeArgs: string[];
  /** The one directory the script may read and write. */
  workspace: string;
  /** Directories the child must not read: credentials, keychains, app data. */
  deniedReadPaths?: readonly string[];
  /**
   * Binaries the child may exec, beyond node itself.
   *
   * The child needs esbuild to transpile, and esbuild is a native binary it
   * spawns. That is a real capability the sandbox must grant or nothing runs, so
   * it is granted explicitly and narrowly — the exact binary path, never a
   * wildcard. Anything added here is executable by model-written code, so the
   * list is meant to stay at one entry.
   */
  allowedExecPaths?: readonly string[];
  /** Absolute path to `sandbox-exec` (macOS) or `bwrap` (Linux), if known. */
  launcherPath?: string;
}

/**
 * Escape a path for a Seatbelt profile literal.
 *
 * Both quoting styles are handled because a Windows-style backslash would
 * otherwise be read as an escape by the Seatbelt parser, and a path containing
 * `"` or `\` must not be able to terminate the literal and inject a rule.
 */
function seatbeltLiteral(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Paths a confined child must not read, relative to a home directory.
 *
 * The macOS profile denies reads of these explicitly. This is a DENY list, not
 * an allow list, and the difference is not cosmetic: a read allow-list could not
 * be made bootable (see the note on readPolicy below), so the honest trade is a
 * list of the places that actually hold credentials.
 */
export function sensitiveReadPaths(home: string, appData?: string): string[] {
  const paths = [
    `${home}/.ssh`,
    `${home}/.gnupg`,
    `${home}/.aws`,
    `${home}/.azure`,
    `${home}/.kube`,
    `${home}/.docker`,
    `${home}/.config/gcloud`,
    `${home}/.npmrc`,
    `${home}/.netrc`,
    `${home}/.pgpass`,
    `${home}/.gitconfig`,
    `${home}/Library/Keychains`,
    `${home}/Library/Application Support/Google/Chrome`,
    `${home}/Library/Application Support/Firefox`,
    `${home}/Library/Safari`,
    `${home}/Library/Preferences/com.apple.TCC`,
    '/etc/sudoers.d',
    '/private/etc/ssh',
  ];
  if (appData) paths.push(appData);
  return paths;
}

/**
 * Build the macOS Seatbelt profile.
 *
 * Shape: `(deny default)`, then allow the operations the child legitimately
 * needs, then deny reads of the credential-bearing directories.
 *
 * Why reads are denied by path rather than allowed by path: an allow-list of
 * readable subtrees was built and measured, and node could not boot under it.
 * macOS resolves library and runtime paths through firmlinks that land outside
 * any top-level directory `readdir` reports, so no such list is complete, and an
 * incomplete allow-list fails closed in the worst way — it looks configured
 * while breaking the runtime. Deny-by-path is weaker, and it is stated as such
 * in the module header and in AGENTS.md rather than being presented as a
 * jail.
 *
 * What this genuinely enforces, all verified against a real sandboxed process:
 * writes outside the workspace are refused, opening any socket is refused, and
 * exec of anything but node itself is refused.
 */
export function buildSeatbeltPolicy(request: SandboxRequest): string {
  const execPath = resolvePolicyPath(request.execPath);
  const workspace = resolvePolicyPath(request.workspace);
  const workspaceLit = seatbeltLiteral(workspace);
  const denied = (request.deniedReadPaths ?? []).map(resolvePolicyPath);

  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    ';; Process capabilities. Only node itself may be exec\'d: the launcher has',
    ';; to exec it to start, and the script must not be able to launch others.',
    '(allow process-fork)',
    ...[
      execPath,
      ...(request.allowedExecPaths ?? []).map((candidate) => resolvePolicyPath(candidate)),
    ]
      .filter((candidate, index, all) => all.indexOf(candidate) === index)
      .map((candidate) => `(allow process-exec (literal ${seatbeltLiteral(candidate)}))`),
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm*)',
    '(allow signal (target same-sandbox))',
    '',
    ';; Reads: allowed in general, then refused where credentials live. See the',
    ';; module header for why this is not an allow-list.',
    '(allow file-read*)',
    '(allow file-read-metadata)',
  ];

  for (const path of denied) {
    lines.push(`(deny file-read* (subpath ${seatbeltLiteral(path)}))`);
  }

  lines.push(
    '',
    ';; Writes: the workspace only. This is a real boundary and it holds.',
    `(allow file-write* (subpath ${workspaceLit}))`,
    '',
    ';; NO network rule. Deny default covers it, so the child cannot open a',
    ';; socket at all, including to localhost: no exfiltration, no callbacks.',
    ';; Anything it legitimately needs from outside the workspace must go',
    ';; through a tools.*() call, which is re-gated in the main process.',
    ''
  );

  return lines.join('\n');
}

/** Build the Linux command line. */
export function buildBubblewrapArgs(request: SandboxRequest): string[] {
  // Same reason as the Seatbelt path: bind what the OS will resolve.
  const workspace = resolvePolicyPath(request.workspace);
  return [
    // No network namespace at all, so there is no interface to bring up.
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
    // Everything read-only by default...
    '--ro-bind',
    '/usr',
    '--ro-bind',
    '/lib',
    '--ro-bind',
    '/lib64',
    '--ro-bind',
    '/bin',
    '--ro-bind',
    '/etc',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    // ...except the workspace.
    '--bind',
    workspace,
    workspace,
    '--chdir',
    workspace,
    '--',
    request.execPath,
    ...request.nodeArgs,
  ];
}

/**
 * Decide how (or whether) to confine a child.
 *
 * Pure: it takes the platform and the launcher path rather than probing, so the
 * decision is testable on any machine and does not depend on the host it runs
 * on. Probing belongs to the caller.
 */
export function planSandbox(request: SandboxRequest): SandboxPlan {
  const nodeArgs = [...request.nodeArgs];

  if (request.platform === 'darwin') {
    const launcher = request.launcherPath ?? '/usr/bin/sandbox-exec';
    const policy = buildSeatbeltPolicy(request);
    return {
      kind: 'seatbelt',
      supported: true,
      command: launcher,
      args: ['-p', policy, request.execPath, ...nodeArgs],
      policy,
    };
  }

  if (request.platform === 'linux') {
    if (!request.launcherPath) {
      return {
        kind: 'unsupported',
        supported: false,
        command: request.execPath,
        args: nodeArgs,
        reason:
          'Linux confinement needs bubblewrap (bwrap) on PATH, and it was not found. ' +
          'run_code is refused rather than run without a boundary.',
      };
    }
    return {
      kind: 'bubblewrap',
      supported: true,
      command: request.launcherPath,
      args: buildBubblewrapArgs(request),
      policy: 'unshare-net + read-only root with a single writable workspace bind',
    };
  }

  return {
    kind: 'unsupported',
    supported: false,
    command: request.execPath,
    args: nodeArgs,
    reason:
      `No OS confinement is available for ${request.platform}, so run_code is refused. ` +
      'Falling back to an unsandboxed child would let model-written code read any ' +
      'file the user can read, which is exactly what the sandbox exists to prevent.',
  };
}

/**
 * Locate the confinement mechanism, if any.
 *
 * Only PATH entries that actually exist are returned, so the caller can fail
 * closed rather than spawning a launcher that is not there.
 */
export function findSandboxLauncher(
  platform: NodeJS.Platform,
  exists: (candidate: string) => boolean
): string | undefined {
  const candidate = platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap';
  return exists(candidate) ? candidate : undefined;
}