/**
 * Bounded storage for the trace log.
 *
 * Two problems, both growing without limit:
 *
 *  1. A tool can return anything — a whole file, a build log, the output of a
 *     grep over a monorepo — and `trace_steps.tool_output` / `content` /
 *     `tool_input` stored it verbatim. One `Bash` on a large repo could add
 *     megabytes to a single row, and the row is kept forever because the only
 *     path that ever deleted a session was the user clicking delete.
 *
 *  2. Sessions were never expired. Messages and trace steps cascade from
 *     `sessions`, so a year of casual use accumulated every conversation, every
 *     tool output and every thought in cowork.db with no upper bound.
 *
 * The two fixes are independent and both are enforced at the storage layer
 * rather than at the call sites: a bound applied "somewhere upstream" is
 * undone by the next call site that forgets it, and the same is true of a purge
 * that only the settings screen can trigger.
 *
 * Everything here is a pure function over plain rows so the policy can be
 * tested without a database; `applyRetention` is the only part that writes.
 */

import { log, logWarn } from '../utils/logger';

/** Marker appended to a value this module shortened, so nothing looks intact. */
export const TRUNCATION_MARKER = '… [truncated]';

/** Per-field ceilings for the text a single trace step may store. */
export const TRACE_TEXT_LIMITS = {
  /** Tool stdout/stderr. The common case is a short line; the ceiling is for a log. */
  toolOutput: 8_000,
  /** Thinking / text step bodies. */
  content: 8_000,
  /** Serialized tool arguments — a `Write` carries a whole file here. */
  toolInput: 4_000,
} as const;

export interface TraceTextLimits {
  toolOutput: number;
  content: number;
  toolInput: number;
}

/**
 * Shorten a value to `limit` characters, keeping the head (where the tool name,
 * the command and the first error live) and saying so.
 *
 * A limit of 0 or less disables truncation, so a caller can opt out entirely
 * rather than pass a sentinel length.
 */
export function truncateTraceText(
  value: string | null | undefined,
  limit: number,
  marker: string = TRUNCATION_MARKER
): string | null {
  if (value === null || value === undefined) return null;
  if (limit <= 0) return value;
  if (value.length <= limit) return value;
  // A limit too small to fit the marker cannot carry it, so the head is cut to
  // the limit itself. The limit is a storage bound, not a hint.
  if (limit <= marker.length) return value.slice(0, limit);
  return value.slice(0, limit - marker.length) + marker;
}

/** Truncate every text field of a trace step row before it is written. */
export function boundTraceStepRow<
  T extends {
    content?: string | null;
    tool_output?: string | null;
    tool_input?: string | null;
  },
