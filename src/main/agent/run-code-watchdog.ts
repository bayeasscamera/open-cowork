/**
 * @module main/agent/run-code-watchdog
 *
 * Host-side enforcement of the resource caps the spawn flags cannot express.
 *
 * `--max-old-space-size` bounds the V8 old space, and `ulimit -t` is not wired
 * (it would need spawning through a shell, which widens the sandbox's
 * process-exec grant for a marginal gain). What remains unbounded is:
 *
 *   - native memory outside the V8 heap (Buffers, ArrayBuffer backing stores,
 *     native modules). A script can allocate gigabytes while the heap stays
 *     small.
 *   - CPU time beyond the wall clock (worker threads; subprocesses are refused
 *     by the sandbox, but threads share the process and multiply CPU seconds).
 *
 * So the host samples the child's RSS and cumulative CPU time and kills the
 * whole process group when either exceeds its budget. Sampling has inherent
 * inertia — a fast allocator overshoots between two samples — so this is a
 * backstop that keeps a runaway from taking the machine down, not a precise
 * limit. That limitation is stated wherever the numbers are surfaced.
 *
 * The watchdog never throws. Every failure mode (the `ps` binary missing, the
 * child already gone, an unparseable line) stops the watch silently: a broken
 * observer must not become a broken execution.
 *
 * @module
 */

import { execFile } from 'node:child_process';

export interface ResourceBudgets {
  /** RSS cap in bytes. Exceeding it kills the child. */
  maxRssBytes: number;
  /** Cumulative CPU seconds cap. Exceeding it kills the child. */
  maxCpuSeconds: number;
}

export type ResourceViolation = 'memory' | 'cpu';

/**
 * Parse `ps -o rss=` output (kilobytes, possibly padded) into bytes.
 * Returns null when the child is gone or the output is not a number.
 */
export function parseRssBytes(output: string): number | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  const kilobytes = Number(trimmed.split(/\s+/)[0]);
  if (!Number.isFinite(kilobytes) || kilobytes < 0) return null;
  return Math.floor(kilobytes * 1024);
}

/**
 * Parse `ps -o time=` output (`[[dd-]hh:]mm:ss`, possibly padded) into seconds.
 * Returns null when the child is gone or the output does not parse.
 */
export function parseCpuSeconds(output: string): number | null {
  const trimmed = output.trim();
  if (!trimmed) return null;
  // [[dd-]hh:]mm:ss — ps pads and varies the shape by magnitude.
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(trimmed);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (![days, hours, minutes, seconds].every(Number.isFinite)) return null;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export interface WatchdogHandle {
  stop: () => void;
}

/**
 * Watch a child process and call `onViolation` once when a budget is exceeded.
 *
 * The interval is deliberately short; each sample is one `ps` invocation, which
 * is cheap next to the child it watches. `onViolation` fires at most once and
 * stops the watch. The caller kills the process group — the watchdog observes,
 * it does not act, so killing stays in the one place that already owns it.
 */
export function startResourceWatchdog(
  pid: number,
  budgets: ResourceBudgets,
  sampleIntervalMs: number,
  onViolation: (violation: ResourceViolation, observed: number) => void
): WatchdogHandle {
  let stopped = false;
  let fired = false;

  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };

  const fail = (violation: ResourceViolation, observed: number): void => {
    if (fired || stopped) return;
    fired = true;
    stop();
    try {
      onViolation(violation, observed);
    } catch {
      // A throwing handler must not take the host down with it.
    }
  };

  const sample = (): void => {
    if (stopped || fired) return;
    execFile('ps', ['-o', 'rss=', '-o', 'time=', '-p', String(pid)], (error, stdout) => {
      if (stopped || fired) return;
      // The child is gone (or ps itself failed): nothing left to watch.
      if (error) {
        stop();
        return;
      }
      // `ps -o rss= -o time=` prints one line with two columns. Anything else
      // (empty output, an error line) means the child is gone.
      const columns = stdout.trim().split(/\s+/);
      if (columns.length < 2 || columns[0] === '') {
        stop();
        return;
      }
      const rssValue = parseRssBytes(columns[0] as string);
      const cpuValue = parseCpuSeconds(columns[columns.length - 1] as string);
      if (rssValue !== null && rssValue > budgets.maxRssBytes) {
        fail('memory', rssValue);
        return;
      }
      if (cpuValue !== null && cpuValue > budgets.maxCpuSeconds) {
        fail('cpu', cpuValue);
      }
    });
  };

  const timer = setInterval(sample, sampleIntervalMs);
  // A sample is best-effort; it must never keep the event loop — and therefore
  // the app — alive on its own.
  timer.unref?.();

  return { stop };
}
