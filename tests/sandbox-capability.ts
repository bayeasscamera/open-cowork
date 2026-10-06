import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildSeatbeltPolicy, sensitiveReadPaths } from '../src/main/agent/run-code-sandbox';

/**
 * Capability probes for the tests that need OS-level facilities.
 *
 * Several run_code tests do not merely assert a policy string — they run a REAL
 * child under a REAL macOS Seatbelt profile and check what it could and could
 * not do. That is the assertion worth having, and faking it would be worse than
 * not asserting at all.
 *
 * The trap is that the profile can be refused by the host even though
 * `/usr/bin/sandbox-exec` exists. Inside a process that is already sandboxed —
 * a CI runner, an IDE task sandbox — applying a nested profile fails with
 * `sandbox_apply: Operation not permitted`. So the presence of the binary is
 * NOT the capability, and gating on `existsSync` alone turns "the host will not
 * let us sandbox" into a red suite that says nothing about the code.
 *
 * The gate here is therefore a real probe: build the app's own policy and try
 * to apply it. When the host refuses, the dependent tests skip through
 * `skipIf`, so the skip stays visible in the report instead of hiding.
 */

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/**
 * Run one real child under the app's own policy and see whether it boots.
 *
 * The policy is built from the production `buildSeatbeltPolicy`, not a trivial
 * `(allow default)` profile: a permissive profile is exactly the case that
 * still works under a nested sandbox, so it would report a capability the real
 * profile does not have.
 */
function probeSeatbelt(): boolean {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
    return false;
  }

  const workspace = mkdtempSync(join(tmpdir(), 'cowork-sb-probe-'));
  try {
    const home = homedir();
    const policy = buildSeatbeltPolicy({
      platform: 'darwin',
      execPath: process.execPath,
      nodeArgs: ['-e', 'x'],
      workspace,
      deniedReadPaths: sensitiveReadPaths(home),
      homeDir: home,
      readableRuntimePaths: [dirname(process.execPath)],
    });

    const result = spawnSync(
      SANDBOX_EXEC,
      ['-p', policy, process.execPath, '-e', "process.stdout.write('SEATBELT_OK')"],
      { encoding: 'utf8' }
    );
    return `${result.stdout ?? ''}${result.stderr ?? ''}`.includes('SEATBELT_OK');
  } catch {
    // A spawn refusal (EPERM) is also "not usable", not a test error.
    return false;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * True when a real Seatbelt-sandboxed child can run here. Probed once per test
 * file that imports it: the answer is a property of the host, not of the test.
 */
export const seatbeltUsable: boolean = probeSeatbelt();

/**
 * True when the platform can list processes, which is what `listProcesses()`
 * needs. Probed rather than assumed for the same reason: `ps` is present on
 * macOS and Linux but can still be refused by the host, and the production code
 * deliberately returns an empty list in that case instead of throwing.
 */
export const processListingUsable: boolean = (() => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    return false;
  }
  const result = spawnSync('ps', ['-eo', 'pid,comm'], { encoding: 'utf8' });
  return result.status === 0 && (result.stdout ?? '').trim().split('\n').length > 1;
})();

/** The budget `search_codebase` gives its own grep. */
const SEARCH_GREP_BUDGET_MS = 10_000;
/**
 * What the probe demands of a real codebase grep.
 *
 * Derived from the tool's own budget rather than picked: a full-suite run
 * multiplies filesystem cost several-fold, so a grep that already eats a fifth
 * of the budget on an idle host will not finish inside it under load. Reading a
 * few hundred files is milliseconds on an ordinary filesystem and seconds
 * behind a sandbox that mediates every read — measured, not assumed.
 */
const SEARCH_GREP_PROBE_LIMIT_MS = 2_000;

let cachedCodebaseSearch: boolean | undefined;

/**
 * True when a codebase-wide grep finishes comfortably inside the budget the
 * `search_codebase` tool allows its own grep.
 *
 * A test that asserts search RESULTS measures the host rather than the code, so
 * it is gated rather than left to flake.
 *
 * Memoised and lazy: the probe is itself a real grep, so only the file that
 * asks for it pays for it.
 */
export function codebaseSearchUsable(): boolean {
  if (cachedCodebaseSearch !== undefined) {
    return cachedCodebaseSearch;
  }
  if (process.platform === 'win32') {
    cachedCodebaseSearch = false;
    return cachedCodebaseSearch;
  }
  const started = Date.now();
  const result = spawnSync('grep', ['-l', '-r', '-E', 'run_code', 'src/'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: SEARCH_GREP_BUDGET_MS,
  });
  // `error` is set on a timeout or a spawn refusal; `status` is null when the
  // process was killed. Either way the host did not complete a plain grep.
  cachedCodebaseSearch =
    result.error === undefined &&
    result.status !== null &&
    Date.now() - started < SEARCH_GREP_PROBE_LIMIT_MS;
  return cachedCodebaseSearch;
}
