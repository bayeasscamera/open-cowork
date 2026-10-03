/**
 * Typed event bus for mods v2.
 *
 * Design decisions that are load-bearing, and why:
 *
 *  - **Hooks chain, they do not race.** Each hook of an event receives the
 *    previous hook's output. Three redaction mods must compose, not overwrite.
 *  - **Every rewrite is attributed.** The bus returns which mod changed what, so
 *    the approval card can name the mod responsible for the FINAL action rather
 *    than showing a bare command the user never wrote.
 *  - **`failMode` decides a failure, and failures are counted.** A mod that
 *    throws or hangs N times is disabled and reported. Without the counter, one
 *    broken mod degrades every single tool call forever.
 *  - **A timeout is not a sandbox.** It bounds an async hook, nothing more. A
 *    synchronous infinite loop in a mod's hook cannot be interrupted from
 *    in-process; only the watchdog (phase 3) recovers from that. Stated here
 *    because the alternative is a comment implying a guarantee that does not
 *    exist.
 */

import { logWarn } from '../../utils/logger';
import type {
  CoworkModV2,
  ModContext,
  ModEventName,
  ModManifest,
} from '@cowork/mod-api';

/** Signals "stop the chain" from inside an apply() reducer (deny / block). */
export const STOP_CHAIN = Symbol('cowork.mod.stopChain');

export class ModChainStopped extends Error {
  constructor(
    readonly modId: string,
    readonly reason: string
  ) {
    super(reason);
    this.name = 'ModChainStopped';
  }
}

export interface ModActivityEntry {
  readonly at: number;
  readonly modId: string;
  readonly event: ModEventName;
  readonly kind: 'rewrite' | 'block' | 'deny' | 'ask' | 'annotate' | 'add' | 'failure' | 'disable' | 'observe';
  readonly detail: string;
}

export interface ModHealthState {
  failures: number;
  disabled: boolean;
  disabledReason?: string;
  lastError?: string;
  lastDurationMs?: number;
}

export interface ModEventBusOptions {
  /** Per-hook budget. A hook that exceeds it is treated as a failure. */
  timeoutMs?: number;
  /** Consecutive failures before a mod is disabled. */
  maxFailures?: number;
  now?: () => number;
  /** Called when a mod is auto-disabled, so the UI can tell the user. */
  onDisable?: (info: { modId: string; reason: string; failures: number }) => void;
  /** Activity journal. Observation, not restriction. */
  onActivity?: (entry: ModActivityEntry) => void;
}

export const DEFAULT_MOD_HOOK_TIMEOUT_MS = 2000;
export const DEFAULT_MOD_MAX_FAILURES = 3;

interface RegisteredMod {
  readonly mod: CoworkModV2;
  readonly manifest: ModManifest;
  readonly ctx: ModContext;
  health: ModHealthState;
}

/**
 * Journal labels per event, as data rather than if-chains: the bus decides what
 * HAPPENED, the journal only decides how to name it.
 */
const ACTIVITY_KIND: Record<ModEventName, { modify: ModActivityEntry['kind']; stop: ModActivityEntry['kind'] }> = {
  onSessionStart: { modify: 'observe', stop: 'block' },
  onSessionEnd: { modify: 'observe', stop: 'block' },
  onUserPrompt: { modify: 'rewrite', stop: 'block' },
  onContextBuild: { modify: 'add', stop: 'block' },
  onPreToolUse: { modify: 'rewrite', stop: 'deny' },
  onPermissionRequest: { modify: 'deny', stop: 'deny' },
  onPostToolUse: { modify: 'rewrite', stop: 'block' },
  onAssistantMessage: { modify: 'annotate', stop: 'block' },
  onCompact: { modify: 'annotate', stop: 'block' },
  onRoomEvent: { modify: 'observe', stop: 'block' },
};

export interface ChainResult<T> {
  readonly value: T;
  /** Ids of mods that changed the value, in the order they did. */
  readonly modifiedBy: readonly string[];
  /** True when a mod refused and the chain stopped. */
  readonly stopped: boolean;
  readonly stopReason?: string;
  readonly stoppingModId?: string;
}

export class ModEventBus {
  private readonly mods = new Map<string, RegisteredMod>();
  private readonly insertionOrder: RegisteredMod[] = [];
  private readonly timeoutMs: number;
  private readonly maxFailures: number;
  private readonly now: () => number;
  private readonly onDisable?: ModEventBusOptions['onDisable'];
  private readonly onActivity?: ModEventBusOptions['onActivity'];

  constructor(options: ModEventBusOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MOD_HOOK_TIMEOUT_MS;
    this.maxFailures = options.maxFailures ?? DEFAULT_MOD_MAX_FAILURES;
    this.now = options.now ?? Date.now;
    this.onDisable = options.onDisable;
    this.onActivity = options.onActivity;
  }

