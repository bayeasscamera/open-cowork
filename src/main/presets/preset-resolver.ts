/**
 * @module main/presets/preset-resolver
 *
 * THE resolution order. This is the one place that answers "which preset is
 * this session using, and why", and it is documented here rather than spread
 * across call sites.
 *
 * Sub-agent:
 *   1. criticality (per-task override)
 *   2. perRole override
 *   3. THE PRESET (project pin, then session override, then default)
 *   4. the sub-agent ConfigSet
 *   5. the inherited active profile
 *
 * The preset layer is inserted immediately before the sub-agent ConfigSet and
 * changes nothing above it: criticality and perRole keep winning exactly as
 * before, because a preset describes a *kind* of agent, not a task.
 *
 * Direct session:
 *   1. the project pin (preset_id)
 *   2. the session override
 *   3. `standard`
 *
 * Note the model and the preset are resolved INDEPENDENTLY on purpose. A
 * preset may carry a `modelHint`, but an explicit project/session ConfigSet
 * pin is a human decision about the model and is not overridden by a preset.
 */

import {
  DEFAULT_PRESET_ID,
  getBuiltinPreset,
} from './builtin-presets';
import { findPreset, type LoadedPresets } from './preset-loader';
import type { AgentPreset } from './preset-schema';
import { logWarn } from '../utils/logger';

/** Where a resolved preset came from, for the UI and for honest logging. */
export type PresetSource =
  | 'criticality'
  | 'perRole'
  | 'session'
  | 'project'
  | 'default'
  | 'unknown-id';

export interface ResolvedPreset {
  preset: AgentPreset;
  source: PresetSource;
  /** Set when an id was pinned but not found; the default is used instead. */
  warning?: string;
}

/** Inputs for resolving a preset for any session. */
export interface ResolvePresetInput {
  /** Preset id pinned on the project (projects.preset_id). */
  projectPresetId?: string | null;
  /** Preset id overridden on the session, if any. */
  sessionPresetId?: string | null;
  /** Sub-agent criticality override, if this is a delegated task. */
  criticalityPresetId?: string | null;
  /** Sub-agent per-role override, if this is a delegated task. */
  perRolePresetId?: string | null;
  /** Everything loadable. */
  loaded: LoadedPresets;
}

function standard(): AgentPreset {
  // The default is a built-in, so this lookup cannot fail; the guard is only
  // to keep the return type honest if that invariant is ever broken.
  return getBuiltinPreset(DEFAULT_PRESET_ID)!;
}

function pick(
  id: string | null | undefined,
  source: PresetSource,
  loaded: LoadedPresets
): ResolvedPreset | null {
  if (!id) return null;
  const found = findPreset(id, loaded);
  if (found) return { preset: found, source };
  return {
    preset: standard(),
    source: 'unknown-id',
    warning: `Preset '${id}' is not available; using '${DEFAULT_PRESET_ID}' instead.`,
  };
}

/**
 * Resolve the active preset for a session.
 *
 * An id that is pinned but not loadable degrades to `standard` WITH a warning
 * rather than throwing: a missing preset must not stop a session from running,
 * and the fallback is the behaviour the user had before presets existed.
 */
export function resolvePreset(input: ResolvePresetInput): ResolvedPreset {
  // Sub-agent chain: criticality → perRole → preset.
  const subAgent =
    pick(input.criticalityPresetId, 'criticality', input.loaded) ??
    pick(input.perRolePresetId, 'perRole', input.loaded);
  if (subAgent) {
    if (subAgent.warning) logWarn(`[Presets] ${subAgent.warning}`);
    return subAgent;
  }

  // Direct session chain: project pin → session override → default.
  const pinned = pick(input.sessionPresetId, 'session', input.loaded) ?? pick(input.projectPresetId, 'project', input.loaded);
  if (pinned) {
    if (pinned.warning) logWarn(`[Presets] ${pinned.warning}`);
    return pinned;
  }

  return { preset: standard(), source: 'default' };
}

/**
 * Model hint contributed by the preset, if any.
 *
 * Returned separately from the preset itself so a caller can apply it only
 * when no explicit ConfigSet pin exists — the preset must not override a human
 * decision about the model.
 */
export function modelHintFor(preset: AgentPreset): { configSetId?: string; modelId?: string } {
  return preset.modelHint ?? {};
}
