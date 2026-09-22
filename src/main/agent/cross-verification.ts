/**
 * @module main/agent/cross-verification
 *
 * OPT-IN cross-verification ("debate") layer for the swarm and for parallel
 * background research delegations.
 *
 * Plain parallel execution lets every sub-agent produce an independent report
 * that nobody confronts. This module makes agents CHALLENGE a peer's
 * conclusion and surfaces unresolved disagreements explicitly instead of
 * silently converging on an artificial consensus.
 *
 * Three applications, each hard-bounded to ONE round-trip (never an endless
 * debate loop):
 *   - reviewer_security: once both reports exist, each challenges the other
 *     (AGREE / DISAGREE / BLIND_SPOT). A surviving DISAGREE is escalated with
 *     BOTH positions — never force-converged.
 *   - code_review: the reviewer raises a SUBSTANTIVE (non-syntax) point and
 *     the developer gets exactly one targeted re-run.
 *   - research: contradictions between parallel research delegations are
 *     listed explicitly with a preferred source — never merged silently.
 *
 * COST: this is deliberately OPT-IN. It adds model calls on top of an already
 * expensive swarm (measured ~12-13x a solo run). See CROSS_VERIFICATION_COST.
 * Nothing in this module calls a model itself — it only builds prompts, parses
 * the model's structured verdicts, and renders the result. That keeps it pure
 * and unit-testable, and makes the added call count auditable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three contexts cross-verification applies to. */
type CrossCheckKind = 'reviewer_security' | 'code_review' | 'research';

/** What a peer said about the other agent's conclusion. */
type CrossCheckVerdict = 'agree' | 'disagree' | 'blind_spot' | 'unknown';

interface CrossCheckResponse {
  /** Agent that produced this response (role name, e.g. "reviewer"). */
  agent: string;
  verdict: CrossCheckVerdict;
  /** The precise point challenged / blind spot found ('' when agreeing). */
  point: string;
  /** Full raw model output, kept for traceability. */
  raw: string;
}

/** A disagreement that survived the single cross-check round. */
interface Divergence {
  kind: CrossCheckKind;
  /** Agent that raised the disagreement. */
  challenger: string;
  /** Agent whose conclusion is challenged. */
  target: string;
  /** The precise point the challenger made. */
  challenge: string;
  /** The target's own position (its reply, else its original conclusion). */
  targetPosition: string;
  /**
   * Always true here: the design is a SINGLE round-trip, so a surviving
   * disagreement is escalated as-is — never "resolved" by another debate.
   */
  unresolved: true;
}

/** An angle the other agent missed (not necessarily a contradiction). */
interface BlindSpot {
  kind: CrossCheckKind;
  finder: string;
  target: string;
  point: string;
}

/** A factual contradiction between two parallel research sources. */
interface ResearchContradiction {
  topic: string;
  sourceA: string;
  claimA: string;
  sourceB: string;
  claimB: string;
  /** Source judged most recent / most authoritative (never a silent merge). */
  preferred: string;
  rationale: string;
}

/** A substantive (non-syntax) review point raised about the developer's work. */
interface CodeReviewFinding {
  /** True when the reviewer raised a point worth a targeted developer re-run. */
  raised: boolean;
  /** The precise point, or '' when the reviewer found nothing substantive. */
  point: string;
}

export interface CrossVerificationResult {
  kind: CrossCheckKind;
  /** Model calls actually spent by this phase — the auditable added cost. */
  modelCalls: number;
  /** Peer verdicts (reviewer_security only). */
  responses?: CrossCheckResponse[];
  /** Disagreements that survived — surfaced, never force-converged. */
  divergences: Divergence[];
  blindSpots: BlindSpot[];
  /** Research contradictions (research only). */
  contradictions: ResearchContradiction[];
  /** The substantive review point (code_review only), even once resolved. */
  reviewFinding?: CodeReviewFinding;
  /** True when a substantive review point was raised (resolved or not). */
  reviewPointRaised?: boolean;
  /** True when that point was addressed by a targeted developer re-run. */
  reviewPointAddressed?: boolean;
  /** Raw model output(s) for traceability when structured parsing is thin. */
  raw?: string;
  /** True when at least one disagreement survived the single round. */
  hasUnresolvedDisagreement: boolean;
}

