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
  const candidates: string[] = [
    // Built output sits beside the main bundle: dist-electron/main -> ../run-code-child
    path.resolve(moduleDir, '..', CHILD_RELATIVE),
    // Dev / tests: src/main/agent -> <repo>/dist-electron/run-code-child
    path.resolve(moduleDir, '..', '..', '..', 'dist-electron', CHILD_RELATIVE),
  ];

  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'app.asar', 'dist-electron', CHILD_RELATIVE));
    candidates.push(path.join(resourcesPath, 'app', 'dist-electron', CHILD_RELATIVE));
  }

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
 * Roots to search for bundled node_modules.
 *
 * `__dirname` is `src/main/agent` in dev and `dist-electron/main` once built, so
 * the project root is two levels up in the first case and one in the second.
 * Both are offered, plus the packaged location, and each candidate is checked
 * for existence rather than assumed.
 */
export function defaultAppRoots(moduleDir: string = __dirname): string[] {
  const roots = [
    // Dev/tests: src/main/agent -> <repo>
    path.resolve(moduleDir, '..', '..', '..'),
    // Built: dist-electron/main -> <repo>
    path.resolve(moduleDir, '..', '..'),
  ];
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, 'app.asar'));
    roots.push(path.join(process.resourcesPath, 'app'));
  }
  return roots;
}
