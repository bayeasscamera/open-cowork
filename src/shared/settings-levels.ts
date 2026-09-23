/**
 * @module shared/settings-levels
 *
 * Three-level settings resolution: GLOBAL → PROJECT → SESSION.
 *
 * The app can be told which provider/model to use at three different scopes.
 * Before this module the ladder only existed implicitly, buried in the agent
 * runner: a project could pin a ConfigSet, otherwise the globally active set
 * won, and a session had no say at all. Two consequences were visible to users:
 * a pinned model without a pinned ConfigSet was silently ignored, and the UI
 * could not explain why a given model was in effect.
 *
 * This module makes the ladder explicit and pure so that:
 *   - the main process and the renderer share ONE precedence rule (no drift),
 *   - every resolution carries its provenance (session overrode the project),
 *   - an unusable level (unknown ConfigSet) degrades with a warning instead of
 *     silently changing the provider underneath the user.
 *
 * Precedence rules (later level wins):
 *   1. ConfigSet — the highest level that pins a KNOWN set id. A level that
 *      pins an unknown id is ignored entirely (set AND model), so a stale id
 *      can never mix a model from one provider with the credentials of another.
 *   2. Model    — the highest level that pins a model id, applied INSIDE the
 *      effective set. When no level pins one, the set own model is used.
 *
 * Nothing here knows about API keys: a resolution only ever names a ConfigSet
 * and a model, and it never reads or copies credentials.
 */

/** A scope a setting can be pinned at. Ordered from lowest to highest priority. */
export type SettingsLevel = 'global' | 'project' | 'session';

/** Lowest to highest precedence. Also the display order of the ladder. */
export const SETTINGS_LEVELS: readonly SettingsLevel[] = ['global', 'project', 'session'];

