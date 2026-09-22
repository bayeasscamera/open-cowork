/**
 * @module main/projects/two-stage-pipeline
 *
 * Pure decision and prompt-building logic for a project's two-stage answer
 * pipeline: a fast "draft" model produces a first pass, then a more capable
 * "refine" model reviews and polishes it. Only the finalized text is presented
 * to the user; the draft stays available as a collapsible detail block and a
 * session log entry.
 *
 * Deliberate design constraints:
 * - Pure module: no Electron, no database, no network. Everything here is
 *   unit-tested directly, so the execution path in agent-runner stays thin.
 * - Single-model mode is untouched: every decision checks `mode` first.
 * - A trivial exchange ("merci", "ok continue") never buys a second model call
 *   — the added cost has to be earned, not imposed.
 * - If the refine pass fails, the draft is released as the answer (one fallback
 *   attempt, never a silent block) — mirroring sub-agent fallback semantics.
 */

import type { PipelineMode } from '../../shared/types';

export type { PipelineMode };

export const PIPELINE_MODES: readonly PipelineMode[] = ['single', 'two-stage'];
export const DEFAULT_PIPELINE_MODE: PipelineMode = 'single';

/** Below this length a request is conversational and never refined. */
export const MIN_REFINE_REQUEST_CHARS = 24;
/** Below this length a draft is already an answer on its own — no second pass. */
export const MIN_REFINE_DRAFT_CHARS = 400;

export function isPipelineMode(value: unknown): value is PipelineMode {
  return value === 'single' || value === 'two-stage';
}

export function normalizePipelineMode(value: unknown): PipelineMode {
  return isPipelineMode(value) ? value : DEFAULT_PIPELINE_MODE;
}

/** Conversational fillers that must never trigger a second model call. */
const TRIVIAL_REQUESTS = new Set([
  'ok',
  'okay',
  'k',
  'oui',
  'non',
  'yes',
  'no',
  'yep',
  'nope',
  'merci',
  'thanks',
  'thank you',
  'thx',
  'ty',
  'continue',
  'go on',
  'go',
  'next',
  'd\'accord',
  'daccord',
  'parfait',
  'super',
  'bien',
  'top',
  'genial',
  'génial',
  'carry on',
  'keep going',
  'vas-y',
  'vas y',
  'envoie',
  'send it',
]);

/**
 * True when a request is too short or too conversational to justify a second
 * model call. Normalization is deliberately conservative: only obvious
 * acknowledgements are dropped, everything else keeps the pipeline armed.
 */
