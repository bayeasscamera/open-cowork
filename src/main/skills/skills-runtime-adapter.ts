/**
 * @module main/skills/skills-runtime-adapter
 *
 * Makes the per-skill enable toggle authoritative for the agent.
 *
 * The resource loader is handed directories, not skills, so before this adapter
 * a skill switched off in the UI was still loaded: the toggle only mutated an
 * in-memory flag. The adapter expands the roots into the individual skill
 * directories and drops the disabled ones, which the loader treats exactly like
 * a root holding a single SKILL.md. Because the runner's skill signature is the
 * JSON of that list, toggling a skill also recreates the pi session so the
 * change takes effect on the next turn.
 *
 * Everything is injected so this module stays free of Electron imports and can
 * be unit-tested against temp directories.
 */

import type { SkillsAdapter } from './skills-adapter';
import type { SkillRuntimeSourceInput } from '../../shared/skill-runtime-types';
import { describeSkillRuntime, runtimeSkillDirs } from './skill-runtime-view';
import { logWarn } from '../utils/logger';

/** The slice of SkillsManager this adapter needs. */
export interface SkillEnabledLookup {
  getAllSkills(): Array<{ name: string; enabled: boolean }>;
}

export interface SkillsRuntimeAdapterOptions {
  /** Resolves the roots the agent scans. */
  resolveSources: () => SkillRuntimeSourceInput[];
  /** Supplies the app-level enabled flag per skill name. */
  lookup?: SkillEnabledLookup | null;
  /**
   * Used when discovery throws. Returning the raw roots keeps the agent working
   * (it may load a disabled skill) instead of silently losing every skill.
   */
  fallback?: () => string[];
}

export function createSkillsRuntimeAdapter(options: SkillsRuntimeAdapterOptions): SkillsAdapter {
  return {
    getSkillPaths(): string[] {
      try {
        const enabledByName = new Map<string, boolean>();
        const lookup = options.lookup;
        if (lookup) {
          for (const skill of lookup.getAllSkills()) {
            enabledByName.set(skill.name, skill.enabled);
          }
        }
        const view = describeSkillRuntime(
          options.resolveSources(),
          (name) => enabledByName.get(name) ?? true
        );
        return runtimeSkillDirs(view);
      } catch (error) {
        logWarn('[Skills] Runtime skill adapter failed; falling back to the root directories:', error);
        return options.fallback ? options.fallback() : [];
      }
    },
  };
}