/** A profile reduced to the fields a resolution needs. */
export interface SettingsProfileLike {
  model?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * A ConfigSet reduced to a structural shape. Deliberately loose: the main
 * process and the renderer each declare their own richer ApiConfigSet, and both
 * must be accepted without importing either declaration here.
 */
export interface SettingsConfigSetLike {
  id: string;
  name?: string;
  provider?: string;
  activeProfileKey?: string;
  profiles?: Partial<Record<string, SettingsProfileLike>>;
}

/** A ConfigSet flattened to exactly what the ladder decides and displays. */
export interface ConfigSetSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** What one level pins. Absent or null means "inherit the level below". */
export interface SettingsBinding {
  configSetId?: string | null;
  /** Model pinned INSIDE the effective set (absent = the set own model). */
  modelId?: string | null;
}

export interface SettingsResolutionInput {
  global: {
    activeConfigSetId: string;
    configSets: readonly SettingsConfigSetLike[];
  };
  project?: ({ id: string; name: string } & SettingsBinding) | null;
  session?: SettingsBinding | null;
}

export type SettingsWarningCode = 'unknown-config-set' | 'no-config-set';

/** A non-fatal problem worth surfacing instead of silently ignoring. */
export interface SettingsWarning {
  code: SettingsWarningCode;
  level: SettingsLevel;
  /** The offending raw value (a ConfigSet id — never a secret). */
  value?: string;
}

/** What one level contributes to the final decision. */
export interface SettingsLevelState {
  level: SettingsLevel;
  /** Set id this level pins after normalization (null = inherits). */
  configSetId: string | null;
  /** Model id this level pins after normalization (null = inherits). */
  modelId: string | null;
  /** True when this level supplied the effective ConfigSet. */
  decidesConfigSet: boolean;
  /** True when this level supplied the effective model. */
  decidesModel: boolean;
  /** True when the level pinned a set id that does not exist (binding ignored). */
  ignored: boolean;
}

export interface EffectiveSettings {
  /** ConfigSet that will actually be projected. Empty only when none exists. */
  configSetId: string;
  configSetName: string;
  provider: string;
  model: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Level that supplied the ConfigSet. */
  configSetLevel: SettingsLevel;
  /** Level that supplied the model (the ConfigSet level when nothing pins one). */
  modelLevel: SettingsLevel;
  /** True when a project or session pinned a ConfigSet (disables adaptive routing). */
  hasExplicitConfigSet: boolean;
  /** True when a project or session pinned a model (disables adaptive routing). */
  hasExplicitModel: boolean;
  /** One entry per level, lowest precedence first. */
  levels: SettingsLevelState[];
  warnings: SettingsWarning[];
}

/** Trim a candidate id; anything that is not a non-empty string is "unset". */
function normalizeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

/**
 * Flatten a ConfigSet to the profile its active profile key points at.
 * Falls back to the first declared profile so a half-migrated set still
 * resolves to something displayable rather than an empty model.
 */
export function summarizeConfigSet(set: SettingsConfigSetLike): ConfigSetSummary {
  const profiles = set.profiles ?? {};
  const keys = Object.keys(profiles);
  const preferred = normalizeId(set.activeProfileKey);
  const active =
    (preferred ? profiles[preferred] : undefined) ?? (keys.length ? profiles[keys[0]] : undefined);
  return {
    id: String(set.id),
    name: set.name?.trim() || String(set.id),
    provider: set.provider ?? '',
    model: active?.model ?? '',
    baseUrl: active?.baseUrl,
    contextWindow: active?.contextWindow,
    maxTokens: active?.maxTokens,
  };
}

/**
 * Resolve the effective settings for one session.
 *
 * Pure: same input, same output, no I/O. The caller supplies the global config,
 * the session project (if any) and the session own binding.
 */
export function resolveSettingsLadder(input: SettingsResolutionInput): EffectiveSettings {
  const warnings: SettingsWarning[] = [];
  const summaries = new Map<string, ConfigSetSummary>();
  for (const set of input.global.configSets) {
    const summary = summarizeConfigSet(set);
    summaries.set(summary.id, summary);
  }

  const pinned: Record<SettingsLevel, { configSetId: string | null; modelId: string | null }> = {
    global: { configSetId: null, modelId: null },
    project: { configSetId: null, modelId: null },
    session: { configSetId: null, modelId: null },
  };
  const ignoredLevels = new Set<SettingsLevel>();

  // Global: the configured active set, with the same first-set fallback the
  // config store applies when the active id no longer resolves.
  const requestedGlobal = normalizeId(input.global.activeConfigSetId);
  if (requestedGlobal && summaries.has(requestedGlobal)) {
    pinned.global.configSetId = requestedGlobal;
  } else if (input.global.configSets.length > 0) {
    pinned.global.configSetId = summaries.get(String(input.global.configSets[0].id))?.id ?? null;
    if (requestedGlobal) {
      warnings.push({ code: 'unknown-config-set', level: 'global', value: requestedGlobal });
    }
  } else {
    warnings.push({ code: 'no-config-set', level: 'global' });
  }

  // Project, then session: a higher level only overrides when its set id is
  // known; an unknown id drops that level whole binding (set AND model).
  const higher: Array<{ level: SettingsLevel; binding?: SettingsBinding | null }> = [
    { level: 'project', binding: input.project },
    { level: 'session', binding: input.session },
  ];
  for (const { level, binding } of higher) {
    if (!binding) continue;
    const setId = normalizeId(binding.configSetId);
    const modelId = normalizeId(binding.modelId);
    if (setId && !summaries.has(setId)) {
      warnings.push({ code: 'unknown-config-set', level, value: setId });
      ignoredLevels.add(level);
      continue;
    }
    pinned[level] = { configSetId: setId, modelId };
  }

  // Fold the ladder, lowest precedence first.
  let configSetLevel: SettingsLevel = 'global';
  let effectiveSetId = pinned.global.configSetId;
  let modelLevel: SettingsLevel = 'global';
  let effectiveModelId: string | null = null;
  for (const level of SETTINGS_LEVELS) {
    if (level !== 'global' && pinned[level].configSetId) {
      configSetLevel = level;
      effectiveSetId = pinned[level].configSetId;
    }
    if (pinned[level].modelId) {
      modelLevel = level;
      effectiveModelId = pinned[level].modelId;
    }
  }
  // A pinned model is only meaningful together with a set; with nothing
  // configured at all the pin cannot be projected.
  if (!effectiveSetId) {
    effectiveModelId = null;
    modelLevel = configSetLevel;
  } else if (!effectiveModelId) {
    modelLevel = configSetLevel;
  }

  const summary = effectiveSetId ? summaries.get(effectiveSetId) : undefined;

  const levels: SettingsLevelState[] = SETTINGS_LEVELS.map((level) => ({
    level,
    configSetId: ignoredLevels.has(level) ? null : pinned[level].configSetId,
    modelId: ignoredLevels.has(level) ? null : pinned[level].modelId,
    decidesConfigSet: Boolean(effectiveSetId) && level === configSetLevel,
    decidesModel: level === modelLevel && Boolean(effectiveSetId),
    ignored: ignoredLevels.has(level),
  }));

  return {
    configSetId: effectiveSetId ?? '',
    configSetName: summary?.name ?? '',
    provider: summary?.provider ?? '',
    model: effectiveModelId ?? summary?.model ?? '',
    baseUrl: summary?.baseUrl,
    contextWindow: summary?.contextWindow,
    maxTokens: summary?.maxTokens,
    configSetLevel,
    modelLevel,
    hasExplicitConfigSet: configSetLevel !== 'global',
    hasExplicitModel: modelLevel !== 'global' && effectiveModelId !== null,
    levels,
    warnings,
  };
}
