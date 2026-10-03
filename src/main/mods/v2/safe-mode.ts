/**
 * Safe mode — Cowork must always start.
 *
 * A mod runs in the main process with full access, so it can crash the app. If
 * the app then cannot start at all, the user has lost their editor to a plugin,
 * and the only way out would be to delete files by hand. That is the failure this
 * module exists to make impossible.
 *
 * Three independent levels, deliberately redundant:
 *  1. `--no-mods` on the command line — one flag, always available, no store.
 *  2. A "no mods" setting — survives a restart the user did not plan.
 *  3. An automatic fallback after N consecutive boot failures — the only one that
 *     helps when the user did not know they had a problem.
 *
 * Honest limit: none of these recover a crash that happens BEFORE the counter is
 * written. The store write is what makes the next boot safe, so a crash on the
 * very first boot after installing a mod may still cost one restart. The
 * watchdog (below) is what closes that window.
 */

import { log, logWarn } from '../../utils/logger';

/** Consecutive boot failures before the next launch is forced safe. */
export const SAFE_MODE_CRASH_THRESHOLD = 3;

export interface SafeModeStoreLike {
  load(): SafeModeState;
  save(state: SafeModeState): void;
}

export interface SafeModeState {
  /** Set by the user in settings. */
  disabledGlobally: boolean;
  /** Boot failures observed so far; reset by a clean boot. */
  consecutiveBootFailures: number;
  /** Mods recorded as loaded in the failed boot, for the recovery message. */
  lastFailedMods: readonly string[];
  /** Set when the app entered safe mode on its own, so the UI can say why. */
  autoEnteredAt: number | null;
}

export function initialSafeModeState(): SafeModeState {
  return {
    disabledGlobally: false,
    consecutiveBootFailures: 0,
    lastFailedMods: [],
    autoEnteredAt: null,
  };
}

/**
 * Command-line escape hatch. Checked on every boot, independent of any store,
 * so it still works when the store is the thing that is unreadable.
 */
export function isNoModsFlagPresent(argv: readonly string[] = process.argv): boolean {
  return argv.includes('--no-mods');
}

export interface BootOutcome {
  readonly ok: boolean;
  /** Ids of the mods that were active during this boot. */
  readonly loadedMods?: readonly string[];
}

export interface SafeModeDecision {
  readonly safeMode: boolean;
  /** Why safe mode is on — surfaced verbatim to the user. */
  readonly reason: 'flag' | 'setting' | 'auto' | 'none';
  readonly crashedMods: readonly string[];
}

export class SafeModeController {
  constructor(
    private readonly store: SafeModeStoreLike,
    private readonly threshold: number = SAFE_MODE_CRASH_THRESHOLD
  ) {}

  private state(): SafeModeState {
    return { ...initialSafeModeState(), ...this.store.load() };
  }

  /**
   * Decide whether to start with mods disabled.
   *
   * Read BEFORE any mod is loaded, obviously. `flag` wins over `setting`, and
   * `auto` is reported separately from `setting` so the UI can explain an
   * automatic fallback instead of silently behaving as if the user asked for it.
   */
  evaluate(argv: readonly string[] = process.argv): SafeModeDecision {
    const state = this.state();
    if (isNoModsFlagPresent(argv)) {
      return { safeMode: true, reason: 'flag', crashedMods: [] };
    }
    if (state.autoEnteredAt !== null) {
      return {
        safeMode: true,
        reason: 'auto',
        crashedMods: state.lastFailedMods,
      };
    }
    if (state.disabledGlobally) {
      return { safeMode: true, reason: 'setting', crashedMods: [] };
    }
    return { safeMode: false, reason: 'none', crashedMods: [] };
  }

  /** A boot that reached the end of startup. Clears the failure run. */
  recordBootSuccess(): void {
    const state = this.state();
    if (state.consecutiveBootFailures === 0 && state.autoEnteredAt === null) return;
    this.store.save({
      ...state,
      consecutiveBootFailures: 0,
      lastFailedMods: [],
      autoEnteredAt: null,
    });
  }