export function isTrivialRequest(userRequest: string): boolean {
  const normalized = userRequest
    .trim()
    .toLowerCase()
    .replace(/[.!?…]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return true;
  if (normalized.length < MIN_REFINE_REQUEST_CHARS) return true;
  if (TRIVIAL_REQUESTS.has(normalized)) return true;
  return false;
}

export type PipelineDecisionReason =
  | 'mode-off'
  | 'missing-refine-model'
  | 'trivial-request'
  | 'no-draft'
  | 'short-draft'
  | 'ok';

export interface PipelineDecision {
  /** True when the second (refine) pass must run. */
  run: boolean;
  /** Why — exposed for tests, logs and the UI's transparency story. */
  reason: PipelineDecisionReason;
}

/**
 * Pre-run gate: can this exchange enter the two-stage flow at all? Called
 * BEFORE the draft runs so the draft's live streaming can be suppressed.
 */
export function shouldArmTwoStage(input: {
  mode: PipelineMode;
  userRequest: string;
  hasRefineModel: boolean;
}): PipelineDecision {
  if (input.mode !== 'two-stage') return { run: false, reason: 'mode-off' };
  if (!input.hasRefineModel) return { run: false, reason: 'missing-refine-model' };
  if (isTrivialRequest(input.userRequest)) return { run: false, reason: 'trivial-request' };
  return { run: true, reason: 'ok' };
}

/** Post-draft gate: is the draft substantial enough to be worth refining? */
export function shouldRefineDraft(draftText: string): PipelineDecision {
  const trimmed = draftText.trim();
  if (!trimmed) return { run: false, reason: 'no-draft' };
  if (trimmed.length < MIN_REFINE_DRAFT_CHARS) return { run: false, reason: 'short-draft' };
  return { run: true, reason: 'ok' };
}

/** Full post-run decision: armed AND the draft is substantial enough. */
export function decideTwoStage(input: {
  mode: PipelineMode;
  userRequest: string;
  hasRefineModel: boolean;
  draftText: string;
}): PipelineDecision {
  const armed = shouldArmTwoStage(input);
  if (!armed.run) return armed;
  return shouldRefineDraft(input.draftText);
}

/**
 * System prompt of the refine stage. The refine call is text-only and has no
 * tools: it reviews the draft, it never re-executes the task.
 */
export function buildRefineSystemPrompt(): string {
  return [
    'You are the final-editing stage of a two-stage answer pipeline.',
    'Another model produced a first draft answering the user request.',
    'Review and polish that draft — do not rewrite it from scratch unless it is actually wrong.',
    'Rules:',
    '- Keep the language of the user request.',
    '- Preserve every correct fact, code block, command and path; invent nothing new.',
    '- Fix mistakes, fill real gaps, tighten wording and formatting.',
    '- Reply with the finished text only: no preamble, no meta commentary, and no',
    '  mention that a draft existed.',
  ].join('\n');
}

/** User prompt handed to the refine stage: request + draft to improve. */
export function buildRefinePrompt(input: { userRequest: string; draftText: string }): string {
  return [
    'User request:',
    '<request>',
    input.userRequest.trim(),
    '</request>',
    '',
    'First draft to review and improve (do not rewrite from scratch unless necessary):',
    '<draft>',
    input.draftText.trim(),
    '</draft>',
  ].join('\n');
}

export interface SimpleTokenUsage {
  input: number;
  output: number;
}

/** Additive merge so the finalized message reports the true cost of both passes. */
export function mergeTokenUsage(
  base: SimpleTokenUsage | undefined,
  extra: SimpleTokenUsage | undefined
): SimpleTokenUsage | undefined {
  if (!base && !extra) return undefined;
  return {
    input: (base?.input ?? 0) + (extra?.input ?? 0),
    output: (base?.output ?? 0) + (extra?.output ?? 0),
  };
}

export interface RefineOutcome {
  text: string;
  usage?: SimpleTokenUsage;
}

export type RefineCall = (input: { systemPrompt: string; prompt: string }) => Promise<RefineOutcome>;

export interface TwoStageResult {
  /** What the user sees. */
  finalText: string;
  /** True when the refine pass failed and the draft was released as-is. */
  usedFallback: boolean;
  /** Present only with `usedFallback` — a failure is never swallowed silently. */
  refineError?: string;
  /** Refine-pass token usage, to be merged into the finalized message. */
  usage?: SimpleTokenUsage;
}

/**
 * Run the refine stage. Never throws: any failure (network, auth, timeout,
 * empty answer) degrades to the draft, flagged through `usedFallback`.
 */
export async function runTwoStagePipeline(input: {
  decision: PipelineDecision;
  userRequest: string;
  draftText: string;
  refine: RefineCall;
}): Promise<TwoStageResult> {
  if (!input.decision.run) {
    return { finalText: input.draftText, usedFallback: false };
  }
  try {
    const outcome = await input.refine({
      systemPrompt: buildRefineSystemPrompt(),
      prompt: buildRefinePrompt({ userRequest: input.userRequest, draftText: input.draftText }),
    });
    const finalText = (outcome.text ?? '').trim();
    if (!finalText) {
      return {
        finalText: input.draftText,
        usedFallback: true,
        refineError: 'Refine model returned an empty answer',
      };
    }
    return { finalText, usedFallback: false, usage: outcome.usage };
  } catch (err) {
    return {
      finalText: input.draftText,
      usedFallback: true,
      refineError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The draft is never presented as the answer, but it is never lost either —
 * this text labels the collapsible detail attached to the finalized message.
 */
export function buildDraftDetailText(input: {
  draftText: string;
  draftLabel: string;
  refineLabel: string;
}): string {
  return [
    `[Two-stage pipeline — step 1/2 draft · ${input.draftLabel} → refined by ${input.refineLabel}]`,
    '',
    input.draftText.trim(),
  ].join('\n');
}