>(row: T, limits: TraceTextLimits = TRACE_TEXT_LIMITS): T {
  return {
    ...row,
    ...(row.content !== undefined ? { content: truncateTraceText(row.content, limits.content) } : {}),
    ...(row.tool_output !== undefined
      ? { tool_output: truncateTraceText(row.tool_output, limits.toolOutput) }
      : {}),
    ...(row.tool_input !== undefined
      ? { tool_input: truncateTraceText(row.tool_input, limits.toolInput) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Session expiry
// ---------------------------------------------------------------------------

/** The subset of a session row the expiry policy needs. */
export interface ExpirableSession {
  id: string;
  updatedAt: number;
  status: string;
  isPinned: boolean;
}

export interface RetentionPolicy {
  /** Sessions untouched for longer than this are expired. 0 disables. */
  maxAgeMs: number;
  /** Never expire below this many sessions, however old they are. */
  minSessionsKept: number;
  /** Hard ceiling on session count: the oldest beyond this are expired. */
  maxSessions: number;
  /** Session ids that must survive regardless of age or count. */
  protectedSessionIds: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  maxAgeMs: 180 * DAY_MS,
  minSessionsKept: 50,
  maxSessions: 500,
  protectedSessionIds: [],
};

/** Why a session was selected for expiry — recorded so a purge can be explained. */
export type ExpiryReason = 'age' | 'count';

export interface ExpiryPlan {
  /** Session ids to delete, in the order they should be reported. */
  sessionIds: string[];
  reasons: Map<string, ExpiryReason>;
  /** Sessions deliberately kept despite matching a rule, with the rule. */
  kept: Array<{ sessionId: string; reason: 'pinned' | 'running' | 'protected' | 'floor' }>;
}

/**
 * Decide which sessions to expire, without touching the database.
 *
 * The rules are ordered from strongest to weakest so the reason reported for a
 * session is the one that actually saved it:
 *
 *   1. pinned / running / protected — never deleted. A running session holds
 *      an AbortController and an SDK session; deleting its rows mid-run would
 *      leave the loop writing into nothing.
 *   2. the `minSessionsKept` most recent — a user with 20 sessions must never
 *      come back to an empty list because the clock moved.
 *   3. age, then count.
 */
export function planSessionExpiry(
  sessions: readonly ExpirableSession[],
  policy: RetentionPolicy,
  now: number
): ExpiryPlan {
  const reasons = new Map<string, ExpiryReason>();
  const kept: ExpiryPlan['kept'] = [];
  const protectedIds = new Set(policy.protectedSessionIds);

  // Newest first: the floor and the count rule both work from this order.
  const byRecency = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);

  const candidates: ExpirableSession[] = [];
  for (let index = 0; index < byRecency.length; index++) {
    const session = byRecency[index];
    if (session.isPinned) {
      kept.push({ sessionId: session.id, reason: 'pinned' });
      continue;
    }
    if (session.status === 'running') {
      kept.push({ sessionId: session.id, reason: 'running' });
      continue;
    }
    if (protectedIds.has(session.id)) {
      kept.push({ sessionId: session.id, reason: 'protected' });
      continue;
    }
    if (index < policy.minSessionsKept) {
      kept.push({ sessionId: session.id, reason: 'floor' });
      continue;
    }
    candidates.push(session);
  }

  // Age first, so an old session is reported as old even if the count rule
  // would also have caught it.
  const overAge = new Set<string>();
  if (policy.maxAgeMs > 0) {
    const cutoff = now - policy.maxAgeMs;
    for (const session of candidates) {
      if (session.updatedAt < cutoff) {
        overAge.add(session.id);
        reasons.set(session.id, 'age');
      }
    }
  }

  if (policy.maxSessions > 0 && byRecency.length > policy.maxSessions) {
    // The count is a cap on the whole list, so the boundary is computed over
    // the recency order, not over the surviving candidates.
    const boundaryId = byRecency[policy.maxSessions]?.id;
    if (boundaryId) {
      const boundary = byRecency[policy.maxSessions];
      for (const session of candidates) {
        if (session.updatedAt <= boundary.updatedAt && !reasons.has(session.id)) {
          reasons.set(session.id, 'count');
        }
      }
    }
  }

  return {
    sessionIds: candidates.filter((s) => reasons.has(s.id)).map((s) => s.id),
    reasons,
    kept,
  };
}

// ---------------------------------------------------------------------------
// Applying the policy
// ---------------------------------------------------------------------------

/** Minimal database surface, so this module does not depend on the whole instance. */
export interface RetentionDatabase {
  sessions: {
    getAll(): Array<{
      id: string;
      updated_at: number;
      status: string;
      is_pinned?: number | null;
    }>;
    delete(id: string): void;
  };
}

export interface RetentionReport {
  expired: number;
  /** Session ids that could not be deleted — a failure here must be logged, not swallowed. */
  failed: string[];
  kept: ExpiryPlan['kept'];
  ranAt: number;
}

/**
 * Expire sessions according to the policy. Runs at startup, before anything
 * reads the session list, so a user never sees a purged conversation appear in
 * the sidebar.
 *
 * A delete that throws is collected and reported rather than aborting the run:
 * one locked row must not leave every other expired session on disk forever.
 */
export function applyRetention(
  db: RetentionDatabase,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
  now: number = Date.now()
): RetentionReport {
  let rows: ReturnType<RetentionDatabase['sessions']['getAll']>;
  try {
    rows = db.sessions.getAll();
  } catch (error) {
    logWarn('[Retention] Could not read sessions, skipping expiry:', error);
    return { expired: 0, failed: [], kept: [], ranAt: now };
  }

  const plan = planSessionExpiry(
    rows.map((row) => ({
      id: row.id,
      updatedAt: row.updated_at,
      status: row.status,
      isPinned: row.is_pinned === 1,
    })),
    policy,
    now
  );

  const failed: string[] = [];
  let expired = 0;
  for (const sessionId of plan.sessionIds) {
    try {
      db.sessions.delete(sessionId);
      expired++;
    } catch (error) {
      failed.push(sessionId);
      logWarn('[Retention] Failed to expire session', sessionId, error);
    }
  }

  if (expired > 0 || failed.length > 0) {
    log(
      `[Retention] Expired ${expired} session(s), ${failed.length} failed, ` +
        `${plan.kept.length} kept by policy`
    );
  }

  return { expired, failed, kept: plan.kept, ranAt: now };
}
