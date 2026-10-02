/**
 * @module main/agent/run-code-runtime
 *
 * Locates the `run_code` child runtime and the binary it needs to transpile.
 *
 * Why this is separate from the host: the host decides POLICY (limits, gate,
 * sandbox), and this module answers "where is the file". Mixing them makes the
 * policy untestable without a real filesystem layout, and makes it easy to
 * quietly fall back to "no child configured" in a packaged build.
 *
 * The child is built as its OWN bundle (`dist-electron/run-code-child/`), never
 * as part of the main bundle. That is a security requirement, not a packaging
 * preference: the child contains the only `new Function` in the codebase, and
 * tests/eval-isolation.test.ts asserts it is unreachable from the main entry
 * graph. Bundling it into main would put an eval path back into the main process.
 *
 * @module
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where the built child lives, relative to a given root. */
const CHILD_RELATIVE = path.join('run-code-child', 'index.js');

/**
 * Resolve the compiled child entry.
 *
 * Returns null when it is not there. The caller must treat that as "refuse",
 * never as "run node without a child": an absent child is a build problem, and
 * silently degrading to an unsandboxed or in-process path would be the worst
 * possible response to it.
 *
 * Several roots are tried because this module is loaded from two different
 * places: `src/main/agent` in dev and tests, and `dist-electron/main` once built.
 * A single root computed from `__dirname` gets one of the two wrong, and the
 * failure is silent because the feature is not reachable yet.
 */
export function resolveRunCodeChildScript(
  moduleDir: string = __dirname,
  resourcesPath: string | null = process.resourcesPath ?? null
): string | null {
  // Packaged FIRST, because in a real build it is the only candidate that can
  // work: the child is an extraResource, deliberately outside the asar, since a
  // plain `node` process cannot read an asar archive.
  const candidates: string[] = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, CHILD_RELATIVE));
  }
  candidates.push(
    // Built output sits beside the main bundle: dist-electron/main -> ../run-code-child
    path.resolve(moduleDir, '..', CHILD_RELATIVE),
    // Dev / tests: src/main/agent -> <repo>/dist-electron/run-code-child
    path.resolve(moduleDir, '..', '..', '..', 'dist-electron', CHILD_RELATIVE),
    // Older/asar-packaged layouts, kept so an existing build still resolves.
    ...(resourcesPath
      ? [
          path.join(resourcesPath, 'app.asar', 'dist-electron', CHILD_RELATIVE),
          path.join(resourcesPath, 'app', 'dist-electron', CHILD_RELATIVE),
        ]
      : [])
  );

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // A permission error on one candidate is not a reason to give up on the
      // others.
    }
  }
  return null;
}

/**
 * Resolve the esbuild platform binary the child spawns to transpile.
 *
 * The child must be able to exec this exact path, so it is passed to the sandbox
 * explicitly. Granting it is unavoidable: without transpilation nothing runs.
 * That is why the sandbox allows exactly this one binary and no wildcard.
 *
 * Returns null when it cannot be found, in which case the caller should surface
 * the problem rather than widen the exec grant.
 */
export function resolveEsbuildBinary(
  appRoots: readonly string[] = defaultAppRoots()
): string | null {
  const platform =
    process.platform === 'win32' ? 'win32' : `${process.platform}-${process.arch}`;
  const binaryName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  for (const root of appRoots) {
    const candidate = path.join(
      root,
      'node_modules',
      '@esbuild',
      platform,
      'bin',
      binaryName
    );
    try {
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * The directories the child must be able to READ to run esbuild at all.
 *
 * Both, and the second one is easy to forget: `resolveEsbuildBinary()` returns
 * the native executable, but the child also does `import('esbuild')`, which reads
 * the JavaScript package next to it. Allowing only the binary's directory leaves
 * the module unresolvable and every script fails to compile — with the home
 * directory jailed, nothing else exposes it.
 */
export function resolveEsbuildRuntimeDirs(appRoots: readonly string[] = defaultAppRoots()): string[] {
  const dirs: string[] = [];
  for (const root of appRoots) {
    const binary = path.join(root, 'node_modules', '@esbuild');
    const pkg = path.join(root, 'node_modules', 'esbuild');
    for (const candidate of [binary, pkg]) {
      try {
        if (fs.existsSync(candidate)) dirs.push(fs.realpathSync(candidate));
      } catch {
        // Keep looking.
      }
    }
  }
  return [...new Set(dirs)];
}

/**
 * The esbuild entry file the child imports.
 *
 * A bare `import('esbuild')` is unusable under the sandbox: resolution climbs
 * past unreadable directories and dies with EPERM. The absolute path keeps the
 * scope lookup inside the explicitly reopened package directory.
 */
export function resolveEsbuildMain(
  appRoots: readonly string[] = defaultAppRoots()
): string | null {
  for (const root of appRoots) {
    const candidate = path.join(root, 'node_modules', 'esbuild', 'lib', 'main.js');
    try {
      if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/**
 * Roots to search for bundled node_modules.
 *
 * `__dirname` is `src/main/agent` in dev and `dist-electron/main` once built, so
 * the project root is two levels up in the first case and one in the second.
 * Both are offered, plus the packaged location, and each candidate is checked
 * for existence rather than assumed.
 */
export function defaultAppRoots(
  moduleDir: string = __dirname,
  resourcesPath: string | null = process.resourcesPath ?? null
): string[] {
  // Packaged roots come first whenever a resources path is supplied. A packaged
  // app must run the binary it shipped, not whatever happens to exist next to
  // the source tree - otherwise the precedence depends on the machine, and the
  // sandbox grants exec of whichever one won.
  const roots: string[] = [];
  if (resourcesPath) {
    // app.asar.unpacked first: esbuild is an unpacked native binary, and an exec
    // target inside an archive is unreachable.
    roots.push(path.join(resourcesPath, 'app.asar.unpacked'));
    roots.push(path.join(resourcesPath, 'app.asar'));
    roots.push(path.join(resourcesPath, 'app'));
  }
  roots.push(
    // Dev/tests: src/main/agent -> <repo>
    path.resolve(moduleDir, '..', '..', '..'),
    // Built output: dist-electron/main -> <repo>
    path.resolve(moduleDir, '..', '..')
  );
  return roots;
}
