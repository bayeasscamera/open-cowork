import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETENTION_POLICY,
  TRACE_TEXT_LIMITS,
  TRUNCATION_MARKER,
  applyRetention,
  boundTraceStepRow,
  planSessionExpiry,
  truncateTraceText,
  type ExpirableSession,
  type RetentionDatabase,
  type RetentionPolicy,
} from '../src/main/db/retention';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

const session = (overrides: Partial<ExpirableSession> & { id: string }): ExpirableSession => ({
  updatedAt: NOW,
  status: 'idle',
  isPinned: false,
  ...overrides,
});

const policy = (overrides: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  maxAgeMs: 30 * DAY,
  minSessionsKept: 2,
  maxSessions: 0,
  protectedSessionIds: [],
  ...overrides,
});

describe('truncateTraceText', () => {
  it('leaves a value within the limit untouched', () => {
    expect(truncateTraceText('short output', 100)).toBe('short output');
    expect(truncateTraceText('exactly ten', 11)).toBe('exactly ten');
  });

  it('shortens an oversized value and says so', () => {
    const result = truncateTraceText('x'.repeat(5_000), 100);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(100);
    expect(result!.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('keeps the head, where the tool name and first error are', () => {
    const result = truncateTraceText('ERROR: boom\n' + 'y'.repeat(1_000), 100);
    expect(result!.startsWith('ERROR: boom')).toBe(true);
  });

  it('never exceeds the limit even with the marker', () => {
    // The limit is a storage bound, not a hint: length + marker must fit.
    for (const limit of [1, 5, 20, 64, 101]) {
      const result = truncateTraceText('z'.repeat(10_000), limit);
      expect(result!.length).toBeLessThanOrEqual(limit);
    }
  });

  it('passes through null and undefined as null', () => {
    expect(truncateTraceText(null, 10)).toBeNull();
    expect(truncateTraceText(undefined, 10)).toBeNull();
  });

  it('treats a non-positive limit as no limit', () => {
    const big = 'q'.repeat(20_000);
    expect(truncateTraceText(big, 0)).toBe(big);
    expect(truncateTraceText(big, -1)).toBe(big);
  });

  it('handles a limit smaller than the marker without throwing', () => {
    const result = truncateTraceText('abcdefghij', 3);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(3);
  });
});

describe('boundTraceStepRow', () => {
  it('bounds each text field independently', () => {
    const row = boundTraceStepRow({
      content: 'c'.repeat(20_000),
      tool_output: 'o'.repeat(20_000),
      tool_input: 'i'.repeat(20_000),
    });
    expect(row.content!.length).toBeLessThanOrEqual(TRACE_TEXT_LIMITS.content);
    expect(row.tool_output!.length).toBeLessThanOrEqual(TRACE_TEXT_LIMITS.toolOutput);
    expect(row.tool_input!.length).toBeLessThanOrEqual(TRACE_TEXT_LIMITS.toolInput);
  });

  it('leaves other fields and small values alone', () => {
    const row = boundTraceStepRow({
      id: 'step-1',
      title: 'Bash',
      content: 'ok',
      tool_output: null,
    });
    expect(row).toMatchObject({ id: 'step-1', title: 'Bash', content: 'ok', tool_output: null });
  });

  it('does not add keys that were absent', () => {
    const row = boundTraceStepRow({ tool_output: 'short' });
    expect('content' in row).toBe(false);
    expect('tool_input' in row).toBe(false);
  });
});

describe('planSessionExpiry', () => {
  it('expires sessions older than the age limit', () => {
    const plan = planSessionExpiry(
      [
        session({ id: 'old', updatedAt: NOW - 40 * DAY }),
        session({ id: 'recent', updatedAt: NOW - 2 * DAY }),
      ],
      policy({ minSessionsKept: 0 }),
      NOW
    );
    expect(plan.sessionIds).toEqual(['old']);
    expect(plan.reasons.get('old')).toBe('age');
  });

  it('never expires a pinned session, however old', () => {
    const plan = planSessionExpiry(
      [session({ id: 'pinned', isPinned: true, updatedAt: NOW - 999 * DAY })],
      policy({ minSessionsKept: 0 }),
      NOW
    );
    expect(plan.sessionIds).toEqual([]);
    expect(plan.kept).toEqual([{ sessionId: 'pinned', reason: 'pinned' }]);
  });

  it('never expires a running session', () => {
    // A running session holds an AbortController and an SDK session; deleting
    // its rows would leave the agent loop writing into nothing.
    const plan = planSessionExpiry(
      [session({ id: 'busy', status: 'running', updatedAt: NOW - 999 * DAY })],
      policy({ minSessionsKept: 0 }),
      NOW
    );
    expect(plan.sessionIds).toEqual([]);
    expect(plan.kept).toEqual([{ sessionId: 'busy', reason: 'running' }]);
  });

  it('never expires a protected session', () => {
    const plan = planSessionExpiry(
      [session({ id: 'scheduled', updatedAt: NOW - 999 * DAY })],
      policy({ minSessionsKept: 0, protectedSessionIds: ['scheduled'] }),
      NOW
    );
    expect(plan.sessionIds).toEqual([]);
    expect(plan.kept[0].reason).toBe('protected');
  });

  it('keeps at least minSessionsKept even when all of them are ancient', () => {
    // Coming back to an empty sidebar because the clock moved is worse than
    // keeping old data, so the floor is absolute: the two most recent survive,
    // and only the third — the oldest — expires.
    const plan = planSessionExpiry(
      [
        session({ id: 'a', updatedAt: NOW - 400 * DAY }),
        session({ id: 'b', updatedAt: NOW - 300 * DAY }),
        session({ id: 'c', updatedAt: NOW - 200 * DAY }),
      ],
      policy({ minSessionsKept: 2 }),
      NOW
    );
    expect(plan.sessionIds).toEqual(['a']);
    expect(plan.reasons.get('a')).toBe('age');
    expect(plan.kept.filter((k) => k.reason === 'floor').map((k) => k.sessionId)).toEqual([
      'c',
      'b',
    ]);
  });

  it('enforces a hard session count by dropping the oldest', () => {
    const plan = planSessionExpiry(
      [
        session({ id: 'newest', updatedAt: NOW - 1 * DAY }),
        session({ id: 'mid', updatedAt: NOW - 2 * DAY }),
        session({ id: 'oldest', updatedAt: NOW - 3 * DAY }),
      ],
      // Age is disabled so only the count rule can fire.
      policy({ maxAgeMs: 0, minSessionsKept: 0, maxSessions: 2 }),
      NOW
    );
    expect(plan.sessionIds).toEqual(['oldest']);
    expect(plan.reasons.get('oldest')).toBe('count');
  });

  it('reports age when both age and count would match', () => {
    const plan = planSessionExpiry(
      [
        session({ id: 'a', updatedAt: NOW - 1 * DAY }),
        session({ id: 'b', updatedAt: NOW - 2 * DAY }),
        session({ id: 'c', updatedAt: NOW - 400 * DAY }),
      ],
      policy({ maxAgeMs: 30 * DAY, minSessionsKept: 0, maxSessions: 2 }),
      NOW
    );
    expect(plan.reasons.get('c')).toBe('age');
  });

  it('does nothing when both limits are disabled', () => {
    const plan = planSessionExpiry(
      [session({ id: 'ancient', updatedAt: 0 })],
      policy({ maxAgeMs: 0, minSessionsKept: 0, maxSessions: 0 }),
      NOW
    );
    expect(plan.sessionIds).toEqual([]);
  });

  it('handles an empty list', () => {
    const plan = planSessionExpiry([], policy(), NOW);
    expect(plan.sessionIds).toEqual([]);
    expect(plan.kept).toEqual([]);
  });
});

describe('applyRetention', () => {
  const fakeDb = (
    rows: Array<{ id: string; updated_at: number; status: string; is_pinned?: number | null }>,
    failOn: string[] = []
  ): RetentionDatabase & { deleted: string[] } => {
    const deleted: string[] = [];
    return {
      deleted,
      sessions: {
        getAll: () => rows,
        delete: (id: string) => {
          if (failOn.includes(id)) throw new Error('SQLITE_BUSY');
          deleted.push(id);
        },
      },
    };
  };

  it('deletes the sessions the plan selected', () => {
    const db = fakeDb([
      { id: 'old', updated_at: NOW - 400 * DAY, status: 'idle' },
      { id: 'keep', updated_at: NOW - 1 * DAY, status: 'idle' },
    ]);
    const report = applyRetention(db, policy({ minSessionsKept: 0 }), NOW);
    expect(db.deleted).toEqual(['old']);
    expect(report.expired).toBe(1);
    expect(report.failed).toEqual([]);
  });

  it('maps the pinned column and survives a session with no pin set', () => {
    const db = fakeDb([
      { id: 'pinned', updated_at: NOW - 400 * DAY, status: 'idle', is_pinned: 1 },
      { id: 'unpinned', updated_at: NOW - 400 * DAY, status: 'idle', is_pinned: null },
    ]);
    const report = applyRetention(db, policy({ minSessionsKept: 0 }), NOW);
    expect(db.deleted).toEqual(['unpinned']);
    expect(report.kept).toEqual([{ sessionId: 'pinned', reason: 'pinned' }]);
  });

  it('collects a failure and keeps expiring the rest', () => {
    // One locked row must not leave every other expired session on disk.
    const db = fakeDb(
      [
        { id: 'locked', updated_at: NOW - 400 * DAY, status: 'idle' },
        { id: 'fine', updated_at: NOW - 300 * DAY, status: 'idle' },
      ],
      ['locked']
    );
    const report = applyRetention(db, policy({ minSessionsKept: 0 }), NOW);
    expect(db.deleted).toEqual(['fine']);
    expect(report.expired).toBe(1);
    expect(report.failed).toEqual(['locked']);
  });

  it('reports nothing when the session read itself fails', () => {
    const db: RetentionDatabase = {
      sessions: {
        getAll: () => {
          throw new Error('database is locked');
        },
        delete: () => undefined,
      },
    };
    const report = applyRetention(db, policy(), NOW);
    expect(report).toEqual({ expired: 0, failed: [], kept: [], ranAt: NOW });
  });

  it('has a default policy that keeps a reasonable history', () => {
    // Guards the shipped numbers: a policy that expires everything by default
    // would delete a user's history on the first launch after the update.
    expect(DEFAULT_RETENTION_POLICY.maxAgeMs).toBeGreaterThanOrEqual(90 * DAY);
    expect(DEFAULT_RETENTION_POLICY.minSessionsKept).toBeGreaterThanOrEqual(20);
    expect(DEFAULT_RETENTION_POLICY.maxSessions).toBeGreaterThanOrEqual(100);
  });
});
