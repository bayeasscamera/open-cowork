#!/usr/bin/env node
/**
 * open-cowork - headless CLI launcher for Open Cowork.
 *
 * The agent runtime needs the real Electron binary: better-sqlite3 is built
 * for Electron's ABI, and the core calls app.getPath() for userData. This
 * launcher therefore does not reimplement the agent - it locates the installed
 * app (or the local checkout during development) and starts it with
 * `--headless`, forwarding stdio so JSONL events and piped stdin work.
 *
 * Zero dependencies on purpose: it must run before node_modules exists and on
 * a machine where only the .app is installed.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEADLESS_FLAG = '--headless';
export const APP_BUNDLE_NAME = 'Open Cowork.app';
export const APP_BINARY_NAME = 'Open Cowork';
export const APP_PACKAGE_NAME = 'open-cowork';

const USAGE = [
  'open-cowork - run the Open Cowork agent without the GUI',
  '',
  'Usage:',
  '  open-cowork -p "<prompt>" [--cwd <dir>] [--auto-approve]',
  '  open-cowork --mode rpc',
  '  echo "<prompt>" | open-cowork',
  '',
  'Every argument that is not handled by the launcher is forwarded to the app,',
  'which always receives ' + HEADLESS_FLAG + '.',
  '',
  'Launcher options:',
  '  --app <path>     Use this app bundle or executable instead of auto-detecting',
  '  --print-target   Show what would be started, then exit',
  '  -h, --help       Show this help',
  '',
  'App options:',
  '  -p, --prompt <text>      Run one prompt, then exit',
  '  --cwd <dir>              Working directory (default: current directory)',
  '  --auto-approve           Approve every tool call without confirmation',
  '  --mode json|rpc|stdio    Output and transport mode',
  '',
  'Environment:',
  '  OPEN_COWORK_APP      Same as --app',
  '  OPEN_COWORK_VERBOSE  Print the resolved target to stderr',
].join('\n');

function isExecutableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Path of the executable inside a macOS .app bundle. */
export function appBundleExecutable(appPath) {
  return join(appPath, 'Contents', 'MacOS', APP_BINARY_NAME);
}

/** Resolve an explicit path (--app or OPEN_COWORK_APP) to a runnable file. */
export function executableFromExplicitPath(candidate, platform = process.platform) {
  if (!candidate) return null;
  if (platform === 'darwin' || candidate.endsWith('.app')) {
    const inside = appBundleExecutable(candidate);
    if (isExecutableFile(inside)) return inside;
  }
  return isExecutableFile(candidate) ? candidate : null;
}

/** Default install locations for the current platform, in priority order. */
export function defaultCandidatePaths(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    const paths = ['/Applications/' + APP_BUNDLE_NAME];
    if (env.HOME) paths.push(join(env.HOME, 'Applications', APP_BUNDLE_NAME));
    return paths;
  }
  if (platform === 'win32') {
    const exe = APP_BINARY_NAME + '.exe';
    const paths = [];
    if (env.LOCALAPPDATA) paths.push(join(env.LOCALAPPDATA, 'Programs', 'Open Cowork', exe));
    if (env.ProgramFiles) paths.push(join(env.ProgramFiles, 'Open Cowork', exe));
    if (env['ProgramFiles(x86)']) paths.push(join(env['ProgramFiles(x86)'], 'Open Cowork', exe));
    return paths;
  }
  return [
    '/opt/' + APP_PACKAGE_NAME + '/' + APP_PACKAGE_NAME,
    '/usr/lib/' + APP_PACKAGE_NAME + '/' + APP_PACKAGE_NAME,
  ];
}

/**
 * Development fallback: run the checkout through its own Electron binary. This
 * is the same code path the packaged app uses, so behaviour does not diverge.
 */
export function resolveDevCheckout(cwd, platform = process.platform) {
  try {
    const packagePath = join(cwd, 'package.json');
    if (!existsSync(packagePath)) return null;
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (manifest.name !== APP_PACKAGE_NAME) return null;
    if (!existsSync(join(cwd, 'dist-electron', 'main', 'index.js'))) return null;
    const electronBinary = join(
      cwd,
      'node_modules',
      '.bin',
      platform === 'win32' ? 'electron.cmd' : 'electron'
    );
    if (!existsSync(electronBinary)) return null;
    return { command: electronBinary, args: [cwd], description: 'development checkout at ' + cwd };
  } catch {
    return null;
  }
}

