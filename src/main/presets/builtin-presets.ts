/**
 * @module main/presets/builtin-presets
 *
 * The three presets shipped with the app. They are DATA, defined in code
 * rather than read from disk so they cannot be edited, replaced or shadowed by
 * a user file — a user preset colliding with one of these ids is refused at
 * load time (see ./preset-loader.ts).
 *
 * `standard` is the default and is deliberately a no-op relative to the
 * behaviour that existed before presets: direct presentation, the truncation
 * threshold the app already used, and no forking. Enabling presets must not
 * change what an agent does unless the user picked a different preset.
 */

import { freezePreset, type AgentPreset } from './preset-schema';

/** The tool-result pruning threshold the app used before presets existed. */
export const LEGACY_PRUNE_THRESHOLD_CHARS = 500;

/** Full tool catalog exposed by default, matching the pre-preset behaviour. */
const DEFAULT_TOOL_ALLOW: string[] = [
  'bash',
  'edit',
  'glob',
  'grep',
  'ls',
  'multi_edit',
  'notebook_edit',
  'propose_preset',
  'read',
  'run_code',
  'task',
  'write',
];

export const STANDARD_PRESET: AgentPreset = freezePreset({
  id: 'standard',
  label: 'Standard',
  description:
    'Default agent: tools are presented directly and results are pruned at the historical threshold.',
  tools: { allow: [...DEFAULT_TOOL_ALLOW] },
  presentation: 'direct',
  pruner: {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  },
  delegation: { maxDepth: 2, allowFork: false, maxRounds: 16 },
});

export const CODE_MODE_PRESET: AgentPreset = freezePreset({
  id: 'code-mode',
  label: 'Code mode',
  description:
    'Tools are driven through a generated TypeScript SDK inside run_code. Opt-in: adds a code-execution step to every tool-using turn.',
  tools: { allow: [...DEFAULT_TOOL_ALLOW] },
  presentation: 'code',
  pruner: {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  },
  delegation: { maxDepth: 2, allowFork: false, maxRounds: 16 },
});

export const LONG_CONTEXT_PRESET: AgentPreset = freezePreset({
  id: 'long-context',
  label: 'Long context',
  description:
    'Keeps far more tool output. Requires a model with a very large context window; on a smaller model the turn will overflow upstream.',
  tools: { allow: [...DEFAULT_TOOL_ALLOW] },
  presentation: 'direct',
  pruner: {
    thresholdChars: 384000,
    headChars: 64000,
    tailChars: 64000,
  },
  delegation: { maxDepth: 2, allowFork: false, maxRounds: 16 },
});

/** Ids of the built-in presets, in presentation order. */
export const BUILTIN_PRESET_IDS = ['standard', 'code-mode', 'long-context'] as const;

export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number];

const BY_ID = new Map<string, AgentPreset>([
  [STANDARD_PRESET.id, STANDARD_PRESET],
  [CODE_MODE_PRESET.id, CODE_MODE_PRESET],
  [LONG_CONTEXT_PRESET.id, LONG_CONTEXT_PRESET],
]);

export function getBuiltinPreset(id: string | null | undefined): AgentPreset | undefined {
  if (!id) return undefined;
  return BY_ID.get(id);
}

export function isBuiltinPresetId(id: string): id is BuiltinPresetId {
  return BY_ID.has(id);
}

export function listBuiltinPresets(): AgentPreset[] {
  return [...BY_ID.values()];
}

/** The id used when nothing is selected. Never null at the point of use. */
export const DEFAULT_PRESET_ID = STANDARD_PRESET.id;
