/**
 * @module main/presets/preset-schema
 *
 * An agent preset is pure DATA describing what an agent may do and how its
 * output is shaped. It is never code: loading a preset must not require
 * evaluating anything, which is why the schema is a strict structural
 * validator over a plain JSON document (Zod) rather than a factory.
 *
 * Strictness is the point. Unknown keys are REJECTED rather than ignored, so a
 * typo (`maxDepht`) fails loudly instead of silently leaving the field at its
 * default — a preset that appears to configure something it does not is worse
 * than one that refuses to load.
 */

import { z } from 'zod';

/** Hard global cap on delegation depth. Not configurable per preset. */
export const MAX_PRESET_DELEGATION_DEPTH = 2;
/** Hard cap on correction rounds in a delegation loop. */
export const MAX_PRESET_DELEGATION_ROUNDS = 64;

/** A tool name in a preset must be a registry-legal identifier. */
const TOOL_NAME = /^[a-z][a-z0-9_]*$/;
/** Preset ids are used as directory names, so they stay filesystem-safe. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

const personaSchema = z
  .object({
    prefix: z.string().min(1).max(4000).optional(),
    suffix: z.string().min(1).max(4000).optional(),
  })
  .strict();

const prunerSchema = z
  .object({
    thresholdChars: z.number().int().positive().max(20_000_000),
    headChars: z.number().int().min(0).max(2_000_000),
    tailChars: z.number().int().min(0).max(2_000_000),
    /**
     * Tool-result size above which the compaction pass replaces the content
     * with a placeholder. Optional and absent by default, because the
     * pre-existing value (500) is what the app has always used: leaving it
     * unset is what makes `standard` a true no-op. Raising it keeps more
     * verbatim output at the cost of a more expensive summarization.
     */
    compactionThresholdChars: z.number().int().positive().max(2_000_000).optional(),
  })
  .strict()
  // A threshold at or below head+tail would mean "truncate" produces something
  // as long as (or longer than) the input, which is nonsense rather than a
  // preference. Enforced structurally so no caller can construct one.
  .refine((p) => p.headChars + p.tailChars < p.thresholdChars, {
    message:
      'pruner.headChars + pruner.tailChars must be strictly less than pruner.thresholdChars, otherwise truncation would not shorten anything.',
  });

const delegationSchema = z
  .object({
    maxDepth: z.number().int().min(0).max(MAX_PRESET_DELEGATION_DEPTH),
    allowFork: z.boolean(),
    maxRounds: z.number().int().positive().max(MAX_PRESET_DELEGATION_ROUNDS).optional(),
  })
  .strict();

const toolsSchema = z
  .object({
    // A concrete subset only. '*' is explicitly not accepted: a wildcard would
    // make "which tools may this agent use" unanswerable, which is the one
    // question a preset exists to answer.
    allow: z.array(z.string().regex(TOOL_NAME, 'Tool names must be lowercase snake_case.')),
  })
  .strict();

const skillsSchema = z
  .object({
    // Relative to the preset's own directory; `..` is rejected at validation
    // time by refineExtraDirs below, not trusted here.
    extraDirs: z.array(z.string().min(1)),
  })
  .strict();

const modelHintSchema = z
  .object({
    configSetId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  })
  .strict();

export const agentPresetSchema = z
  .object({
    id: z.string().regex(PRESET_ID, 'Preset id must be [a-z0-9-] and start alphanumeric.'),
    label: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    persona: personaSchema.optional(),
    tools: toolsSchema,
    presentation: z.enum(['direct', 'code']).default('direct'),
    pruner: prunerSchema,
    delegation: delegationSchema,
    skills: skillsSchema.optional(),
    modelHint: modelHintSchema.optional(),
  })
  .strict();

export type AgentPreset = z.infer<typeof agentPresetSchema>;

export interface PresetValidationOk {
  ok: true;
  preset: AgentPreset;
}

export interface PresetValidationError {
  ok: false;
  /** Human-readable, one line per problem. Safe to show in the UI. */
  errors: string[];
}

export type PresetValidationResult = PresetValidationOk | PresetValidationError;

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/** An extraDir must stay inside the preset directory. */
function validateExtraDirs(preset: AgentPreset): string[] {
  const errors: string[] = [];
  for (const dir of preset.skills?.extraDirs ?? []) {
    const normalized = dir.replace(/\\/g, '/').trim();
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
      errors.push(
        `skills.extraDirs: '${dir}' must be relative to the preset directory, not an absolute path.`
      );
      continue;
    }
    const segments = normalized.split('/');
    if (segments.includes('..')) {
      errors.push(`skills.extraDirs: '${dir}' must not escape the preset directory ('..').`);
    }
  }
  return errors;
}

/**
 * Validate an unknown value as a preset.
 *
 * On top of the structural schema this enforces the rules that need context
 * the schema cannot express: tool names must exist in the registry, and a
 * `code` presentation or `allowFork` must be opted into explicitly (checked by
 * the caller via `requireExplicitConsent`).
 */
export function validateAgentPreset(
  input: unknown,
  options: { knownTools?: readonly string[] } = {}
): PresetValidationResult {
  const parsed = agentPresetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: formatIssues(parsed.error) };
  }
  const preset = parsed.data;

  const errors = validateExtraDirs(preset);

  if (options.knownTools) {
    const known = new Set(options.knownTools);
    // A preset naming a tool that does not exist is refused rather than
    // silently filtered: the author meant to grant something real.
    for (const name of preset.tools.allow) {
      if (!known.has(name)) {
        errors.push(`tools.allow: '${name}' is not a registered tool.`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Duplicate tool names are deduped, not rejected: repeating a name in an
  // allow-list is harmless and a hand-edited file will do it.
  const deduped: AgentPreset = {
    ...preset,
    tools: { allow: [...new Set(preset.tools.allow)].sort() },
  };
  return { ok: true, preset: deduped };
}

/**
 * A preset that enables `code` presentation or sub-agent forking changes what
 * the agent can do in ways the user must see before it is used. Returns the
 * reasons consent is required, empty when it is an ordinary preset.
 */
export function presetConsentReasons(preset: AgentPreset): string[] {
  const reasons: string[] = [];
  if (preset.presentation === 'code') {
    reasons.push('code mode: tools are driven through generated code instead of direct calls.');
  }
  if (preset.delegation.allowFork) {
    reasons.push('fork delegation: sub-tasks inherit the parent model and conversation.');
  }
  return reasons;
}

/** Deep-freeze so a resolved preset cannot be mutated by a later caller. */
export function freezePreset(preset: AgentPreset): AgentPreset {
  return Object.freeze({
    ...preset,
    tools: Object.freeze({ allow: Object.freeze([...preset.tools.allow]) }) as AgentPreset['tools'],
    pruner: Object.freeze({ ...preset.pruner }),
    delegation: Object.freeze({ ...preset.delegation }),
  });
}