export function resolveLaunchTarget(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const cwd = options.cwd || process.cwd();

  const explicit = options.appPath || env.OPEN_COWORK_APP;
  if (explicit) {
    const executable = executableFromExplicitPath(explicit, platform);
    if (!executable) return null;
    return { command: executable, args: [], description: explicit };
  }

  for (const candidate of defaultCandidatePaths(env, platform)) {
    const executable = executableFromExplicitPath(candidate, platform);
    if (executable) return { command: executable, args: [], description: candidate };
  }

  return resolveDevCheckout(cwd, platform);
}

/** The launcher's whole job: the app is always started headless. */
export function ensureHeadlessFlag(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  if (!args.includes(HEADLESS_FLAG)) args.unshift(HEADLESS_FLAG);
  return args;
}

/** Split launcher-owned flags from the arguments destined to the app. */
export function parseLauncherArgs(argv) {
  const args = [];
  let appPath = null;
  let help = false;
  let printTarget = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app' && index + 1 < argv.length) {
      appPath = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--print-target') {
      printTarget = true;
    } else {
      args.push(arg);
    }
  }

  return { appPath, help, printTarget, args };
}

export function notFoundMessage(
  env = process.env,
  platform = process.platform,
  cwd = process.cwd()
) {
  const lines = ['[open-cowork] Could not find the Open Cowork application.', '', 'Looked for:'];
  for (const candidate of defaultCandidatePaths(env, platform)) lines.push('  - ' + candidate);
  lines.push('  - a development checkout in ' + cwd);
  lines.push('');
  lines.push('Point the launcher at your installation:');
  lines.push('  open-cowork --app "/Applications/' + APP_BUNDLE_NAME + '" ...');
  lines.push('  OPEN_COWORK_APP="/Applications/' + APP_BUNDLE_NAME + '" open-cowork ...');
  return lines.join('\n');
}

/**
 * Decide what to do without spawning anything (pure, so it is testable).
 * Returns one of: help | not-found | print | spawn.
 */
export function planLaunch(argv, options = {}) {
  const parsed = parseLauncherArgs(argv);
  if (parsed.help) return { action: 'help' };

  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const cwd = options.cwd || process.cwd();

  // options.appPath is the programmatic equivalent of --app (used by tests and
  // by callers embedding the launcher); the CLI flag always wins.
  const target = resolveLaunchTarget({
    appPath: parsed.appPath || options.appPath,
    env,
    platform,
    cwd,
  });
  if (!target) return { action: 'not-found' };

  const args = target.args.concat(ensureHeadlessFlag(parsed.args));
  const identity = { command: target.command, args, description: target.description };
  return parsed.printTarget ? { action: 'print', ...identity } : { action: 'spawn', ...identity };
}

/** Plan and act. Returns { exitCode, child, command, args }. */
export function launch(argv, options = {}) {
  const io = options.io || process;
  const plan = planLaunch(argv, options);

  if (plan.action === 'help') {
    io.stdout.write(USAGE + '\n');
    return { exitCode: 0, child: null, command: null, args: [] };
  }

  if (plan.action === 'not-found') {
    io.stderr.write(
      notFoundMessage(
        options.env || process.env,
        options.platform || process.platform,
        options.cwd || process.cwd()
      ) + '\n'
    );
    return { exitCode: 1, child: null, command: null, args: [] };
  }

  if (plan.action === 'print') {
    io.stdout.write(plan.command + '\n');
    return { exitCode: 0, child: null, command: plan.command, args: plan.args };
  }

  if ((options.env || process.env).OPEN_COWORK_VERBOSE) {
    io.stderr.write('[open-cowork] starting ' + plan.description + ' (' + plan.command + ')\n');
  }

  const spawnFn = options.spawn || spawn;
  const child = spawnFn(plan.command, plan.args, {
    stdio: options.stdio || 'inherit',
    env: options.env || process.env,
  });
  return { exitCode: null, child, command: plan.command, args: plan.args };
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const outcome = launch(process.argv.slice(2));
  if (outcome.exitCode !== null) {
    process.exit(outcome.exitCode);
  }

  const child = outcome.child;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    });
  }
  child.on('error', (error) => {
    process.stderr.write(
      '[open-cowork] failed to start ' + outcome.command + ': ' + error.message + '\n'
    );
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}
