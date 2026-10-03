/**
 * The live mods runtime for the running app.
 *
 * This is what `agent-hooks.ts` calls. Before it existed, the agent path used the
 * v1 `ModsRegistry` directly, which had two problems discovered in PHASE 0:
 *
 *  1. **Mods ran twice per tool call.** `setBeforeToolCall` is a single slot:
 *     `installPermissionHook` installed the shared gate, then `installModsHooks`
 *     wrapped it and ran `onPreToolUse` again before delegating. Invisible with
 *     the v1 mods (none of them rewrote args), but a mod that multiplies its
 *     arguments would have doubled every call.
 *  2. **`getContextAdditions` had no consumer.** `domain-loader` contributed
 *     nothing at all; its file read fed a string nobody read.
 *
 * Both are fixed here by making the gate the single pre-hook entry point.
 *
 * Everything is injectable so the wiring can be tested without booting Electron.
 */

import { log, logWarn } from '../../utils/logger';
import { ModEventBus, STOP_CHAIN } from './event-bus';
import { createBuiltinModsV2, type SecDefaultPolicy } from './builtin-mods-v2';
import { buildModContext, type ModContextDeps } from './mod-context';
import type { ModContextSection } from '@cowork/mod-api';

export interface ModsRuntimeOptions extends ModContextDeps {
  /** Organisation policy for `sec-default`. Omitted means inert. */
  readonly policy?: SecDefaultPolicy;
  readonly bus?: ModEventBus;
  /** Set false by `--no-mods` or the setting, before any mod is registered. */
  readonly enabled?: boolean;
}

export interface PreToolUseOutcome {
  readonly blocked: boolean;
  readonly reason?: string;
  readonly args?: Record<string, unknown>;
  readonly modifiedBy?: readonly string[];
}

export class ModsRuntime {
  readonly bus: ModEventBus;
  private readonly ctxDeps: ModContextDeps;
  private disabledReason: 'flag' | 'setting' | 'auto' | null = null;
  private enabled: boolean;

  constructor(options: ModsRuntimeOptions = { tools: { invoke: async () => ({ content: '' }) } }) {
    this.bus = options.bus ?? new ModEventBus({ onDisable: (info) => logWarn(`[Mods] "${info.modId}" disabled: ${info.reason}`) });
    this.ctxDeps = options;
    this.enabled = options.enabled ?? true;
    if (!this.enabled) this.disabledReason = 'setting';
    if (this.enabled) this.registerBuiltins(options.policy);
  }

