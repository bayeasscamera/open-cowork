/**
 * @module main/skills/skill-runtime-sources
 *
 * Resolves the root directories the pi resource loader is told to scan. This is
 * the shared answer to "where do skills come from?" — previously the agent
 * runner, the capability pane and the Skill doctor each had their own version,
 * so they could disagree about what the agent had loaded.
 */

import * as path from 'path';
import { getBuiltinSkillsPath, getConfiguredGlobalSkillsDir } from '../agent/skills-paths';
import type { SkillRuntimeSourceInput } from '../../shared/skill-runtime-types';
import type { PluginRuntimeService } from './plugin-runtime-service';
import { logWarn } from '../utils/logger';

/**
 * The synchronous roots the runner itself owns: built-in skills shipped with the
 * app, then the configured global skills directory. Order matters — the loader
 * keeps the first skill with a given name, so built-ins win a name collision.
 */
export function baseSkillSources(): SkillRuntimeSourceInput[] {
  const sources: SkillRuntimeSourceInput[] = [];
  const builtin = getBuiltinSkillsPath();
  if (builtin.length > 0) {
    sources.push({ root: builtin, kind: 'builtin' });
  }
  const global = getConfiguredGlobalSkillsDir();
  if (global.length > 0) {
    sources.push({ root: global, kind: 'global' });
  }
  return sources;
}

/**
 * Adds the skill directories contributed by enabled runtime plugins. Plugin
 * skills are gated by the plugin's own component flag, not by the per-skill
 * toggle, so they are reported with their own source kind.
 */
export async function resolveRuntimeSkillSources(
  pluginRuntimeService?: PluginRuntimeService | null
): Promise<SkillRuntimeSourceInput[]> {
  const sources = baseSkillSources();
  if (!pluginRuntimeService) {
    return sources;
  }
  try {
    for (const plugin of await pluginRuntimeService.getEnabledRuntimePlugins()) {
      if (!plugin.componentsEnabled.skills || plugin.componentCounts.skills <= 0) {
        continue;
      }
      sources.push({ root: path.join(plugin.runtimePath, 'skills'), kind: 'plugin' });
    }
  } catch (error) {
    logWarn('[Skills] Failed to resolve plugin skill roots:', error);
  }
  return sources;
}
