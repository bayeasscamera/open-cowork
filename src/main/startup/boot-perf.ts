/**
 * @module main/startup/boot-perf
 *
 * Minimal boot profiler: timestamped stage marks along the `whenReady()`
 * bootstrap, dependency-free (no electron import) so it is unit-testable and
 * safe to import from anywhere in the main process.
 *
 * Read the numbers from the log (`[BootPerf]`) on a real machine — they are
 * the only honest boot measurement. Stage deltas are measured against the
 * previous mark, so inserting a new mark never shifts the existing ones.
 */

export interface BootStageSample {
  stage: string;
  /** ms since the profiler started. */
  atMs: number;
  /** ms since the previous mark. */
  deltaMs: number;
}

export class BootProfiler {
  private readonly startedAt = Date.now();
  private lastAt = this.startedAt;
  private readonly stages: BootStageSample[] = [];

  /** Record a stage. Never throws — profiling must not break boot. */
  mark(stage: string): void {
    try {
      const now = Date.now();
      this.stages.push({ stage, atMs: now - this.startedAt, deltaMs: now - this.lastAt });
      this.lastAt = now;
    } catch {
      // Profiling is best-effort by design.
    }
  }

  /** Ordered samples, oldest first. */
  summary(): BootStageSample[] {
    return [...this.stages];
  }

  /** Total elapsed ms from construction to the last mark (0 when unmarked). */
  totalMs(): number {
    if (this.stages.length === 0) return 0;
    const last = this.stages[this.stages.length - 1];
    return last ? last.atMs : 0;
  }

  /** One log line per stage plus a total — paste-friendly for boot reports. */
  format(): string {
    const lines = this.stages.map(
      (sample) => `  ${sample.stage}: +${sample.deltaMs}ms (t=${sample.atMs}ms)`
    );
    lines.push(`  total: ${this.totalMs()}ms over ${this.stages.length} stages`);
    return lines.join('\n');
  }

  reset(): void {
    this.stages.length = 0;
    this.lastAt = Date.now();
  }
}

/** Process-wide profiler; marks are added from `src/main/index.ts`. */
export const bootProfiler = new BootProfiler();