  private registerBuiltins(policy?: SecDefaultPolicy): void {
    for (const entry of createBuiltinModsV2(policy)) {
      this.bus.register(entry.manifest, entry.mod, buildModContext(entry.manifest, this.ctxDeps));
    }
    log(`[Mods] Runtime active — ${this.bus.list().length} built-in mods registered.`);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Safe mode can be entered after a boot failure; already-registered mods stop. */
  disableAll(reason: 'flag' | 'setting' | 'auto'): void {
    this.enabled = false;
    this.disabledReason = reason;
    // Snapshot first: `list()` returns the live insertion order, so unregistering
    // while iterating it skips entries and leaves half the mods registered.
    for (const entry of [...this.bus.list()]) this.bus.unregister(entry.manifest.id);
    log(`[Mods] Runtime disabled (${reason}).`);
  }

  /**
   * Pre-tool-use. Returns the FINAL arguments when a mod rewrote them.
   *
   * Async because v2 hooks may be async and are bounded by a per-hook timeout.
   * The gate awaits this, so an `ask` decision and a rewrite both complete before
   * permission and machine access are evaluated.
   */
  async runPreToolUse(call: { sessionId: string; toolName: string; args: Record<string, unknown> }): Promise<PreToolUseOutcome> {
    if (!this.enabled) return { blocked: false };
    const seed = { ...call, args: { ...call.args } };
    const result = await this.bus.chain<'onPreToolUse', typeof seed, Record<string, unknown>>(
      'onPreToolUse',
      seed,
      (mod, _ctx, current) =>
        mod.onPreToolUse?.({ sessionId: seed.sessionId, toolName: seed.toolName, args: current }),
      (current, decision) => {
        const d = decision as { action: string; reason?: string; args?: Record<string, unknown> };
        if (d.action === 'deny') return STOP_CHAIN;
        if (d.action === 'rewrite' && d.args) return { ...current, ...d.args };
        return current;
      },
      seed.args
    );

    if (result.stopped) {
      return { blocked: true, reason: result.stopReason, ...(result.stoppingModId ? { reason: `${result.stopReason} (mod: ${result.stoppingModId})` } : {}) };
    }
    return {
      blocked: false,
      ...(result.modifiedBy.length > 0 ? { args: result.value, modifiedBy: result.modifiedBy } : {}),
    };
  }

  /** Post-tool-use: the text the model and the UI will actually see. */
  async runPostToolUse(
    call: { sessionId: string; toolName: string; args: Record<string, unknown> },
    result: { content: string }
  ): Promise<{ content: string; modifiedBy: readonly string[] }> {
    if (!this.enabled) return { content: result.content, modifiedBy: [] };
    const seed = { ...call, result };
    const chain = await this.bus.chain<'onPostToolUse', typeof seed, string>(
      'onPostToolUse',
      seed,
      (mod, _ctx, current) =>
        mod.onPostToolUse?.({ sessionId: seed.sessionId, toolName: seed.toolName, args: call.args }, { content: current }),
      (current, decision) => {
        const d = decision as { action: string; content?: string };
        return d.action === 'rewrite' && typeof d.content === 'string' ? d.content : current;
      },
      result.content
    );
    return { content: chain.value, modifiedBy: chain.modifiedBy };
  }

  /**
   * Prompt-system sections contributed by mods.
   *
   * This is the call site `getContextAdditions` never had. `domain-loader` was
   * reading a workspace file into a string nobody read; now it lands in the
   * prompt, as a named section, alongside — never replacing — AGENTS.md.
   */
  async buildContextSections(cwd: string): Promise<ModContextSection[]> {
    if (!this.enabled) return [];
    const chain = await this.bus.chain<'onContextBuild', string, ModContextSection[]>(
      'onContextBuild',
      cwd,
      (mod, _ctx, current) => mod.onContextBuild?.({ cwd, sections: current }),
      (current, decision) => {
        const d = decision as { action: string; section?: ModContextSection };
        // A NEW array each time: the reducer must not mutate the accumulator, or
        // the bus's `next !== value` attribution check cannot see the change.
        return d.action === 'add' && d.section ? [...current, d.section] : current;
      },
      [] as ModContextSection[]
    );
    // The chain's RESULT, not the array we started from: the reducer builds a
    // fresh array, so returning the seed would silently discard every section.
    return chain.value;
  }

  /** Fire-and-forget observers. */
  async emit(event: 'onSessionStart' | 'onSessionEnd' | 'onRoomEvent', payload: unknown): Promise<void> {
    if (!this.enabled) return;
    const run = (mod: Record<string, unknown>): unknown => {
      const hook = mod[event];
      return typeof hook === 'function' ? (hook as (input: unknown) => unknown).call(mod, payload) : undefined;
    };
    await this.bus.observe(event, (mod) => run(mod as unknown as Record<string, unknown>));
  }

  /** Expose why mods are off, for the settings page and the startup notice. */
  reasonForDisabled(): 'flag' | 'setting' | 'auto' | null {
    return this.disabledReason;
  }

  health(): Record<string, { disabled: boolean; failures: number; lastError?: string }> {
    const out: Record<string, { disabled: boolean; failures: number; lastError?: string }> = {};
    for (const [id, state] of this.bus.health()) {
      out[id] = { disabled: state.disabled, failures: state.failures, ...(state.lastError ? { lastError: state.lastError } : {}) };
    }
    return out;
  }
}

let shared: ModsRuntime | null = null;

export function initModsRuntime(options: ModsRuntimeOptions): ModsRuntime {
  shared = new ModsRuntime(options);
  return shared;
}

export function getModsRuntime(): ModsRuntime | null {
  return shared;
}

/** Test seam. */
export function setModsRuntimeForTest(runtime: ModsRuntime | null): void {
  shared = runtime;
}