  register(manifest: ModManifest, mod: CoworkModV2, ctx: ModContext): void {
    if (mod.id !== manifest.id) {
      // Not fatal to the bus — but it means the manifest text and the code
      // disagree about identity, which is exactly what a tampered plugin looks
      // like. Refuse rather than pick one.
      throw new Error(`Mod id mismatch: manifest "${manifest.id}" vs code "${mod.id}"`);
    }
    if (this.mods.has(manifest.id)) return;
    const entry: RegisteredMod = { mod, manifest, ctx, health: { failures: 0, disabled: false } };
    this.mods.set(manifest.id, entry);
    // Insert at the end of its own band rather than at the very end. Bands are
    // the invariant the user cannot override (a `user` mod must never observe a
    // call before `system`), while order INSIDE a band stays the user's choice —
    // expressed by registration order and reshufflable via setOrder.
    const rank: Record<ModManifest['band'], number> = { system: 0, org: 1, user: 2 };
    const bandRank = rank[manifest.band];
    let insertAt = this.insertionOrder.length;
    for (let index = 0; index < this.insertionOrder.length; index += 1) {
      const other = this.insertionOrder[index];
      if (other && rank[other.manifest.band] > bandRank) {
        insertAt = index;
        break;
      }
    }
    this.insertionOrder.splice(insertAt, 0, entry);
  }

  unregister(modId: string): void {
    const index = this.insertionOrder.findIndex((entry) => entry.manifest.id === modId);
    if (index >= 0) this.insertionOrder.splice(index, 1);
    this.mods.delete(modId);
  }

  /**
   * Reorder inside bands. Band rank is NOT re-derived here: a `user` mod stays
   * after every `system` mod whatever order is asked for, because band order is
   * the invariant the user does not get to override. Unknown ids are ignored and
   * unlisted mods keep their relative order at the end.
   */
  setOrder(modIds: readonly string[]): void {
    const rank: Record<ModManifest['band'], number> = { system: 0, org: 1, user: 2 };
    const byId = new Map(this.insertionOrder.map((entry) => [entry.manifest.id, entry]));
    // Build from the REQUESTED sequence, not from insertion order — filtering
    // the current order would silently ignore the order the user just asked for.
    const listed: RegisteredMod[] = [];
    for (const id of modIds) {
      const entry = byId.get(id);
      if (!entry) continue;
      listed.push(entry);
      byId.delete(id);
    }
    listed.sort((a, b) => rank[a.manifest.band] - rank[b.manifest.band]);
    const unlisted = [...byId.values()];
    this.insertionOrder.length = 0;
    this.insertionOrder.push(...listed, ...unlisted);
  }

  list(): readonly RegisteredMod[] {
    return this.insertionOrder;
  }

  health(): ReadonlyMap<string, ModHealthState> {
    const out = new Map<string, ModHealthState>();
    for (const entry of this.insertionOrder) out.set(entry.manifest.id, { ...entry.health });
    return out;
  }

  private record(event: ModEventName, modId: string, kind: ModActivityEntry['kind'], detail: string): void {
    const entry: ModActivityEntry = { at: this.now(), modId, event, kind, detail };
    this.onActivity?.(entry);
  }

