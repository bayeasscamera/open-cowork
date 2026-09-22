#!/usr/bin/env node
/**
 * @module scripts/audit-ci
 *
 * Dependency-audit gate for CI.
 *
 * Some advisories cannot be cleared by upgrading: every published version of the
 * package is inside the vulnerable range. A raw `npm audit` gate would then stay
 * red forever and reviewers would stop reading it. This wrapper:
 *   - FAILS on any high/critical advisory that is not explicitly accepted, and
 *   - PRINTS every accepted advisory with its rationale on each run, so the
 *     accepted risk stays visible in CI logs.
 *
 * Accepted advisories are also tracked in SECURITY.md. To accept a new one,
 * add its GHSA id to ACCEPTED_ADVISORIES with a reason and document it.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Advisories with no upstream fix. Referencing a GHSA id here is a deliberate,
 * reviewed decision — never a way to silence a fixable finding.
 */
export const ACCEPTED_ADVISORIES = new Map([
  [
    'GHSA-jmr9-qjv8-65gv',
    'extract-zip: no fixed release (2.0.1 is latest). Runtime mitigated by ' +
      'patches/extract-zip+2.0.1.patch, which rejects symlink entries escaping the target dir.',
  ],
  [
    'GHSA-7pqw-9j4j-h8q3',
    'extract-zip: same as above — arbitrary write via escaping symlink; patched at runtime.',
  ],
  [
    'GHSA-qr28-p3wr-mxq3',
    'ngrok 5.0.0-beta.2 command injection; fix is a downgrade to 4.3.3. Remote tunnels are ' +
      'opt-in and require a user-supplied auth token. Tracked for downgrade.',
  ],
  [
    'GHSA-jfgx-wxx8-mp94',
    'pi-coding-agent: all published versions <=0.73.1 are vulnerable; no upstream fix yet.',
  ],
  [
    'GHSA-r95r-rj6r-c39x',
    'pi-coding-agent: all published versions <=0.73.1 are vulnerable; no upstream fix yet.',
  ],
  [
    'GHSA-7v5m-pr3q-6453',
    'pi-coding-agent: all published versions <=0.73.1 are vulnerable; no upstream fix yet.',
  ],
]);

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

/** Turn an https://github.com/advisories/GHSA-xxxx URL into its GHSA id. */
export function advisoryIdFromUrl(url) {
  return String(url ?? '').split('/').filter(Boolean).pop() ?? '';
}

/** Flatten an npm audit JSON report into unique advisory records. */
export function collectAdvisories(report) {
  const byId = new Map();
  for (const vuln of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || via === null || !via.url) continue;
      const id = advisoryIdFromUrl(via.url);
      if (!id) continue;
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          severity: via.severity ?? vuln.severity ?? 'unknown',
          title: via.title ?? id,
          url: via.url,
          packages: new Set(),
        });
      }
      if (vuln.name) byId.get(id).packages.add(vuln.name);
    }
  }
  return [...byId.values()].map((a) => ({ ...a, packages: [...a.packages] }));
}

/** Return high/critical advisories that are not in the accepted allowlist. */
export function findBlockingAdvisories(report, accepted = ACCEPTED_ADVISORIES) {
  return collectAdvisories(report).filter(
    (a) => BLOCKING_SEVERITIES.has(a.severity) && !accepted.has(a.id)
  );
}

function runNpmAudit() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['audit', '--json', '--omit=dev'];
  try {
    return execFileSync(npm, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    // npm audit exits non-zero when findings exist; the JSON is still on stdout.
    if (err && typeof err.stdout === 'string' && err.stdout.trim()) return err.stdout;
    throw err;
  }
}

function main() {
  const report = JSON.parse(runNpmAudit());
  const advisories = collectAdvisories(report);
  const accepted = advisories.filter((a) => ACCEPTED_ADVISORIES.has(a.id));
  const blocking = findBlockingAdvisories(report);

  console.log('=== Dependency audit ===');
  if (advisories.length === 0) {
    console.log('No known advisories.');
  }
  for (const a of accepted) {
    console.log(`ACCEPTED [${a.severity}] ${a.id} (${a.packages.join(', ')})`);
    console.log(`         ${ACCEPTED_ADVISORIES.get(a.id)}`);
  }

  if (blocking.length > 0) {
    console.error('\nBlocking advisories (not accepted):');
    for (const a of blocking) {
      console.error(`  [${a.severity}] ${a.id} — ${a.title}`);
      console.error(`  ${a.url} (packages: ${a.packages.join(', ')})`);
    }
    console.error(
      '\nFix these, or add a reviewed entry to ACCEPTED_ADVISORIES in scripts/audit-ci.mjs.'
    );
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: no unaccepted high/critical advisories.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
