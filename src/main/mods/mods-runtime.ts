/**
 * @module main/mods/mods-runtime
 *
 * Local function-hook system ("mods") — 100% offline. Mods intercept tool
 * calls before execution and tool results before they are injected into the
 * model context. Enabled/disabled state persists in electron-store.
 *
 * Design note: the main-agent integration composes these hooks into the
 * pi Agent's setBeforeToolCall/setAfterToolCall slots (single-slot, so the
 * registry runs as a chain inside one hook). Sub-agent sessions lack the
 * session-level setters — there mods would wrap tools (withConfinement
 * pattern), which this iteration does not need.
 */

import Store from 'electron-store';
import { log, logWarn } from '../utils/logger';

export interface ModsToolCall {
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ModsToolResult {
  /** Concatenated text content of the tool result. */
  content: string;
}

export interface PreToolUseDecision {
  block?: boolean;
  reason?: string;
}

export interface PostToolUseDecision {
  /** Replace the whole text content of the result before it reaches the model. */
  replaceContent?: string;
}

export interface CoworkMod {
  id: string;
  label: string;
  description: string;
  onPreToolUse?: (call: ModsToolCall) => PreToolUseDecision | void;
  onPostToolUse?: (call: ModsToolCall, result: ModsToolResult) => PostToolUseDecision | void;
  /** Optional system-prompt addition (e.g. domain conventions). */
  getContextAdditions?: (cwd: string) => string;
}

export interface ModSummary {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
}

interface ModsStoreSchema {
  enabled: Record<string, boolean>;
}

export class ModsRegistry {
  private readonly mods = new Map<string, CoworkMod>();
  private readonly store: Store<ModsStoreSchema>;
  private enabled: Record<string, boolean>;

  constructor(store?: Store<ModsStoreSchema>) {
    this.store = store ?? new Store<ModsStoreSchema>({ name: 'mods-config' });
    this.enabled = this.store.get('enabled') ?? {};
  }

  register(mod: CoworkMod): void {
    if (this.mods.has(mod.id)) {
      logWarn(`[Mods] Duplicate mod id "${mod.id}" — ignoring re-registration`);
      return;
    }
    this.mods.set(mod.id, mod);
  }

  setEnabled(id: string, enabled: boolean): void {
    if (!this.mods.has(id)) {
      throw new Error(`Unknown mod: ${id}`);
    }
    this.enabled[id] = enabled;
    this.store.set('enabled', this.enabled);
    log(`[Mods] ${id} ${enabled ? 'enabled' : 'disabled'}`);
  }

  isEnabled(id: string): boolean {
    return this.enabled[id] !== false; // enabled by default, like the settings spec
  }

  list(): ModSummary[] {
    return [...this.mods.values()].map((mod) => ({
      id: mod.id,
      label: mod.label,
      description: mod.description,
      enabled: this.isEnabled(mod.id),
    }));
  }

  /**
   * Run enabled mods' pre-hooks in registration order. The first blocking
   * decision wins; a block short-circuits the chain. Mods must never throw
   * out of the chain — a failing mod is skipped with a warning so one broken
   * mod cannot break the agent loop.
   */
  runPreToolUse(call: ModsToolCall): PreToolUseDecision {
    for (const mod of this.mods.values()) {
      if (!this.isEnabled(mod.id) || !mod.onPreToolUse) continue;
      try {
        const decision = mod.onPreToolUse(call);
        if (decision?.block) {
          return { block: true, reason: decision.reason ?? `Blocked by mod ${mod.id}` };
        }
      } catch (error) {
        logWarn(`[Mods] ${mod.id} pre-hook failed (skipped):`, error);
      }
    }
    return {};
  }

  /**
   * Run enabled mods' post-hooks in registration order. The LAST content
   * replacement wins (later mods see the already-replaced text, so
   * redaction chains compose).
   */
  runPostToolUse(call: ModsToolCall, result: ModsToolResult): string {
    let content = result.content;
    for (const mod of this.mods.values()) {
      if (!this.isEnabled(mod.id) || !mod.onPostToolUse) continue;
      try {
        const decision = mod.onPostToolUse(call, { content });
        if (typeof decision?.replaceContent === 'string') {
          content = decision.replaceContent;
        }
      } catch (error) {
        logWarn(`[Mods] ${mod.id} post-hook failed (skipped):`, error);
      }
    }
    return content;
  }

  /** Concatenated system-prompt additions from enabled mods (domain conventions). */
  getContextAdditions(cwd: string): string {
    return [...this.mods.values()]
      .filter((mod) => this.isEnabled(mod.id) && mod.getContextAdditions)
      .map((mod) => {
        try {
          return mod.getContextAdditions?.(cwd) ?? '';
        } catch (error) {
          logWarn(`[Mods] ${mod.id} context addition failed:`, error);
          return '';
        }
      })
      .filter((text) => text.trim().length > 0)
      .join('\n\n');
  }
}

let sharedRegistry: ModsRegistry | null = null;

export function getModsRegistry(): ModsRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new ModsRegistry();
  }
  return sharedRegistry;
}

/** Test seam: swap the singleton. */
export function setModsRegistryForTest(registry: ModsRegistry | null): void {
  sharedRegistry = registry;
}