  /**
   * Record a failure against a mod and disable it once the budget is spent.
   * `failMode: 'closed'` mods keep failing the CALL rather than passing it.
   */
  private fail(entry: RegisteredMod, event: ModEventName, error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    entry.health.failures += 1;
    entry.health.lastError = message;
    this.record(event, entry.manifest.id, 'failure', message);

    if (entry.health.failures < this.maxFailures) return entry.manifest.failMode === 'closed';

    entry.health.disabled = true;
    entry.health.disabledReason = `${entry.health.failures} consecutive failures; last: ${message}`;
    logWarn(
      `[Mods] "${entry.manifest.id}" disabled after ${entry.health.failures} failures. Last error: ${message}`
    );
    this.record(event, entry.manifest.id, 'disable', entry.health.disabledReason);
    this.onDisable?.({
      modId: entry.manifest.id,
      reason: entry.health.disabledReason,
      failures: entry.health.failures,
    });
    return entry.manifest.failMode === 'closed';
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`hook timed out after ${this.timeoutMs}ms`)),
            this.timeoutMs
          );
        }),
      ]);
    } finally {
      // Always clear the timer: leaving one pending keeps the event loop alive
      // for up to timeoutMs after every healthy hook, which is a slow leak in a
      // long session rather than a cosmetic one.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Run every enabled mod's hook for `event`, chaining values.
   *
   * `invoke` is called as `(mod, ctx, current)` — the hook receives the
   * ACCUMULATED value, not the original seed. That is what makes chaining real
   * rather than decorative: a redaction mod has to see what the previous
   * redaction mod already masked, otherwise two correct mods produce a leak.
   *
   * `apply` then reduces the accumulated value with one hook's decision. It
   * returns `STOP_CHAIN` to refuse; the bus returns `stopped: true` with the
   * refusing mod and reason.
   */
  async chain<TEvent extends ModEventName, TSeed, TOut>(
    event: TEvent,
    seed: TSeed,
    invoke: (mod: CoworkModV2, ctx: ModContext, current: TOut) => Promise<unknown> | unknown,
    apply: (current: TOut, decision: unknown, seed: TSeed, modId: string) => TOut | typeof STOP_CHAIN,
    initial: TOut
  ): Promise<ChainResult<TOut>> {
    let value = initial;
    const modifiedBy: string[] = [];
    const active = this.insertionOrder.filter(
      (entry) => !entry.health.disabled && typeof entry.mod[event] === 'function'
    );

    for (const entry of active) {
      const startedAt = this.now();
      try {
        const decision = await this.withTimeout(Promise.resolve(invoke(entry.mod, entry.ctx, value)));
        entry.health.lastDurationMs = this.now() - startedAt;
        if (decision === undefined || decision === null) {
          // A hook that returns nothing changed nothing. Not a failure: the
          // `{action:'continue'}`-by-omission style is the common case.
          continue;
        }
        const next = apply(value, decision, seed, entry.manifest.id);
        if (next === STOP_CHAIN) {
          const reason = this.extractReason(decision);
          this.record(event, entry.manifest.id, ACTIVITY_KIND[event].stop, reason);
          return {
            value,
            modifiedBy,
            stopped: true,
            stopReason: reason,
            stoppingModId: entry.manifest.id,
          };
        }
        if (next !== value) {
          modifiedBy.push(entry.manifest.id);
          value = next;
        } else if (!this.isNoop(decision)) {
          // A decision that deliberately leaves the value alone is still a
          // decision. `ask` re-runs the permission flow and `annotate` records
          // something against the message; a user auditing "who touched this?"
          // needs both in the journal, so they are attributed without being
          // counted as a rewrite.
          modifiedBy.push(entry.manifest.id);
        } else {
          entry.health.failures = 0;
          continue;
        }
        this.record(event, entry.manifest.id, ACTIVITY_KIND[event].modify, this.describe(event, decision));
        entry.health.failures = 0;
      } catch (error) {
        if (error instanceof ModChainStopped) throw error;
        const shouldBlock = this.fail(entry, event, error);
        if (shouldBlock) {
          const reason = `Mod "${entry.manifest.id}" failed closed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          return {
            value,
            modifiedBy,
            stopped: true,
            stopReason: reason,
            stoppingModId: entry.manifest.id,
          };
        }
      }
    }

    return { value, modifiedBy, stopped: false };
  }

  /**
   * Fire-and-forget observers (session start/end, room events).
   *
   * Not routed through `chain()`: there is no value to reduce, so the chaining
   * machinery would be pure ceremony. Failures are still counted and still
   * disable a mod that misbehaves repeatedly — an observer that throws is a
   * broken mod, not an ignorable one.
   */
  async observe<TEvent extends 'onSessionStart' | 'onSessionEnd' | 'onRoomEvent'>(
    event: TEvent,
    invoke: (mod: CoworkModV2, ctx: ModContext) => Promise<unknown> | unknown
  ): Promise<void> {
    for (const entry of this.insertionOrder) {
      if (entry.health.disabled || typeof entry.mod[event] !== 'function') continue;
      try {
        await this.withTimeout(Promise.resolve(invoke(entry.mod, entry.ctx)));
        entry.health.failures = 0;
      } catch (error) {
        this.fail(entry, event, error);
      }
    }
  }

  private extractReason(decision: unknown): string {
    if (decision && typeof decision === 'object' && 'reason' in decision) {
      const reason = (decision as { reason?: unknown }).reason;
      if (typeof reason === 'string' && reason.length > 0) return reason;
    }
    return 'Refused by a mod.';
  }

  /**
   * Does this decision mean "I looked and changed nothing"? Only `continue`
   * (explicitly, or by omitting the decision) is a no-op.
   */
  private isNoop(decision: unknown): boolean {
    if (!decision || typeof decision !== 'object') return true;
    const action = (decision as { action?: unknown }).action;
    return action === undefined || action === 'continue';
  }

  /**
   * Human-readable journal line. Kept short and factual on purpose: this text is
   * what a user reads when asking "who changed this?", so it names the action,
   * never the mod's own framing of it.
   */
  private describe(event: ModEventName, decision: unknown): string {
    const action =
      decision && typeof decision === 'object' ? (decision as { action?: unknown }).action : undefined;
    if (event === 'onPostToolUse' && decision && typeof decision === 'object' && 'content' in decision) {
      const content = String((decision as { content?: unknown }).content ?? '');
      return `replaced result content (${content.length} chars)`;
    }
    if (event === 'onPreToolUse') {
      if (action === 'rewrite') return 'rewrote tool arguments';
      if (action === 'ask') return 'requested the normal permission flow';
    }
    return typeof action === 'string' ? action : 'modified';
  }
}

let sharedBus: ModEventBus | null = null;

export function getModEventBus(): ModEventBus {
  if (!sharedBus) sharedBus = new ModEventBus();
  return sharedBus;
}

/** Test seam: swap the singleton. */
export function setModEventBusForTest(bus: ModEventBus | null): void {
  sharedBus = bus;
}
