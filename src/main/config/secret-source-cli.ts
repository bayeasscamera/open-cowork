/**
 * @module main/config/secret-source-cli
 *
 * CLI adapters for external secret managers (Bitwarden `bw`, 1Password `op`).
 *
 * Both are thin wrappers over `execFile` — never a shell string — so a
 * reference containing spaces, quotes or `$(...)` cannot be interpreted as
 * shell syntax. Every call is bounded by a timeout and resolves to a typed
 * result; a missing CLI is an ordinary outcome, not an exception, so the
 * Settings UI can show "install the CLI" instead of crashing.
 *
 * Neither adapter ever logs the resolved secret.
 */
import { execFile } from 'child_process';
import type {
  SecretResolutionErrorCode,
  SecretResolutionResult,
  SecretSourceProbe,
} from '../../shared/secret-source';
import { isValidOnePasswordReference } from '../../shared/secret-source';
import { logWarn } from '../utils/logger';
import { getCapabilityCache, CAPABILITY_CACHE_TTL_MS } from './capability-cache';

/** Bound every CLI call: a vault waiting on a biometric prompt must not hang boot. */
const CLI_TIMEOUT_MS = 10_000;

/** Vault state reported by `bw status`. Verified against the CLI source. */
type BitwardenVaultStatus = 'unauthenticated' | 'locked' | 'unlocked';

interface CommandOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when the binary itself is missing (ENOENT), vs. a failed command. */
  missingBinary: boolean;
  timedOut: boolean;
}

function runCommand(command: string, args: string[]): Promise<CommandOutcome> {
  return new Promise<CommandOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    try {
      const child = execFile(
        command,
        args,
        {
          timeout: CLI_TIMEOUT_MS,
          // Never inherit a TTY: the CLI must fail fast instead of prompting.
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const err = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
          const missingBinary = Boolean(err && err.code === 'ENOENT');
          const timedOut = Boolean(err && (err.killed || err.code === 'ETIMEDOUT'));
          finish({
            ok: !error,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            missingBinary,
            timedOut,
          });
        }
      );
      child.on('error', () => {
        // execFile surfaces ENOENT through the callback on most platforms, but
        // an error event can win the race — resolve as "missing" either way.
        finish({ ok: false, stdout: '', stderr: '', missingBinary: true, timedOut: false });
      });
    } catch {
      finish({ ok: false, stdout: '', stderr: '', missingBinary: true, timedOut: false });
    }
  });
}

