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

import { existsSync, realpathSync } from 'node:fs';

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
  /**
   * The user's home directory. Reads beneath it are refused wholesale rather than
   * path by path - see buildSeatbeltPolicy.
   */
  homeDir?: string;
  /**
   * Runtime files the child must still be able to read after the home directory
   * is closed off: the node installation, and any native binary it spawns
   * (esbuild). Paths inside the home directory are common in development, so
   * these are re-allowed explicitly rather than left to chance.
   */
  readableRuntimePaths?: readonly string[];
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
 * System locations a confined child has no legitimate need to read.
 *
 * Each of these was verified rather than assumed: the child boots, transpiles
 * TypeScript and performs tool calls with all of them denied. Adding a system
 * path here is cheap; removing one needs the same experiment, because a read
 * the child boots without today may become load-bearing tomorrow.
 */
export function systemWideDeniedReadPaths(): readonly string[] {
  // NOTE: /var is deliberately absent. Denying it breaks node itself at startup
  // (before any of our code runs), because the temporary directory and the
  // getcwd resolution live under /var/folders. Verified: every other entry here
  // was denied individually with boot, transpile and tool calls intact; /var was
  // the single exception.
  return [
    '/etc',
    '/tmp',
    '/Library',
    '/Applications',
    '/bin',
    '/sbin',
    '/opt',
    '/private/etc/ssh',
    '/etc/sudoers.d',
    '/Network',
    '/Volumes',
    '/cores',
    '/home',
  ];
}

/**
 * Paths a confined child must not read, relative to a home directory.
 *
 * The home directory itself is now jailed by `buildSeatbeltPolicy` (a deny on the
 * directory, with ordered exceptions), so this list is for the credential
 * locations worth naming explicitly and for everything that lives OUTSIDE the
 * home directory. Both lists are applied; see `sensitiveReadPaths`.
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
  ];
  if (appData) paths.push(appData);
  return paths;
}

export function buildSeatbeltPolicy(request: SandboxRequest): string {
  const execPath = resolvePolicyPath(request.execPath);
  const workspace = resolvePolicyPath(request.workspace);
  const home = request.homeDir ? resolvePolicyPath(request.homeDir) : null;
  const runtimePaths = (request.readableRuntimePaths ?? []).map(resolvePolicyPath);
  const denied = (request.deniedReadPaths ?? []).map(resolvePolicyPath);

  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    '',
    ';; Process capabilities. Only the listed binaries may be exec\'d: the launcher',
    ';; has to exec node to start, and the script must not launch anything else.',
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
    ';; Reads. Metadata is general - existence, permissions and size, not contents.',
    '(allow file-read-metadata)',
    '(allow file-read-xattr)',
    ';; Contents are general too, and then narrowed. See the note on the function:',
    ';; an allow-list cannot boot node on macOS, so the narrowing is by directory.',
    '(allow file-read-data)',
  ];

  if (home) {
    lines.push(
      '',
      ';; Close the home directory. This is the confinement that matters: a',
      ';; credential file nobody thought to list is refused along with the ones',
      ';; somebody did.',
      `(deny file-read-data (subpath ${seatbeltLiteral(home)}))`
    );
  }

  lines.push(
    '',
    ';; Reopen only what the child legitimately needs, AFTER the deny above so the',
    ';; last rule wins.',
    `(allow file-read-data (subpath ${seatbeltLiteral(workspace)}))`
  );
  for (const path of runtimePaths) {
    lines.push(`(allow file-read-data (subpath ${seatbeltLiteral(path)}))`);
  }

  if (denied.length > 0) {
    lines.push(
      '',
      ';; Individually denied locations, which matters for anything OUTSIDE the home',
      ';; directory - the system ssh directory, for instance.'
    );
    // Same operation as the allow, and that is not a stylistic choice. Seatbelt
    // resolves overlapping rules per operation: umbrella `file-read*` does NOT
    // override an allow on the specific `file-read-data` op (verified: the read
    // goes through). A deny has to name the operation it means to block.
    for (const path of denied) {
      lines.push(`(deny file-read-data (subpath ${seatbeltLiteral(path)}))`);
    }
  }

  lines.push(
    '',
    ';; Writes: the workspace only. Verified: a write outside it is refused, and a',
    ';; symlink planted in the workspace does not become a way out.',
    `(allow file-write* (subpath ${seatbeltLiteral(workspace)}))`,
    '',
    ';; NO network rule. Deny default covers it, so the child cannot open a socket',
    ';; at all, including to localhost. Anything it legitimately needs from outside',
    ';; must go through a tools.*() call, which is re-gated in the main process.',
    ''
  );

  return lines.join('\n');
}

/**
 * Build the Linux command line.
 *
 * Every bind source is checked for existence first, and that is not defensive
 * padding - it is a bug found by running this. `bwrap` fails outright with
 * "Can't find source path" on a missing bind, and the paths a Linux distro
 * provides are not fixed: Debian bookworm merged `/lib64` into `/lib`, and
 * Alpine has no `/lib64` at all. A hard-coded `/lib64` made run_code fail
 * entirely on those systems while working on the one it was written against.
 *
 * The predicate is injected so this stays testable without a real filesystem.
 */
export function buildBubblewrapArgs(
  request: SandboxRequest,
  exists: (candidate: string) => boolean = existsSync
): string[] {
  // Same reason as the Seatbelt path: bind what the OS will resolve.
  const workspace = resolvePolicyPath(request.workspace);
  const args: string[] = [
    // No network namespace at all, so there is no interface to bring up.
    '--unshare-net',
    '--die-with-parent',
    '--new-session',
  ];

  // Everything read-only by default. The home directory is deliberately NOT bound:
  // in a mount namespace, not binding it is the whole jail, so a script cannot
  // read ~/.ssh or anything else under it. The runtime paths are bound because
  // they are frequently NOT under /usr - node_modules can be anywhere, and an
  // esbuild the child cannot read means it cannot transpile.
  for (const readOnly of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc']) {
    if (exists(readOnly)) args.push('--ro-bind', readOnly, readOnly);
  }
  for (const runtime of [request.execPath, ...(request.readableRuntimePaths ?? [])].map(
    (candidate) => resolvePolicyPath(candidate)
  )) {
    const parent = runtime.slice(0, Math.max(runtime.lastIndexOf('/'), 1));
    if (parent && exists(parent)) args.push('--ro-bind', parent, parent);
  }
  args.push(
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
    ...request.nodeArgs
  );
  return args;
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
      args: buildBubblewrapArgs(request, existsSync),
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