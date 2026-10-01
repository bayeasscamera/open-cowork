/**
 * @module main/config/secret-resolver
 *
 * Resolves ConfigSet API keys from the configured `SecretSource`.
 *
 * Invariants this module exists to guarantee:
 *
 *  1. An external key is NEVER written to disk by this module. Only the
 *     reference (`op://…`, item id) lives in the encrypted config store; the
 *     resolved value is held in memory for the lifetime of the process and is
 *     only ever pushed into `process.env` by `applyToEnv()`.
 *  2. Resolution never throws. A missing CLI, a locked vault or an unknown
 *     item degrades to a typed error that the UI can explain.
 *  3. Precedence is explicit (see SECRET_SOURCE_PRECEDENCE): when a ConfigSet
 *     declares several sources, the winner is deterministic and the loser is
 *     reported so Settings can warn about the conflict.
 */
import {
  findConflictingSecretSources,
  isValidSecretReference,
  SECRET_SOURCE_PRECEDENCE,
  type SecretResolutionResult,
  type SecretSourceConfig,
  type SecretSourceKind,
  type SecretSourceMap,
  type SecretSourceProbe,
} from '../../shared/secret-source';
import { BitwardenSecretSource, OnePasswordSecretSource } from './secret-source-cli';
import { log, logWarn } from '../utils/logger';

/** Why a stored value was skipped, surfaced in Settings as a warning. */
export interface SecretSourceConflict {
  configSetId: string;
  kinds: SecretSourceKind[];
  winner: SecretSourceKind;
}

type SecretError = Extract<SecretResolutionResult, { ok: false }>['error'];

interface ResolvedEntry {
  value: string;
  resolvedAt: number;
}

export interface ResolveSecretOutcome {
  /** The secret when resolution succeeded, otherwise null. */
  value: string | null;
  /** Typed failure reason; null on success. */
  error: SecretError | null;
  /** True when the key was never an external reference (plain `local` key). */
  fromLocal: boolean;
}

type Resolver = (reference: string) => Promise<SecretResolutionResult>;

/**
 * A short in-memory cache avoids spawning a CLI process on every turn. Keys
 * rotate rarely; a 60s window keeps repeated agent runs off the CLI without
 * risking a long-lived stale key after the user re-locks the vault.
 */
const RESOLVED_TTL_MS = 60_000;

export class SecretResolver {
  /** Cache keyed by `${kind}:${reference}`. Values are never written out. */
  private readonly cache = new Map<string, ResolvedEntry>();

  /** Last failure per cache key, so a failed lookup is not retried in a loop. */
  private readonly failureCache = new Map<string, { error: SecretError; at: number }>();

  private resolverFor(kind: SecretSourceKind): Resolver | null {
    switch (kind) {
      case 'bitwarden':
        return (reference) => BitwardenSecretSource.resolve(reference);
      case '1password':
        return (reference) => OnePasswordSecretSource.resolve(reference);
      default:
        return null;
    }
  }

  /** Probe an external manager for presence + lock state, for the Settings UI. */
  async probe(kind: SecretSourceKind): Promise<SecretSourceProbe> {
    switch (kind) {
      case 'bitwarden':
        return BitwardenSecretSource.probe();
      case '1password':
        return OnePasswordSecretSource.probe();
      default:
        return { installed: false, unlocked: false, detail: 'The local source needs no CLI.' };
    }
  }

