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

/**
 * Full tool catalog exposed by default, matching the pre-preset behaviour.
 *
 * Only tools that actually exist are listed. `run_code` (code mode) and
 * `propose_preset` are deliberately ABSENT: they are opt-in capabilities added
 * later, and listing a tool that is not registered would make the preset fail
 * validation against the real registry — or worse, advertise a capability to
 * the model that does not exist.
 */
const DEFAULT_TOOL_ALLOW: string[] = [
  'bash',
  'edit',
  'glob',
  'grep',
  'ls',
  'multi_edit',
  'notebook_edit',
  'read',
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
  // `run_code` is the ONE difference from the standard preset, and it is the
  // only tool in the codebase that evaluates model-written code. It is listed
  // here and nowhere else: `standard` deliberately omits it, so the entire code
  // path is unreachable unless a user explicitly pins this preset.
  //
  // Enabling it was the last step on purpose. It was only safe once the SDK
  // hook actually received the allow-list and the path-guard — the pipeline
  // skips a stage whose deps are undefined, so before that fix a call made from
  // code would have been preset-gated while a direct call was not.
  tools: { allow: [...DEFAULT_TOOL_ALLOW, 'run_code'] },
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

/**
 * Frontend craft preset — activates the impeccable design skill persona.
 *
 * The `impeccable` skill is already available in the built-in skills path
 * (.claude/skills/impeccable/). This preset primes the agent's system prompt
 * with an expert design-director persona so every UI edit goes through
 * craft-floor checks and follows the Impeccable design vocabulary.
 *
 * No `skills.extraDirs` is needed because the skill lives in the shared
 * built-in skills directory loaded by every session.
 */
export const FRONTEND_CRAFT_PRESET: AgentPreset = freezePreset({
  id: 'frontend-craft',
  label: 'Frontend craft',
  description:
    'Design-director mode: activates the Impeccable skill, enforces craft-floor quality checks on every UI edit.',
  persona: {
    prefix:
      'You are operating in frontend-craft mode. The Impeccable design skill is active. ' +
      'Approach every UI task as an award-winning design director: complete deliverables, ' +
      'no hedging, no placeholders. Before any edit load reference/craft-floor.md from the ' +
      'impeccable skill. Run the impeccable context script once per session when available.',
  },
  tools: { allow: [...DEFAULT_TOOL_ALLOW] },
  presentation: 'direct',
  pruner: {
    thresholdChars: 8192,
    headChars: 4096,
    tailChars: 1024,
  },
  delegation: { maxDepth: 2, allowFork: false, maxRounds: 16 },
});

/** Ids of the built-in presets, in presentation order. */
export const BUILTIN_PRESET_IDS = ['standard', 'code-mode', 'long-context', 'frontend-craft'] as const;

export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number];

const BY_ID = new Map<string, AgentPreset>([
  [STANDARD_PRESET.id, STANDARD_PRESET],
  [CODE_MODE_PRESET.id, CODE_MODE_PRESET],
  [LONG_CONTEXT_PRESET.id, LONG_CONTEXT_PRESET],
  [FRONTEND_CRAFT_PRESET.id, FRONTEND_CRAFT_PRESET],
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
