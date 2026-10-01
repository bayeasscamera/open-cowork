/**
 * @module main/skills/skill-selection-runtime
 *
 * The bridge between "which skills exist?" and "which skills does this task
 * need?", for the three delegated-task paths.
 *
 * Those paths — workflow tasks, swarm agents and the sub-agent extension — used
 * to build their `DefaultResourceLoader` without `additionalSkillPaths` and
 * therefore received no skills at all. Fixing that per-call-site would have
 * meant repeating the discovery + toggle-filtering logic three more times, and
 * the main agent already had its own version, so the four could drift.
 *
 * Instead the discovery happens once here and every path — main agent included —
 * reads the same answer. The provider is registered at startup by index.ts,
 * where SkillsManager is constructed; until then calls degrade to "no skills",
 * which is what headless startup used to produce anyway.
 *
 * Deliberately not an Electron singleton with module-level mutable state read
 * from a constructor argument: the runners take their collaborators by
 * injection, and a setter keeps that contract instead of reaching for an
 * import-time global.
 */

import { describeSkillRuntime } from './skill-runtime-view';
import { baseSkillSources } from './skill-runtime-sources';
import type { RuntimeSkillEntry } from '../../shared/skill-runtime-types';
import type { SkillEnabledLookup } from './skills-runtime-adapter';

/** The slice of SkillsManager needed to honour the per-skill enable toggle. */
export type SkillEnabledSource = SkillEnabledLookup | null | undefined;

let lookup: SkillEnabledSource = null;

/**
 * Register the skills manager. Called once during startup, before any task can
 * be dispatched. A later call replaces the earlier one (tests, headless reload).
 */
export function setSkillEnabledLookup(next: SkillEnabledSource): void {
  lookup = next;
}

/**
 * Every skill the loader could use right now: discovered on disk, with the
 * per-skill toggle already applied. Returns an empty list rather than throwing
 * when nothing is registered — a task without skills still runs.
 */
export function currentRuntimeSkills(): RuntimeSkillEntry[] {
  try {
    const enabledByName = new Map<string, boolean>();
    if (lookup) {
      for (const skill of lookup.getAllSkills()) {
        enabledByName.set(skill.name, skill.enabled);
      }
    }
    const view = describeSkillRuntime(baseSkillSources(), (name) => enabledByName.get(name) ?? true);
    return view.sources.flatMap((source) => source.skills);
  } catch {
    // Discovery is best-effort: a missing root or an unreadable SKILL.md must
    // degrade to "no skills", never take the task down with it.
    return [];
  }
}
