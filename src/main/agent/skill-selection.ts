/**
 * @module main/agent/skill-selection
 *
 * Chooses which skills a delegated task should see, instead of handing every
 * sub-agent the full list.
 *
 * Why this exists: the three task paths (workflow tasks, swarm agents, the
 * sub-agent extension) built their `DefaultResourceLoader` WITHOUT
 * `additionalSkillPaths`, so they received no skills at all — silently, with no
 * warning. Wiring the loader to the main agent's list would have fixed the
 * omission but created the opposite problem: a task whose prompt is three lines
 * long ("run the test suite") would carry the descriptions of every installed
 * skill into its context, and the model would have to sift them.
 *
 * So a task gets a *budgeted* set: the enabled skills whose name or description
 * best matches the task text, plus a floor so a task never ends up with nothing.
 * Relevance is a keyword/lexical match on purpose — it must be deterministic,
 * free, and explainable in a log line. A task about PDFs must pick the PDF
 * skill without an LLM call to decide it.
 *
 * Pure by design: no Electron, no filesystem. The caller passes the skills it
 * already discovered.
 */

import type { RuntimeSkillEntry } from '../../shared/skill-runtime-types';

/** Words too common to carry signal; matching them would match every task. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do',
  'for', 'from', 'has', 'have', 'how', 'in', 'into', 'is', 'it', 'its', 'make',
  'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'out', 'run', 'so', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'use',
  'using', 'was', 'we', 'were', 'what', 'when', 'which', 'with', 'you', 'your',
]);

/**
 * A skill directory name is often kebab-case and sometimes namespaced
 * (`pdf-tools/pdf`). Both parts must be able to match, and multi-word names must
 * not require the exact phrase to appear.
 */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

/**
 * Score one skill against the task text.
 *
 * Name matches weigh more than description matches: the name is the short,
 * deliberate label the skill author chose, while descriptions are prose that
 * often shares vocabulary with unrelated skills. Returns 0 for no signal.
 */
function scoreSkill(skill: RuntimeSkillEntry, taskTokens: Set<string>): number {
  const nameTokens = tokenize(skill.name);
  const descriptionTokens = new Set(tokenize(skill.description ?? ''));
  let score = 0;

  for (const token of nameTokens) {
    if (taskTokens.has(token)) {
      score += 3;
    }
  }
  for (const token of descriptionTokens) {
    if (taskTokens.has(token)) {
      score += 1;
    }
  }

  // A skill whose name appears as a whole phrase in the task is almost
  // certainly the intended one — e.g. "pdf" inside "extract the pdf".
  const normalizedTask = taskTokens.size > 0;
  if (normalizedTask && nameTokens.length > 0 && skill.name.trim().toLowerCase().length > 2) {
    score += 0.5;
  }

  return score;
}

export interface SkillSelectionOptions {
  /**
   * How many skills a task may see. Small on purpose: a task prompt is short,
   * and the point is to hand the sub-agent a few strong hints, not a catalogue.
   */
  maxSkills?: number;
  /**
   * Minimum score for a skill to be selected on its own merit. When nothing
   * clears the bar the top `maxSkills` skills are still returned — a task with
   * zero skills is strictly worse than one with a possibly-irrelevant few, since
   * the loader's cost is one description per entry.
   */
  minScore?: number;
}

const DEFAULT_MAX_SKILLS = 5;
const DEFAULT_MIN_SCORE = 1;

/**
 * Rank the enabled skills against a task and return the most relevant ones.
 *
 * Disabled skills are always excluded: the per-skill toggle is a user decision
 * and must hold on every path, not only in the main agent. Ties break on name so
 * the result is stable across runs — an unstable selection would make the same
 * task load different skills on each retry, which is impossible to debug.
 */
export function selectRelevantSkills(
  taskText: string,
  skills: readonly RuntimeSkillEntry[],
  options: SkillSelectionOptions = {}
): RuntimeSkillEntry[] {
  const maxSkills = options.maxSkills ?? DEFAULT_MAX_SKILLS;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  if (maxSkills <= 0) {
    return [];
  }

  const enabled = skills.filter((skill) => skill.enabled);
  if (enabled.length === 0) {
    return [];
  }

  const taskTokens = new Set(tokenize(taskText));
  const scored = enabled
    .map((skill) => ({ skill, score: scoreSkill(skill, taskTokens) }))
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  const relevant = scored.filter((entry) => entry.score >= minScore).slice(0, maxSkills);

  if (relevant.length > 0) {
    return relevant.map((entry) => entry.skill);
  }

  // No lexical signal. Fall back to the first `maxSkills` enabled skills, in the
  // same stable order, so a short or non-English task still gets the skill list.
  return scored.slice(0, maxSkills).map((entry) => entry.skill);
}

/** The absolute directories to hand to the resource loader, in selection order. */
export function skillSelectionDirs(skills: readonly RuntimeSkillEntry[]): string[] {
  return skills.map((skill) => skill.path);
}

/**
 * One-line summary for the task system prompt, so the sub-agent knows skills
 * are available before it decides not to look. Without this the loader entries
 * sit unused: the model has no signal that a relevant capability exists.
 */
export function formatSkillHint(skills: readonly RuntimeSkillEntry[]): string {
  if (skills.length === 0) {
    return '';
  }
  const lines = skills.map((skill) => {
    const description = skill.description?.trim();
    return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
  });
  return [
    '<available_skills>',
    'Relevant skills are loaded for this task. Read a skill before doing work it covers:',
    ...lines,
    '</available_skills>',
  ].join('\n');
}