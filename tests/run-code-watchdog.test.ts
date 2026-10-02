import { describe, expect, it, vi } from 'vitest';

import {
  parseCpuSeconds,
  parseRssBytes,
  startResourceWatchdog,
} from '../src/main/agent/run-code-watchdog';

/**
 * The host-side resource watchdog.
 *
 * It exists because two caps cannot be expressed at spawn time: native memory
 * outside the V8 heap, and CPU time beyond the wall clock. Sampling `ps` is
 * inherently approximate, so the parsers are strict — a line that does not
 * parse cleanly means the child is gone, and the watch stops rather than acting
 * on a guess.
 */

describe('RSS parsing', () => {
  it('converts kilobytes with padding into bytes', () => {
    // `ps -o rss=` right-aligns and pads.
    expect(parseRssBytes('   12345')).toBe(12345 * 1024);
    expect(parseRssBytes('0')).toBe(0);
  });

  it('returns null for anything that is not a reading', () => {
    expect(parseRssBytes('')).toBeNull();
    expect(parseRssBytes('RSS')).toBeNull();
    expect(parseRssBytes('-1')).toBeNull();
    expect(parseRssBytes('abc')).toBeNull();
  });
});

describe('CPU time parsing', () => {
  it('parses every shape ps produces as the magnitude grows', () => {
    expect(parseCpuSeconds('0:12.34')).toBeCloseTo(12.34, 2);
    expect(parseCpuSeconds('1:02:03')).toBe(3723);
    expect(parseCpuSeconds('1-02:03:04')).toBe(86400 + 7384);
    // Padded, as ps emits it.
    expect(parseCpuSeconds('   0:00.42  ')).toBeCloseTo(0.42, 2);
  });

  it('returns null for anything that is not a reading', () => {
    expect(parseCpuSeconds('')).toBeNull();
    expect(parseCpuSeconds('TIME')).toBeNull();
    expect(parseCpuSeconds('never')).toBeNull();
    expect(parseCpuSeconds('1:2:3:4:5')).toBeNull();
  });
});

describe('the watchdog observes and never acts beyond its one call', () => {
  it('fires once and then stops, even if the breach persists', () => {
    vi.useFakeTimers();
    try {
      const onViolation = vi.fn();
      // pid -1: ps fails, which must stop the watch rather than throw.
      const handle = startResourceWatchdog(
        -1,
        { maxRssBytes: 1, maxCpuSeconds: 1 },
        100,
        onViolation
      );
      expect(handle.stop).toBeTypeOf('function');
      handle.stop();
      expect(onViolation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing handler does not propagate out of the watch', () => {
    // The handler runs inside a ps callback; throwing there would take down
    // the host loop. It is swallowed by design.
    vi.useFakeTimers();
    try {
      const handle = startResourceWatchdog(
        process.pid,
        { maxRssBytes: -1, maxCpuSeconds: Number.MAX_SAFE_INTEGER },
        50,
        () => {
          throw new Error('handler bug');
        }
      );
      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