/** First line of stderr, trimmed and length-capped for safe display. */
function firstErrorLine(stderr: string): string {
  const line = (stderr || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Disk-cache key for "is this manager CLI installed (+ version)?". Lock state stays live. */
function cliPresenceCacheKey(command: string): string {
  return `cli-presence:${command}`;
}

/** Shared "is this binary installed?" probe. */
async function probeInstalled(command: string): Promise<SecretSourceProbe> {
  // CLI presence changes only when the user installs/upgrades something, so a
  // 24h disk entry skips the spawn on every Settings open. Lock state is NOT
  // cached — it is re-checked live by the caller on every probe.
  const cached = getCapabilityCache().get<SecretSourceProbe>(
    cliPresenceCacheKey(command),
    CAPABILITY_CACHE_TTL_MS
  );
  if (cached && cached.installed) {
    return { ...cached, unlocked: false, detail: undefined };
  }
  const outcome = await runCommand(command, ['--version']);
  if (outcome.missingBinary) {
    return {
      installed: false,
      unlocked: false,
      detail: `${command} was not found on PATH. Install it to use this secret source.`,
    };
  }
  if (!outcome.ok) {
    // Present but unhappy (e.g. a wrapper that exits non-zero): treat as
    // installed so the UI offers the login flow rather than "install the CLI".
    // Deliberately NOT cached: a broken wrapper may be fixed at any moment.
    return {
      installed: true,
      unlocked: false,
      detail: firstErrorLine(outcome.stderr) || `${command} is installed but did not respond.`,
    };
  }
  const version = outcome.stdout.trim().split(/\r?\n/)[0];
  const probe: SecretSourceProbe = { installed: true, unlocked: false, version };
  getCapabilityCache().set(cliPresenceCacheKey(command), probe);
  return probe;
}

/**
 * Bitwarden adapter.
 *
 *   bw --version                                  → presence
 *   bw status                                     → { status, userEmail }
 *   bw get password <itemIdOrName> --raw         → the secret, stdout only
 *
 * `--raw` keeps the value off any terminal/log surface. `BW_SESSION` is
 * inherited from the environment when the user already unlocked the CLI, so a
 * GUI session that is unlocked elsewhere works without re-prompting.
 */
export class BitwardenSecretSource {
  static readonly kind = 'bitwarden' as const;
  static readonly command = 'bw';

  static async probe(): Promise<SecretSourceProbe> {
    const installed = await probeInstalled(BitwardenSecretSource.command);
    if (!installed.installed) return installed;

    const status = await runCommand(BitwardenSecretSource.command, ['status']);
    if (status.missingBinary) {
      return { installed: false, unlocked: false, detail: 'bw was not found on PATH.' };
    }
    if (!status.ok) {
      return {
        ...installed,
        unlocked: false,
        detail: firstErrorLine(status.stderr) || 'Could not read the Bitwarden vault status.',
      };
    }
    try {
      const parsed = JSON.parse(status.stdout) as { status?: BitwardenVaultStatus };
      const state = parsed.status;
      if (state === 'unlocked') return { ...installed, unlocked: true };
      if (state === 'locked') {
        return {
          ...installed,
          unlocked: false,
          detail: 'The Bitwarden vault is locked. Unlock it with `bw unlock`, then retry.',
        };
      }
      return {
        ...installed,
        unlocked: false,
        detail: 'Bitwarden CLI is not logged in. Run `bw login`, then retry.',
      };
    } catch {
      return {
        ...installed,
        unlocked: false,
        detail: 'Could not parse the output of `bw status`.',
      };
    }
  }

  static async resolve(reference: string): Promise<SecretResolutionResult> {
    const trimmed = reference.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: { code: 'invalid-reference', message: 'The Bitwarden item reference is empty.' },
      };
    }

    const outcome = await runCommand(BitwardenSecretSource.command, [
      'get',
      'password',
      trimmed,
      '--raw',
    ]);

    if (outcome.missingBinary) {
      return {
        ok: false,
        error: {
          code: 'cli-missing',
          message: 'Bitwarden CLI (bw) was not found on PATH. Install it to resolve this key.',
        },
      };
    }
    if (outcome.timedOut) {
      return {
        ok: false,
        error: {
          code: 'timeout',
          message: 'Bitwarden CLI timed out. Unlock the vault and retry.',
        },
      };
    }
    if (!outcome.ok) {
      const detail = firstErrorLine(outcome.stderr);
      const lower = detail.toLowerCase();
      if (lower.includes('locked') || lower.includes('unlock')) {
        return {
          ok: false,
          error: {
            code: 'vault-locked',
            message: 'The Bitwarden vault is locked. Unlock it with `bw unlock`, then retry.',
          },
        };
      }
      if (lower.includes('not found') || lower.includes('no item')) {
        return {
          ok: false,
          error: {
            code: 'not-found',
            message: `No Bitwarden item matched "${trimmed}".`,
          },
        };
      }
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: detail || 'The Bitwarden CLI could not read this item.',
        },
      };
    }

    const value = outcome.stdout.replace(/\r?\n$/, '');
    if (!value) {
      return {
        ok: false,
        error: {
          code: 'not-found',
          message: `The Bitwarden item "${trimmed}" has no password field.`,
        },
      };
    }
    return { ok: true, value };
  }
}

