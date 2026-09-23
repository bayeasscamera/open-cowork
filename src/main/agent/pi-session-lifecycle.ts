/**
 * @module main/agent/pi-session-lifecycle
 *
 * Cached-pi-session lifecycle decisions for a single turn: whether a cached SDK
 * session can still serve the turn given its creation-time signatures, and how
 * to evict it when it cannot (or when a terminal stream error corrupted it).
 *
 * Extracted from CoworkAgentRunner.run() so the reuse/rebuild policy is
 * unit-testable without a runner instance. All log wording — including which
 * eviction reason emits a "changed" line versus an "evicted" line, and whether
 * the dispose error is included — is pinned here and identical to the
 * historical inline blocks.
 */
import { logCtx, logWarn } from '../utils/logger';
import type { CachedPiSession } from './create-pi-session';

/** Infrastructure signatures resolved before the extension hooks run. */
export interface PiSessionInfrastructureSignatures {
  runtimeSignature: string;
  skillsSignature: string;
}

/**
 * Creation-time context contributed by extensions during beforeSessionRun.
 * `refreshSession` retains its historical force-rebuild meaning.
 */
export interface PiSessionContextSignatures {
  refreshSession?: boolean;
  sessionContextSignature?: string;
}

/** Why a cached session must be recreated (or was evicted). */
export type PiSessionEvictionReason =
  | 'runtime'
  | 'skills'
  | 'context'
  | 'stream-error'
  | 'terminal-error';

interface EvictionWording {
  /** Logged before disposing when a signature changed; omitted on error evictions. */
  changed?: string;
  /** Logged when dispose() throws; omitted means the error is swallowed silently. */
  disposeWarning?: string;
  /** Whether the dispose error is appended to `disposeWarning`. */
  withError?: boolean;
  /** Logged after the session leaves the cache on an error eviction. */
  evicted?: string;
}

/** Wording map kept byte-identical to the pre-extraction inline blocks. */
const EVICTION_WORDING: Record<PiSessionEvictionReason, EvictionWording> = {
  runtime: {
    changed: '[CoworkAgentRunner] Runtime changed, recreating cached pi session:',
    disposeWarning: '[CoworkAgentRunner] dispose error while recreating pi session:',
    withError: true,
  },
  skills: {
    changed: '[CoworkAgentRunner] Skills changed, recreating cached pi session:',
    disposeWarning: '[CoworkAgentRunner] dispose error while recreating pi session for skills:',
    withError: true,
  },
  context: {
    changed: '[CoworkAgentRunner] Session context changed, recreating cached pi session:',
    disposeWarning: '[CoworkAgentRunner] Could not dispose memory session cache',
    withError: false,
  },
  'stream-error': {
    evicted: '[CoworkAgentRunner] Evicted corrupted pi session after stream error:',
  },
  'terminal-error': {
    evicted: '[CoworkAgentRunner] Evicted pi session after terminal error (finally):',
  },
};

/**
 * Infrastructure check (runtime wiring first, then skill paths). Returns the
 * first mismatch so the caller evicts once with a single reason, matching the
 * historical check order.
 */
export function resolvePiSessionRecreateReason(
  cachedSession: CachedPiSession,
  current: PiSessionInfrastructureSignatures
): 'runtime' | 'skills' | null {
  if (cachedSession.runtimeSignature !== current.runtimeSignature) return 'runtime';
  if (cachedSession.skillsSignature !== current.skillsSignature) return 'skills';
  return null;
}

/**
 * Creation-time context check: SDK tools and system prompt are built once, so a
 * changed extension context (or the legacy forced-refresh flag) invalidates the
 * cached session. An extension that stops contributing a signature also counts
 * as a change, which is what forces the first disabled turn after an enabled run
 * to rebuild.
 */
export function hasSessionContextChanged(
  cachedSession: CachedPiSession,
  current: PiSessionContextSignatures
): boolean {
  if (current.refreshSession === true) return true;
  return current.sessionContextSignature !== cachedSession.sessionContextSignature;
}

/**
 * Dispose a cached SDK session and drop it from the cache. Never throws: a
 * dispose failure is logged with the wording for `reason` and the entry is
 * still removed. Returns false when no session was cached (nothing logged).
 */
export function evictCachedPiSession(
  sessions: Map<string, CachedPiSession>,
  sessionId: string,
  reason: PiSessionEvictionReason
): boolean {
  const cachedSession = sessions.get(sessionId);
  if (!cachedSession) return false;

  const wording = EVICTION_WORDING[reason];
  if (wording.changed) logCtx(wording.changed, sessionId);

  try {
    cachedSession.session.dispose();
  } catch (error) {
    if (wording.disposeWarning) {
      if (wording.withError) logWarn(wording.disposeWarning, error);
      else logWarn(wording.disposeWarning);
    }
  }

  sessions.delete(sessionId);
  if (wording.evicted) logCtx(wording.evicted, sessionId);
  return true;
}