/**
 * Hard caps on the model calls cross-verification may add. The peer challenge
 * runs both directions in parallel (2 calls); the developer re-run is
 * conditional (0-1); a research pass is a single call. Kept as data so the
 * tool descriptions and tests can cite the exact ceiling.
 */
export const CROSS_VERIFICATION_COST = {
  /** reviewer + security each challenge the other: always 2 when enabled. */
  peerChallenge: 2,
  /** One targeted developer re-run — only when a substantive point is raised. */
  codeReviewRerun: 1,
  /** One research cross-check session covering every pending report. */
  researchPass: 1,
} as const;

/** Maximum extra model calls the swarm cross-verification can ever add. */
export const CROSS_VERIFICATION_MAX_MODEL_CALLS =
  CROSS_VERIFICATION_COST.peerChallenge + CROSS_VERIFICATION_COST.codeReviewRerun;

const NONE_RE = /^(none|aucun|aucune|n\/a|nothing|-|\.)$/i;

function cleanPoint(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim().replace(/^["'\s]+|["'\s]+$/g, '');
  return NONE_RE.test(trimmed) ? '' : trimmed;
}

function truncate(text: string, max = 320): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const VERDICT_BLOCK = [
  '## Cross-check verdict (REQUIRED — exactly this format)',
  'VERDICT: AGREE | DISAGREE | BLIND_SPOT',
  'POINT: <one precise sentence naming the challenged point, or "none">',
].join('\n');

/**
 * Ask one agent to actively CHALLENGE a peer's report. Not a re-read: the
 * contract demands a verdict and, when disagreeing or spotting a blind spot, a
 * single precise point.
 */
export function buildPeerChallengePrompt(args: {
  ownRole: string;
  peerRole: string;
  peerReport: string;
  ownReport: string;
}): string {
  const peer = args.peerReport.trim() || '(empty report)';
  const own = args.ownReport.trim() || '(empty report)';
  return [
    `You are the ${args.ownRole} of a swarm. Another sub-agent — the ${args.peerRole} — produced the report below IN PARALLEL with you.`,
    'Your job is NOT to re-read it politely: actively CHALLENGE it. Compare it to your own conclusions and decide, honestly:',
    '- AGREE — you checked and found no substantive problem with its conclusion.',
    '- DISAGREE — you believe a specific conclusion of its is wrong, unsupported, or contradicted by evidence. Name that point.',
    '- BLIND_SPOT — it missed something important that you did cover. Name that point.',
    '',
    'Rules:',
    '- Challenge at most ONE precise point. Do not invent a disagreement to look thorough — AGREE when there is nothing.',
    '- Do not silently defer to authority and do not soften a real disagreement into agreement.',
    '- You have exactly ONE round: your verdict is final and will be surfaced to the user as-is.',
    '',
    `## ${args.peerRole.toUpperCase()} report`,
    peer,
    '',
    `## Your own (${args.ownRole.toUpperCase()}) report`,
    own,
    '',
    VERDICT_BLOCK,
  ].join('\n');
}

const REVIEW_BLOCK = [
  '## Substantive review verdict (REQUIRED — exactly this format)',
  'VERDICT: POINT_RAISED | LGTM',
  'POINT: <one precise implementation concern, or "none">',
].join('\n');

/**
 * Extra instruction appended to the reviewer's task when cross-verification is
 * enabled: syntax is already checked mechanically, so review the LOGIC.
 */
export function buildSubstantiveReviewInstruction(): string {
  return [
    '',
    '## Substantive review (cross-verification enabled)',
    'Syntax/parse errors are already checked automatically — do NOT spend your',
    'report on them. Review the developer\'s LOGIC and APPROACH instead:',
    '- Is any implementation choice questionable (fragile, over-complex, wrong trade-off)?',
    '- Is an edge case left uncovered?',
    '- Is there a clearly better way to do it?',
    'If — and only if — you find one such substantive point, state it precisely;',
    'it will be sent back to the developer for exactly ONE targeted fix. If the',
    'work is sound, say LGTM rather than inventing a concern.',
    '',
    REVIEW_BLOCK,
  ].join('\n');
}

/**
 * The SINGLE shared shape of a one-shot corrective re-run brief. Both the
 * existing syntax re-run (swarm-runner) and the cross-verification review
 * re-run build their context through this — one mechanism, not two parallel
 * ones. Keeping it here (a pure module) avoids a cycle back into swarm-runner.
 */
export function buildCorrectiveContext(args: {
  /** Short heading, e.g. "Your previous changes introduced syntax errors". */
  reason: string;
  /** The precise, listed details to act on. */
  details: string;
  /** The one instruction the agent must follow. */
  instruction: string;
  /** The agent's previous result, for context (optional). */
  previousOutput?: string;
}): string {
  const parts = [`## ${args.reason}`, args.details.trim()];
  if (args.previousOutput?.trim()) {
    parts.push('', '## Your previous result', args.previousOutput.trim());
  }
  parts.push('', args.instruction.trim());
  return parts.join('\n');
}

/**
 * The targeted re-run brief handed to the developer after a substantive review
 * point. Reuses buildCorrectiveContext, so it is the SAME corrective mechanism
 * as the syntax re-run — one round, precise feedback, no refactor.
 */
export function buildDeveloperReviewRerunContext(args: {
  reviewPoint: string;
  previousOutput: string;
}): string {
  return buildCorrectiveContext({
    reason: 'Reviewer feedback — apply exactly this, then stop',
    details: args.reviewPoint,
    previousOutput: args.previousOutput,
    instruction: [
      "Address the reviewer's precise point with the smallest correct change.",
      'Do NOT refactor unrelated code and do NOT rewrite files wholesale. If you',
      'judge the reviewer wrong, say so explicitly in your result instead of',
      'silently ignoring it — a real disagreement is surfaced, not hidden.',
    ].join('\n'),
  });
}

/** Ask one research sub-agent to cross-check every report gathered so far. */
export function buildResearchCrossCheckPrompt(
  reports: Array<{ id: string; title: string; findings: string; summary: string }>
): string {
  const rendered = reports
    .map(
      (r, i) =>
        `### SOURCE ${i + 1}: ${r.title} (id: ${r.id})\n${(r.findings || r.summary || '(empty)').trim()}`
    )
    .join('\n\n');
  return [
    'You are cross-checking several research reports produced INDEPENDENTLY by',
    'parallel sub-agents on the same subject. Find FACTUAL CONTRADICTIONS between',
    'them: two sources that cannot both be true about the same point.',
    '',
    'Rules:',
    '- Report a contradiction ONLY when the claims genuinely conflict.',
    '- For each, name the source you judge most recent / most authoritative in',
    '  PREFERRED, with a short RATIONALE — but you MUST still list the',
    '  contradiction. Never silently merge conflicting claims into one.',
    '- If there is no contradiction, answer exactly NONE.',
    '',
    '## Output format (REQUIRED)',
    'Answer NONE, or repeat this block once per contradiction:',
    '### CONTRADICTION',
    'TOPIC: <the point in dispute>',
    'SOURCE_A: <source title>',
    'CLAIM_A: <what source A says>',
    'SOURCE_B: <source title>',
    'CLAIM_B: <what source B says>',
    'PREFERRED: <source title>',
    'RATIONALE: <why it is more recent/authoritative>',
    '',
    '## Reports',
    rendered,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parsers (robust: an unparseable verdict degrades to "unknown", never agree)
// ---------------------------------------------------------------------------

/** Parse the peer-challenge verdict block from a model reply. */
export function parseCrossCheckResponse(agent: string, raw: string): CrossCheckResponse {
  const verdictMatch = /^\s*VERDICT:\s*(AGREE|DISAGREE|BLIND_SPOT)\b/im.exec(raw);
  const pointMatch = /^\s*POINT:\s*(.+)$/im.exec(raw);
  const point = cleanPoint(pointMatch?.[1]);
  let verdict: CrossCheckVerdict = 'unknown';
  if (verdictMatch) {
    const token = verdictMatch[1].toUpperCase();
    verdict = token === 'AGREE' ? 'agree' : token === 'DISAGREE' ? 'disagree' : 'blind_spot';
  } else {
    // Loose fallback: a model that wrote "DISAGREE" mid-sentence still counts.
    if (/\bDISAGREE\b/i.test(raw)) verdict = 'disagree';
    else if (/\bBLIND[_ ]?SPOT\b/i.test(raw)) verdict = 'blind_spot';
    else if (/\bAGREE\b/i.test(raw)) verdict = 'agree';
  }
  return { agent, verdict, point, raw };
}

/** Parse the substantive review verdict from the reviewer's report. */
export function parseReviewerFinding(raw: string): CodeReviewFinding {
  const match = /^\s*VERDICT:\s*(POINT_RAISED|LGTM)\b/im.exec(raw);
  const pointMatch = /^\s*POINT:\s*(.+)$/im.exec(raw);
  const point = cleanPoint(pointMatch?.[1]);
  if (match) {
    const raised = match[1].toUpperCase() === 'POINT_RAISED';
    return { raised: raised && point.length > 0, point: raised ? point : '' };
  }
  // No structured block: only treat an explicit marker as a raised point,
  // never a heuristic guess (a false positive would spend a real re-run).
  if (/\bPOINT_RAISED\b/i.test(raw) && point) {
    return { raised: true, point };
  }
  return { raised: false, point: '' };
}

const FIELD_RE = (name: string) =>
  new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im');

/** Parse contradiction blocks from a research cross-check reply. */
export function parseResearchContradictions(raw: string): ResearchContradiction[] {
  if (/^\s*NONE\s*$/im.test(raw) && !/###\s*CONTRADICTION/i.test(raw)) {
    return [];
  }
  const blocks = raw.split(/^\s*###\s*CONTRADICTION\s*$/im).slice(1);
  const results: ResearchContradiction[] = [];
  for (const block of blocks) {
    const topic = cleanPoint(FIELD_RE('TOPIC').exec(block)?.[1]);
    const sourceA = cleanPoint(FIELD_RE('SOURCE_A').exec(block)?.[1]);
    const claimA = cleanPoint(FIELD_RE('CLAIM_A').exec(block)?.[1]);
    const sourceB = cleanPoint(FIELD_RE('SOURCE_B').exec(block)?.[1]);
    const claimB = cleanPoint(FIELD_RE('CLAIM_B').exec(block)?.[1]);
    const preferred = cleanPoint(FIELD_RE('PREFERRED').exec(block)?.[1]);
    const rationale = cleanPoint(FIELD_RE('RATIONALE').exec(block)?.[1]);
    // A block must at least name two conflicting claims to be a contradiction.
    if (!topic && !claimA && !claimB) continue;
    results.push({
      topic: topic || '(unspecified)',
      sourceA: sourceA || '(source A)',
      claimA,
      sourceB: sourceB || '(source B)',
      claimB,
      preferred: preferred || '(not stated)',
      rationale,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function positionFor(response: CrossCheckResponse | undefined, report: string): string {
  if (response?.point) return response.point;
  const summary = truncate(report);
  return summary || '(no position stated)';
}

/**
 * Assemble the reviewer↔security cross-check result. A DISAGREE in either
 * direction becomes a Divergence carrying BOTH positions; a BLIND_SPOT becomes
 * a BlindSpot. No consensus is ever fabricated.
 */
export function buildPeerCrossCheckResult(args: {
  reviewerResponse: CrossCheckResponse;
  securityResponse: CrossCheckResponse;
  reviewerReport: string;
  securityReport: string;
  modelCalls: number;
}): CrossVerificationResult {
  const { reviewerResponse, securityResponse, reviewerReport, securityReport } = args;
  const divergences: Divergence[] = [];
  const blindSpots: BlindSpot[] = [];

  const consider = (
    response: CrossCheckResponse,
    target: string,
    targetResponse: CrossCheckResponse,
    targetReport: string
  ) => {
    if (response.verdict === 'disagree') {
      divergences.push({
        kind: 'reviewer_security',
        challenger: response.agent,
        target,
        challenge: response.point || '(disagreement without a stated point)',
        targetPosition: positionFor(targetResponse, targetReport),
        unresolved: true,
      });
    } else if (response.verdict === 'blind_spot') {
      blindSpots.push({
        kind: 'reviewer_security',
        finder: response.agent,
        target,
        point: response.point || '(blind spot without a stated point)',
      });
    }
  };

  consider(reviewerResponse, 'security', securityResponse, securityReport);
  consider(securityResponse, 'reviewer', reviewerResponse, reviewerReport);

  return {
    kind: 'reviewer_security',
    modelCalls: args.modelCalls,
    responses: [reviewerResponse, securityResponse],
    divergences,
    blindSpots,
    contradictions: [],
    raw: [reviewerResponse.raw, securityResponse.raw].filter(Boolean).join('\n\n---\n\n'),
    hasUnresolvedDisagreement: divergences.length > 0,
  };
}

/** Assemble the code-review result (the raised point is kept even once fixed). */
export function buildCodeReviewResult(args: {
  finding: CodeReviewFinding;
  addressed: boolean;
  modelCalls: number;
  raw?: string;
}): CrossVerificationResult {
  return {
    kind: 'code_review',
    modelCalls: args.modelCalls,
    divergences: [],
    blindSpots: [],
    contradictions: [],
    reviewFinding: args.finding,
    reviewPointRaised: args.finding.raised,
    reviewPointAddressed: args.addressed,
    raw: args.raw,
    hasUnresolvedDisagreement: false,
  };
}

/** Assemble the research cross-check result. */
export function buildResearchCrossCheckResult(args: {
  contradictions: ResearchContradiction[];
  raw: string;
  modelCalls: number;
}): CrossVerificationResult {
  return {
    kind: 'research',
    modelCalls: args.modelCalls,
    divergences: [],
    blindSpots: [],
    contradictions: args.contradictions,
    raw: args.raw,
    hasUnresolvedDisagreement: false,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render every cross-verification result as an explicit report section. The
 * wording deliberately says "UNRESOLVED" and shows both sides: a disagreement
 * must never look like a consensus the system manufactured.
 */
export function renderCrossVerificationSection(
  results: CrossVerificationResult[] | undefined
): string {
  if (!results || results.length === 0) return '';
  const lines: string[] = ['', '## Cross-verification (opt-in)'];

  const peer = results.find((r) => r.kind === 'reviewer_security');
  if (peer) {
    lines.push('### Reviewer ↔ Security');
    if (peer.divergences.length > 0) {
      lines.push('⚠️ UNRESOLVED DISAGREEMENT — both positions below; NOT force-converged:');
      for (const d of peer.divergences) {
        lines.push(`- ${d.challenger} challenges ${d.target}: ${d.challenge}`);
        lines.push(`  - ${d.target}'s position: ${d.targetPosition}`);
      }
    } else {
      lines.push('- No unresolved disagreement (both peers agreed).');
    }
    if (peer.blindSpots.length > 0) {
      lines.push('Blind spots raised:');
      for (const b of peer.blindSpots) {
        lines.push(`- ${b.finder} → ${b.target}: ${b.point}`);
      }
    }
  }

  const code = results.find((r) => r.kind === 'code_review');
  if (code?.reviewFinding?.raised) {
    lines.push('### Substantive code review (developer ↔ reviewer)');
    lines.push(
      `- reviewer raised: ${code.reviewFinding.point}` +
        (code.reviewPointAddressed
          ? ' — addressed by ONE targeted developer re-run'
          : ' — NOT addressed (re-run budget exhausted)')
    );
  }

  const research = results.find((r) => r.kind === 'research');
  if (research && research.contradictions.length > 0) {
    lines.push('### Research contradictions (parallel sources)');
    lines.push('⚠️ Sources disagree — divergences listed, NOT silently merged:');
    for (const c of research.contradictions) {
      lines.push(`- ${c.topic}`);
      lines.push(`  - ${c.sourceA}: ${c.claimA}`);
      lines.push(`  - ${c.sourceB}: ${c.claimB}`);
      lines.push(`  - preferred (most recent/authoritative): ${c.preferred}${c.rationale ? ` — ${c.rationale}` : ''}`);
    }
  } else if (research) {
    lines.push('### Research contradictions (parallel sources)');
    lines.push('- No factual contradiction detected between the sources.');
  }

  const calls = results.reduce((sum, r) => sum + r.modelCalls, 0);
  lines.push(`Cross-verification added ${calls} model call(s).`);
  return lines.join('\n');
}

/** Compact machine-readable projection for the swarm tool details payload. */
export function summarizeCrossVerification(
  results: CrossVerificationResult[] | undefined
): {
  enabled: boolean;
  modelCalls: number;
  unresolvedDisagreements: number;
  blindSpots: number;
  contradictions: number;
} {
  const list = results ?? [];
  return {
    enabled: list.length > 0,
    modelCalls: list.reduce((sum, r) => sum + r.modelCalls, 0),
    unresolvedDisagreements: list.reduce((sum, r) => sum + r.divergences.length, 0),
    blindSpots: list.reduce((sum, r) => sum + r.blindSpots.length, 0),
    contradictions: list.reduce((sum, r) => sum + r.contradictions.length, 0),
  };
}
