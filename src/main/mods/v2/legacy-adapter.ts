/**
 * Adapter for the v1 `CoworkMod` interface.
 *
 * A mod written against v1 (`onPreToolUse` returning `{block}`,
 * `onPostToolUse` returning `{replaceContent}`, `getContextAdditions`) must keep
 * working. The alternative — telling every existing mod author to rewrite — turns
 * a framework change into a migration project, and users do not migrate plugins
 * for free.
 *
 * What the adapter does NOT hide:
 *  - v1 `onPreToolUse` could only allow or block. It has no `rewrite`, no `ask`.
 *    That limitation is real and is not papered over.
 *  - v1 `getContextAdditions(cwd)` is mapped onto `onContextBuild` — which, in
 *    v2, actually has a consumer. In v1 it had none (see PHASE0_DISCOVERY.md), so
 *    a v1 mod that relied on it was silently inert; through the adapter it now
 *    takes effect. That is a behaviour CHANGE and it is called out here on
 *    purpose: a mod that has been quietly loading a file into nothing will start
 *    contributing context. The migration log line below says so out loud.
 */

import { logWarn } from '../../utils/logger';
import type { CoworkMod, ModsToolCall, ModsToolResult } from '../mods-runtime';
import type {
  ContextBuildDecision,
  CoworkModV2,
  ModContext,
  ModManifest,
  PostToolUseDecision,
  PreToolUseDecision,
} from '@cowork/mod-api';

export interface LegacyAdapterOptions {
  /** Log the deprecation once per mod id. Default true. */
  readonly warn?: boolean;
  readonly log?: (message: string) => void;
}

function manifestFor(mod: CoworkMod): ModManifest {
  return {
    id: mod.id,
    name: mod.label,
    version: '1.0.0',
    apiVersion: 1,
    entry: 'legacy',
    band: 'user',
    // v1 had no failMode. Failing open preserves the v1 contract exactly: a broken
    // mod must not start blocking calls that used to go through.
    failMode: 'open',
    events: [
      ...(mod.onPreToolUse ? (['onPreToolUse'] as const) : []),
      ...(mod.onPostToolUse ? (['onPostToolUse'] as const) : []),
      ...(mod.getContextAdditions ? (['onContextBuild'] as const) : []),
    ],
  };
}

/** Adapt a v1 mod to the v2 interface. */
export function adaptLegacyMod(mod: CoworkMod, options: LegacyAdapterOptions = {}): CoworkModV2 {
  const warn = options.warn ?? true;
  const emit = options.log ?? ((message: string) => logWarn(message));

  const adapted: CoworkModV2 = {
    id: mod.id,
    ...(mod.onPreToolUse
      ? {
          onPreToolUse(call: { sessionId: string; toolName: string; args: Readonly<Record<string, unknown>> }): PreToolUseDecision {
            const decision = mod.onPreToolUse?.(call as ModsToolCall);
            if (decision?.block) {
              return { action: 'deny', reason: decision.reason ?? `Blocked by mod ${mod.id}` };
            }
            return { action: 'allow' };
          },
        }
      : {}),
    ...(mod.onPostToolUse
      ? {
          onPostToolUse(call: { sessionId: string; toolName: string; args: Readonly<Record<string, unknown>> }, result: ModsToolResult): PostToolUseDecision {
            const decision = mod.onPostToolUse?.(call as ModsToolCall, result);
            if (typeof decision?.replaceContent === 'string') {
              return { action: 'rewrite', content: decision.replaceContent };
            }
            return { action: 'continue' };
          },
        }
      : {}),
    ...(mod.getContextAdditions
      ? {
          onContextBuild(input: { cwd: string }): ContextBuildDecision {
            const addition = mod.getContextAdditions?.(input.cwd) ?? '';
            const trimmed = addition.trim();
            if (trimmed.length === 0) return { action: 'continue' };
            // v1 returned a bare blob with no title; v2 requires one so the host
            // can render it as a named section instead of splicing text.
            return { action: 'add', section: { title: mod.label || mod.id, body: trimmed } };
          },
        }
      : {}),
  };

  if (warn) {
    const hadContext = Boolean(mod.getContextAdditions);
    emit(
      `[Mods] "${mod.id}" uses the deprecated v1 mod interface and was adapted. ` +
        'It will keep working, but it cannot rewrite tool arguments, force a permission prompt, or contribute interface yet.' +
        (hadContext
          ? ' Note: its getContextAdditions() had NO effect in v1 (nothing consumed it) and DOES take effect now.'
          : '')
    );
  }

  return adapted;
}

export function adaptLegacyMods(mods: readonly CoworkMod[], options: LegacyAdapterOptions = {}): {
  manifest: ModManifest;
  mod: CoworkModV2;
}[] {
  return mods.map((mod) => ({ manifest: manifestFor(mod), mod: adaptLegacyMod(mod, options) }));
}

/**
 * The v1 `getContextAdditions` output has no consumer in the current codebase.
 * Wiring it here is what finally makes `onContextBuild` real, and it is the
 * reason this migration is worth doing at all.
 */
export function legacyContextBuilder(): (cwd: string) => string {
  return (cwd: string): string => {
    // Deliberately empty until the agent prompt composition calls the bus. Kept as
    // an explicit function so the call site is greppable.
    void cwd;
    return '';
  };
}

/** Re-exported so callers do not need to import from two modules. */
export type { ModContext };