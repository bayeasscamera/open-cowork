/**
 * @module shared/skill-runtime-types
 *
 * The IPC-facing shape of "which skills will the agent actually load?". It
 * lives in shared/ because the preload bridge must describe the payload without
 * importing anything from the main process.
 *
 * This is deliberately NOT the same question as "which skills are installed?":
 * the pi resource loader is given directories, scans them recursively and skips
 * dot-directories, so the answer depends on the roots and on what sits under
 * them right now.
 */

export type SkillRuntimeSourceKind = 'builtin' | 'global' | 'plugin';

/** A root directory the agent is told to scan, plus where it came from. */
export interface SkillRuntimeSourceInput {
  root: string;
  kind: SkillRuntimeSourceKind;
}

export interface RuntimeSkillEntry {
  name: string;
  description?: string;
  /** Absolute path of the skill directory (the one holding SKILL.md). */
  path: string;
  /** False when the app has this skill switched off, so it is not handed to the loader. */
  enabled: boolean;
}

export interface RuntimeSkillSource {
  root: string;
  kind: SkillRuntimeSourceKind;
  skills: RuntimeSkillEntry[];
}

export interface RuntimeSkillView {
  sources: RuntimeSkillSource[];
  /** Skills the loader will actually register. */
  loaded: number;
  /** Skills found on disk but withheld from the loader. */
  disabled: number;
}

export interface SkillRuntimeReport {
  success: boolean;
  view?: RuntimeSkillView;
  error?: string;
}