  /**
   * A boot that died before completing. Records which mods were live, and enters
   * automatic safe mode once the run reaches the threshold.
   */
  recordBootFailure(outcome: BootOutcome, now: number = Date.now()): SafeModeState {
    const state = this.state();
    const failures = state.consecutiveBootFailures + 1;
    const loadedMods = outcome.loadedMods ?? [];
    const next: SafeModeState = {
      ...state,
      consecutiveBootFailures: failures,
      lastFailedMods: loadedMods,
      autoEnteredAt: failures >= this.threshold ? now : state.autoEnteredAt,
    };
    this.store.save(next);

    if (next.autoEnteredAt !== null && state.autoEnteredAt === null) {
      logWarn(
        `[SafeMode] ${failures} consecutive boot failures with mods loaded — next launch will start in no-mods mode.${
          loadedMods.length > 0 ? ` Mods active during the last failure: ${loadedMods.join(', ')}.` : ''
        }`
      );
    }
    log(`[SafeMode] Boot failure recorded (${failures}/${this.threshold}).`);
    return next;
  }

  /** The user turned safe mode off explicitly: forget the run. */
  clearAuto(): void {
    const state = this.state();
    this.store.save({ ...state, consecutiveBootFailures: 0, lastFailedMods: [], autoEnteredAt: null });
  }

  setDisabledGlobally(disabled: boolean): void {
    const state = this.state();
    this.store.save({ ...state, disabledGlobally: disabled });
    log(`[SafeMode] Global no-mods mode ${disabled ? 'enabled' : 'disabled'}.`);
  }

  snapshot(): SafeModeState {
    return this.state();
  }
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

export interface WatchdogSpawner {
  /** Start a detached helper process. Returns its pid. */
  (): number;
}

/** Opaque timer handle: Node and the DOM disagree, and tests fake both. */
export type TimerHandle = ReturnType<typeof setTimeout>;

export interface WatchdogOptions {
  /** How long after arming to consider the main process hung. */
  readonly hangTimeoutMs: number;
  /** How often to check liveness. */
  readonly pollIntervalMs: number;
  readonly spawnWatchdog: WatchdogSpawner;
  /** Relaunch with --no-mods. Injected so tests never spawn a real process. */
  readonly relaunch: (args: readonly string[]) => void;
  readonly isAlive: (pid: number) => boolean;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  readonly clearTimeoutFn?: (handle: TimerHandle) => void;
}

/**
 * Minimal external watchdog.
 *
 * Why it must be a SEPARATE process: the failure it exists for is a hung main
 * process, and code inside a hung process cannot recover it. A timer in the main
 * process is exactly as dead as the thing it is meant to rescue.
 *
 * What it can and cannot do:
 *  - CAN: notice the main process stopped responding after mods loaded, and
 *    relaunch the app with --no-mods.
 *  - CANNOT: tell a hang apart from legitimate long work. A compaction or a long
 *    build looks exactly like a freeze. That is why the timeout is generous and
 *    why a single missed heartbeat is never enough — a false positive here means
 *    the user's work is interrupted, which is worse than a slow start.
 */
export class ModWatchdog {
  private handle: TimerHandle | undefined;
  private armed = false;

  constructor(private readonly options: WatchdogOptions) {}

  /**
   * Arm the watchdog once mods are loaded. Arming LATE is deliberate: during
   * startup the main process is busy and slow to answer, and a watchdog that
   * fires there would turn every cold start into a false positive.
   */
  arm(): number {
    if (this.armed) return -1;
    const pid = this.options.spawnWatchdog();
    // `lib` includes DOM, so the bare `setTimeout` name is overloaded (number in
    // the DOM, Timeout in Node). Pin the signature so both the default and an
    // injected scheduler agree on one handle type.
    const schedule: (fn: () => void, ms: number) => TimerHandle =
      this.options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.handle = schedule(() => {
      if (!this.options.isAlive(pid)) return; // exited cleanly — nothing to rescue
      logWarn('[SafeMode] Watchdog saw a hung main process; relaunching with --no-mods.');
      this.options.relaunch(['--no-mods']);
    }, this.options.hangTimeoutMs);
    this.armed = true;
    log(`[SafeMode] Watchdog armed (pid ${pid}, timeout ${this.options.hangTimeoutMs}ms).`);
    return pid;
  }

  disarm(): void {
    if (this.handle !== undefined) {
      const clear: (handle: TimerHandle) => void =
        this.options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
      clear(this.handle);
    }
    this.handle = undefined;
    this.armed = false;
  }

  isArmed(): boolean {
    return this.armed;
  }
}