  /**
   * Resolve the key for a ConfigSet.
   *
   * `localApiKey` is what the encrypted store already holds — returned
   * unchanged when no external source is configured, which keeps the default
   * path byte-for-byte identical to the pre-feature behavior.
   */
  async resolveForConfigSet(
    configSetId: string,
    sources: SecretSourceMap | undefined,
    localApiKey: string
  ): Promise<ResolveSecretOutcome> {
    const configured = sources?.[configSetId];
    if (!configured || configured.kind === 'local') {
      return { value: localApiKey, error: null, fromLocal: true };
    }

    const reference = configured.reference.trim();
    if (!reference) {
      logWarn('[SecretResolver] External source configured with an empty reference:', {
        configSetId,
        kind: configured.kind,
      });
      return {
        value: null,
        error: {
          code: 'invalid-reference',
          message: `The ${configured.kind} reference for this config set is empty.`,
        },
        fromLocal: false,
      };
    }

    if (!isValidSecretReference(configured.kind, reference)) {
      return {
        value: null,
        error: {
          code: 'invalid-reference',
          message: `The ${configured.kind} reference is not a valid secret reference.`,
        },
        fromLocal: false,
      };
    }

    // A reference that another kind owns (e.g. an op:// URI filed under
    // bitwarden) is a configuration mistake, not a vault problem — say so.
    const resolved = await this.resolveOne(configured);
    if (!resolved.ok && resolved.error.code === 'not-found') {
      logWarn('[SecretResolver] External secret did not resolve:', {
        configSetId,
        kind: configured.kind,
        code: resolved.error.code,
      });
    }
    return {
      value: resolved.ok ? resolved.value : null,
      error: resolved.ok ? null : resolved.error,
      fromLocal: false,
    };
  }

  /** Resolve one specific source, honoring the short-lived caches. */
  private async resolveOne(config: SecretSourceConfig): Promise<SecretResolutionResult> {
    const cacheKey = `${config.kind}:${config.reference.trim()}`;
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && now - cached.resolvedAt < RESOLVED_TTL_MS) {
      return { ok: true, value: cached.value };
    }

    const failed = this.failureCache.get(cacheKey);
    if (failed && now - failed.at < RESOLVED_TTL_MS) {
      return { ok: false, error: failed.error };
    }

    const resolver = this.resolverFor(config.kind);
    if (!resolver) {
      const error = {
        code: 'unknown' as const,
        message: `Unsupported secret source "${config.kind}".`,
      };
      this.failureCache.set(cacheKey, { error, at: now });
      return { ok: false, error };
    }

    try {
      const result = await resolver(config.reference.trim());
      if (result.ok) {
        this.cache.set(cacheKey, { value: result.value, resolvedAt: now });
        this.failureCache.delete(cacheKey);
      } else {
        this.failureCache.set(cacheKey, { error: result.error, at: now });
        this.cache.delete(cacheKey);
      }
      return result;
    } catch (error) {
      // A resolver must never propagate, but if one ever does, degrade cleanly.
      const message = error instanceof Error ? error.message : String(error);
      log('[SecretResolver] Resolver threw, degrading to a typed error:', message);
      const typed = {
        code: 'unknown' as const,
        message: `Could not read the secret from ${config.kind}: ${message}`,
      };
      this.failureCache.set(cacheKey, { error: typed, at: now });
      return { ok: false, error: typed };
    }
  }

  /** Report ConfigSets that declare the same key through several sources. */
  findConflicts(sources: SecretSourceMap | undefined): SecretSourceConflict[] {
    return findConflictingSecretSources(sources);
  }

  /** Clear cached values — called when the user signs a vault out or switches. */
  invalidate(): void {
    this.cache.clear();
    this.failureCache.clear();
  }
}

/** Process-wide resolver; the caches are the reason it is a singleton. */
let sharedSecretResolver: SecretResolver | null = null;

export function getSecretResolver(): SecretResolver {
  if (!sharedSecretResolver) {
    sharedSecretResolver = new SecretResolver();
  }
  return sharedSecretResolver;
}

/** Exposed for tests that need a pristine cache. */
export function resetSecretResolver(): void {
  sharedSecretResolver = null;
}

/** The precedence order, re-exported so Settings renders it in the same order. */
export { SECRET_SOURCE_PRECEDENCE };

/**
 * Race a promise against a wall-clock budget. On expiry the slow work is NOT
 * cancelled (a CLI call finishes on its own timeout) — the caller just stops
 * waiting for it. Used at boot so a locked vault cannot hold the window back.
 */
export function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) return work.then((value) => value);
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, budgetMs);
    if (typeof timer.unref === 'function') timer.unref();
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    );
  });
}
