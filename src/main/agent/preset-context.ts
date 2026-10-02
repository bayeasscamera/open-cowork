/**
 * @module main/agent/preset-context
 *
 * Per-session resolution of the active agent preset, plus the extra skill
 * directories it contributes.
 *
 * Kept separate from the runner so the whole "which preset, which skills, what
 * pruner" answer is one pure-ish function that a test can call without an agent
 * session. The runner then does exactly one thing with the result.
 */

import * as fs from 'fs';

import { loadPresets, resolveExtraDirs, type LoadedPresets } from '../presets/preset-loader';
import { resolvePreset, type ResolvedPreset } from '../presets/preset-resolver';
import { presetsRoot } from '../presets/preset-loader';
import type { AgentPreset } from '../presets/preset-schema';
import { log } from '../utils/logger';

export interface ActivePresetContext {
  preset: AgentPreset;
  source: ResolvedPreset['source'];
  warning?: string;
  /** Extra skill directories, already proven to stay inside the preset dir. */
  extraSkillDirs: string[];
}

/**
 * Resolve the preset for a session and collect its skill directories.
 *
 * `sessionSkillDirs` are the directories the session already discovered. The
 * preset's own directories are ADDED to that set rather than replacing it, and
 * the result is de-duplicated against it: a preset that re-declares
 * `.claude/skills` must not cause a skill to be scanned twice, which is the
 * duplicate the startup sweep already had to fix.
 */
export function resolveActivePreset(input: {
  projectPresetId?: string | null;
  sessionPresetId?: string | null;
  criticalityPresetId?: string | null;
  perRolePresetId?: string | null;
  /** Skill directories the session already resolved. */
  sessionSkillDirs?: readonly string[];
  /** Pre-loaded catalog, to avoid re-reading disk in tests. */
  loaded?: LoadedPresets;
}): ActivePresetContext {
  const loaded = input.loaded ?? loadPresets();
  const resolved = resolvePreset({
    projectPresetId: input.projectPresetId,
    sessionPresetId: input.sessionPresetId,
    criticalityPresetId: input.criticalityPresetId,
    perRolePresetId: input.perRolePresetId,
    loaded,
  });

  const extraSkillDirs: string[] = [];
  const declared = input.loaded ? [] : resolved.preset.skills?.extraDirs ?? [];
  if (declared.length > 0) {
    const root = presetsRoot();
    if (root) {
      // The loader already proved these are inside the preset directory; the
      // re-check here is what turns the relative declaration into an absolute
      // path for this session only.
      const dir = `${root}/${resolved.preset.id}`;
      const { safe, errors } = resolveExtraDirs(dir, declared);
      if (errors.length > 0) {
        log(
          `[Presets] Preset '${resolved.preset.id}' extraDirs refused: ${errors.join('; ')}`
        );
      }
      for (const candidate of safe) {
        try {
          if (fs.existsSync(candidate)) extraSkillDirs.push(candidate);
        } catch {
          // An unreadable declared directory is skipped, never fatal.
        }
      }
    }
  }

  // De-duplicate against what the session already found, so a preset cannot
  // cause the same skill directory to be scanned twice. Comparison is on the
  // REAL path: a session may have discovered the directory under a symlinked
  // prefix (e.g. /var vs /private/var on macOS) while the preset resolves it
  // through realpath, and a string compare would miss that.
  const existing = new Set(
    (input.sessionSkillDirs ?? []).map((d) => {
      try {
        return fs.realpathSync(d).replace(/\/+$/, '');
      } catch {
        return d.replace(/\/+$/, '');
      }
    })
  );
  const deduplicated = extraSkillDirs.filter((d) => !existing.has(d.replace(/\/+$/, '')));

  return {
    preset: resolved.preset,
    source: resolved.source,
    ...(resolved.warning ? { warning: resolved.warning } : {}),
    extraSkillDirs: deduplicated,
  };
}
