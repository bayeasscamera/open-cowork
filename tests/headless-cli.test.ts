import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The launcher is the artifact users actually run, so it is tested as-is
// (plain ESM, no build step, no dependencies).
import {
  appBundleExecutable,
  defaultCandidatePaths,
  ensureHeadlessFlag,
  executableFromExplicitPath,
  launch,
  parseLauncherArgs,
  planLaunch,
  resolveDevCheckout,
  resolveLaunchTarget,
} from '../bin/open-cowork.mjs';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Fabricate a macOS-style .app bundle with an executable inside. */
function fakeApp(root: string, name = 'Open Cowork.app'): { appPath: string; executable: string } {
  const appPath = join(root, name);
  const executable = join(appPath, 'Contents', 'MacOS', 'Open Cowork');
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  return { appPath, executable };
}

/** Fabricate a development checkout (package.json + built main + electron bin). */
function fakeCheckout(root: string): string {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'open-cowork' }));
  mkdirSync(join(root, 'dist-electron', 'main'), { recursive: true });
  writeFileSync(join(root, 'dist-electron', 'main', 'index.js'), '');
  const binDir = join(root, 'node_modules', '.bin');
  mkdirSync(binDir, { recursive: true });
  const electronBinary = join(binDir, 'electron');
  writeFileSync(electronBinary, '#!/bin/sh\nexit 0\n');
  chmodSync(electronBinary, 0o755);
  return electronBinary;
}

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('open-cowork headless launcher', () => {
  it('is declared as the package bin entry and is executable', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    expect(manifest.bin).toEqual({ 'open-cowork': 'bin/open-cowork.mjs' });
    // The exec bit must survive git: npm and deploy-local.sh symlink this file.
    expect(statSync(join(process.cwd(), 'bin', 'open-cowork.mjs')).mode & 0o111).not.toBe(0);
  });

  it('always starts the app headless, without duplicating the flag', () => {
    expect(ensureHeadlessFlag([])).toEqual(['--headless']);
    expect(ensureHeadlessFlag(['-p', 'hi'])).toEqual(['--headless', '-p', 'hi']);
    expect(ensureHeadlessFlag(['--headless', '-p', 'hi'])).toEqual(['--headless', '-p', 'hi']);
  });

  it('separates launcher flags from app arguments', () => {
    expect(parseLauncherArgs(['--app', '/tmp/x.app', '--mode', 'rpc'])).toEqual({
      appPath: '/tmp/x.app',
      help: false,
      printTarget: false,
      args: ['--mode', 'rpc'],
    });
    expect(parseLauncherArgs(['-h']).help).toBe(true);
    expect(parseLauncherArgs(['--print-target']).printTarget).toBe(true);
    // --cwd belongs to the app and must not be swallowed by the launcher.
    expect(parseLauncherArgs(['--cwd', '/tmp/work']).args).toEqual(['--cwd', '/tmp/work']);
  });

  it('resolves a .app bundle to its MacOS executable', () => {
    const root = tempRoot('cowork-cli-app-');
    const { appPath, executable } = fakeApp(root);
    expect(appBundleExecutable(appPath)).toBe(executable);
    expect(executableFromExplicitPath(appPath, 'darwin')).toBe(executable);
    expect(executableFromExplicitPath(join(root, 'Missing.app'), 'darwin')).toBeNull();
  });

  it('looks in the standard install locations per platform', () => {
    expect(defaultCandidatePaths({ HOME: '/Users/ada' }, 'darwin')).toEqual([
      '/Applications/Open Cowork.app',
      '/Users/ada/Applications/Open Cowork.app',
    ]);
    expect(defaultCandidatePaths({ LOCALAPPDATA: 'C:/Users/ada/AppData/Local' }, 'win32')).toEqual([
      join('C:/Users/ada/AppData/Local', 'Programs', 'Open Cowork', 'Open Cowork.exe'),
    ]);
    expect(defaultCandidatePaths({}, 'linux')).toContain('/opt/open-cowork/open-cowork');
  });

  it('prefers an explicit path, then the default install locations in order', () => {
    const root = tempRoot('cowork-cli-resolve-');
    const home = join(root, 'home');
    const { appPath, executable } = fakeApp(join(home, 'Applications'));

    // A real /Applications install (as on a developer machine) always wins;
    // otherwise the per-user install is picked. Asserting the order instead of
    // a fixed path keeps the test independent of what is installed locally.
    const systemApp = executableFromExplicitPath('/Applications/Open Cowork.app', 'darwin');
    const resolved = resolveLaunchTarget({ env: { HOME: home }, platform: 'darwin', cwd: root });
    expect(resolved?.command).toBe(systemApp || executable);
    expect(resolved?.args).toEqual([]);
    expect(resolved?.description).toBe(systemApp ? '/Applications/Open Cowork.app' : appPath);

    const custom = fakeApp(root, 'Custom.app');
    expect(
      resolveLaunchTarget({
        appPath: custom.appPath,
        env: { HOME: home },
        platform: 'darwin',
        cwd: root,
      })?.command
    ).toBe(custom.executable);

    if (!systemApp) {
      expect(
        resolveLaunchTarget({ env: { HOME: join(root, 'empty') }, platform: 'darwin', cwd: root })
      ).toBeNull();
    }
  });

  it('falls back to the local checkout during development', () => {
    const root = tempRoot('cowork-cli-dev-');
    const electronBinary = fakeCheckout(root);

    expect(resolveDevCheckout(root, 'linux')).toEqual({
      command: electronBinary,
      args: [root],
      description: 'development checkout at ' + root,
    });
    // No installed app on the searched paths -> the checkout is used.
    expect(resolveLaunchTarget({ env: {}, platform: 'linux', cwd: root })?.command).toBe(
      electronBinary
    );

    // A checkout without a build is not a usable target.
    const empty = tempRoot('cowork-cli-empty-');
    expect(resolveDevCheckout(empty, 'linux')).toBeNull();
  });

  it('plans a headless spawn and forwards the remaining arguments', () => {
    const root = tempRoot('cowork-cli-plan-');
    const { appPath, executable } = fakeApp(root);
    const options = { appPath, env: {}, platform: 'darwin', cwd: root };

    expect(planLaunch(['-p', 'hello', '--cwd', '/tmp'], options)).toEqual({
      action: 'spawn',
      command: executable,
      args: ['--headless', '-p', 'hello', '--cwd', '/tmp'],
      description: appPath,
    });
    expect(planLaunch(['--help'], options).action).toBe('help');
    expect(planLaunch(['--print-target'], options).action).toBe('print');
    expect(
      planLaunch([], { env: {}, platform: 'linux', cwd: tempRoot('cowork-cli-none-') }).action
    ).toBe('not-found');
  });

  it('runs the target, forwards the arguments and the exit code', async () => {
    if (process.platform === 'win32') {
      return; // the stub below is a POSIX shell script
    }
    const root = tempRoot('cowork-cli-spawn-');
    const argvFile = join(root, 'argv.txt');
    const stub = join(root, 'stub-open-cowork');
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf "%s\\n" "$@" > ' + JSON.stringify(argvFile) + '\nexit 7\n'
    );
    chmodSync(stub, 0o755);

    const outcome = launch(['-p', 'hello world'], {
      appPath: stub,
      env: {},
      platform: 'darwin',
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(outcome.command).toBe(stub);

    const code = await new Promise<number | null>((resolve) => {
      outcome.child.on('exit', (exitCode) => resolve(exitCode));
    });
    expect(code).toBe(7);
    expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([
      '--headless',
      '-p',
      'hello world',
    ]);
  });

  it('writes usage to stdout and reports a missing app without spawning', () => {
    const helpOut: string[] = [];
    const helpResult = launch(['--help'], {
      io: {
        stdout: { write: (chunk: string) => helpOut.push(chunk) },
        stderr: { write: () => {} },
      },
      env: {},
      platform: 'linux',
      cwd: tempRoot('cowork-cli-help-'),
    });
    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.child).toBeNull();
    expect(helpOut.join('')).toContain('open-cowork - run the Open Cowork agent');

    const errorOut: string[] = [];
    const errorResult = launch([], {
      io: {
        stdout: { write: () => {} },
        stderr: { write: (chunk: string) => errorOut.push(chunk) },
      },
      env: {},
      platform: 'linux',
      cwd: tempRoot('cowork-cli-error-'),
    });
    expect(errorResult.exitCode).toBe(1);
    expect(errorResult.child).toBeNull();
    expect(errorOut.join('')).toContain('Could not find the Open Cowork application');
  });
});