/**
 * 1Password adapter.
 *
 *   op --version                       → presence
 *   op whoami --format json            → signed-in state
 *   op read op://vault/item/field      → the secret
 *
 * `op://` references are parsed and their segments passed as separate argv
 * entries, so a vault or item name containing a space resolves correctly and
 * nothing is ever re-interpreted by a shell.
 */
export class OnePasswordSecretSource {
  static readonly kind = '1password' as const;
  static readonly command = 'op';

  static async probe(): Promise<SecretSourceProbe> {
    const installed = await probeInstalled(OnePasswordSecretSource.command);
    if (!installed.installed) return installed;

    const whoami = await runCommand(OnePasswordSecretSource.command, ['whoami', '--format', 'json']);
    if (whoami.missingBinary) {
      return { installed: false, unlocked: false, detail: 'op was not found on PATH.' };
    }
    if (!whoami.ok) {
      const detail = firstErrorLine(whoami.stderr);
      // 1Password words this several ways depending on version — "you are not
      // currently signed in", "sign in", "signin" — so match the two keywords
      // independently rather than a single brittle phrase.
      const lower = detail.toLowerCase();
      if (lower.includes('signed in') || lower.includes('signin') || lower.includes('sign in')) {
        return {
          ...installed,
          unlocked: false,
          detail: '1Password CLI is not signed in. Run `op signin`, then retry.',
        };
      }
      return {
        ...installed,
        unlocked: false,
        detail: detail || 'Could not read the 1Password account status.',
      };
    }
    return { ...installed, unlocked: true };
  }

  static async resolve(reference: string): Promise<SecretResolutionResult> {
    const trimmed = reference.trim();
    if (!isValidOnePasswordReference(trimmed)) {
      return {
        ok: false,
        error: {
          code: 'invalid-reference',
          message:
            'The 1Password reference must look like op://vault/item/field (at least three segments).',
        },
      };
    }

    const outcome = await runCommand(OnePasswordSecretSource.command, ['read', trimmed]);

    if (outcome.missingBinary) {
      return {
        ok: false,
        error: {
          code: 'cli-missing',
          message: '1Password CLI (op) was not found on PATH. Install it to resolve this key.',
        },
      };
    }
    if (outcome.timedOut) {
      return {
        ok: false,
        error: {
          code: 'timeout',
          message: '1Password CLI timed out. Sign in and retry.',
        },
      };
    }
    if (!outcome.ok) {
      const detail = firstErrorLine(outcome.stderr);
      const lower = detail.toLowerCase();      if (lower.includes('locked') || lower.includes('signed in') || lower.includes('sign in') || lower.includes('signin')) {
        return {
          ok: false,
          error: {
            code: 'vault-locked',
            message: 'The 1Password CLI is locked or not signed in. Run `op signin`, then retry.',
          },
        };
      }
      if (lower.includes('not found') || lower.includes('no item')) {
        return {
          ok: false,
          error: { code: 'not-found', message: `No 1Password item matched "${trimmed}".` },
        };
      }
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: detail || 'The 1Password CLI could not read this secret reference.',
        },
      };
    }

    const value = outcome.stdout.replace(/\r?\n$/, '');
    if (!value) {
      return {
        ok: false,
        error: { code: 'not-found', message: 'The 1Password secret reference resolved to an empty value.' },
      };
    }
    return { ok: true, value };
  }
}

/** Map a CLI failure onto the shared error taxonomy. Exported for tests. */
export function classifyCliFailure(detail: string): SecretResolutionErrorCode {
  const lower = (detail || '').toLowerCase();
  if (lower.includes('not found on path') || lower.includes('enoent')) return 'cli-missing';
  if (lower.includes('locked') || lower.includes('sign in')) return 'vault-locked';
  if (lower.includes('timed out')) return 'timeout';
  if (lower.includes('not found') || lower.includes('no item')) return 'not-found';
  logWarn('[SecretSource] Unclassified CLI failure:', detail);
  return 'unknown';
}
