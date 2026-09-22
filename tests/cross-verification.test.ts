import { describe, expect, it } from 'vitest';
import {
  CROSS_VERIFICATION_COST,
  CROSS_VERIFICATION_MAX_MODEL_CALLS,
  buildCodeReviewResult,
  buildCorrectiveContext,
  buildDeveloperReviewRerunContext,
  buildPeerChallengePrompt,
  buildPeerCrossCheckResult,
  buildResearchCrossCheckPrompt,
  buildResearchCrossCheckResult,
  buildSubstantiveReviewInstruction,
  parseCrossCheckResponse,
  parseResearchContradictions,
  parseReviewerFinding,
  renderCrossVerificationSection,
  summarizeCrossVerification,
} from '../src/main/agent/cross-verification';

describe('cross-verification parsing', () => {
  it('parses the three peer verdicts and keeps the precise point', () => {
    const disagree = parseCrossCheckResponse(
      'reviewer',
      ['## Cross-check verdict', 'VERDICT: DISAGREE', 'POINT: The retry loop can double-charge.'].join('\n')
    );
    expect(disagree.verdict).toBe('disagree');
    expect(disagree.point).toBe('The retry loop can double-charge.');

    const blind = parseCrossCheckResponse(
      'security',
      'VERDICT: BLIND_SPOT\nPOINT: No rate limit on the token endpoint.'
    );
    expect(blind.verdict).toBe('blind_spot');

    const agree = parseCrossCheckResponse('reviewer', 'VERDICT: AGREE\nPOINT: none');
    expect(agree.verdict).toBe('agree');
    expect(agree.point).toBe('');
  });

  it('never assumes agreement when the verdict cannot be parsed', () => {
    const unparsed = parseCrossCheckResponse('reviewer', 'I read the report and it seems fine.');
    expect(unparsed.verdict).toBe('unknown');
    expect(unparsed.verdict).not.toBe('agree');
  });

  it('falls back to a loose keyword when the structured block is missing', () => {
    const loose = parseCrossCheckResponse('security', 'I must DISAGREE about the caching claim.');
    expect(loose.verdict).toBe('disagree');
  });

  it('parses the substantive review verdict; no marker means no point raised', () => {
    expect(parseReviewerFinding('VERDICT: LGTM\nPOINT: none')).toEqual({ raised: false, point: '' });
    expect(parseReviewerFinding('VERDICT: POINT_RAISED\nPOINT: Missing null check on user.id.')).toEqual({
      raised: true,
      point: 'Missing null check on user.id.',
    });
    expect(parseReviewerFinding('Looks good overall, tests pass.').raised).toBe(false);
  });

  it('parses research contradiction blocks and the explicit NONE answer', () => {
    expect(parseResearchContradictions('NONE')).toEqual([]);
    const raw = [
      '### CONTRADICTION',
      'TOPIC: Market size 2026',
      'SOURCE_A: Report A',
      'CLAIM_A: $4B',
      'SOURCE_B: Report B',
      'CLAIM_B: $9B',
      'PREFERRED: Report B',
      'RATIONALE: published later, primary data',
    ].join('\n');
    const parsed = parseResearchContradictions(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      topic: 'Market size 2026',
      sourceA: 'Report A',
      claimA: '$4B',
      sourceB: 'Report B',
      claimB: '$9B',
      preferred: 'Report B',
    });
  });
});

describe('cross-verification result assembly', () => {
  const reviewerResponse = parseCrossCheckResponse(
    'reviewer',
    'VERDICT: DISAGREE\nPOINT: The security report misses the SSRF via redirects.'
  );
  const securityResponse = parseCrossCheckResponse(
    'security',
    'VERDICT: AGREE\nPOINT: none'
  );

  it('turns a DISAGREE into an UNRESOLVED divergence carrying BOTH positions', () => {
    const result = buildPeerCrossCheckResult({
      reviewerResponse,
      securityResponse,
      reviewerReport: 'Reviewer found the code acceptable.',
      securityReport: 'Security found no injection issues.',
      modelCalls: 2,
    });
    expect(result.hasUnresolvedDisagreement).toBe(true);
    expect(result.divergences).toHaveLength(1);
    const [d] = result.divergences;
    expect(d.challenger).toBe('reviewer');
    expect(d.target).toBe('security');
    expect(d.challenge).toContain('SSRF');
    // The challenged side's own position is preserved, not overwritten.
    expect(d.targetPosition).toBe('Security found no injection issues.');
    expect(d.unresolved).toBe(true);
  });

  it('records a BLIND_SPOT without fabricating a disagreement', () => {
    const result = buildPeerCrossCheckResult({
      reviewerResponse: parseCrossCheckResponse('reviewer', 'VERDICT: AGREE\nPOINT: none'),
      securityResponse: parseCrossCheckResponse(
        'security',
        'VERDICT: BLIND_SPOT\nPOINT: Reviewer missed the missing CSRF token.'
      ),
      reviewerReport: 'r',
      securityReport: 's',
      modelCalls: 2,
    });
    expect(result.hasUnresolvedDisagreement).toBe(false);
    expect(result.blindSpots).toHaveLength(1);
    expect(result.blindSpots[0]).toMatchObject({ finder: 'security', target: 'reviewer' });
  });

  it('keeps a raised review point even once addressed', () => {
    const result = buildCodeReviewResult({
      finding: { raised: true, point: 'Cache key omits the tenant id.' },
      addressed: true,
      modelCalls: 1,
    });
    expect(result.reviewPointRaised).toBe(true);
    expect(result.reviewPointAddressed).toBe(true);
    expect(result.reviewFinding?.point).toContain('tenant id');
  });

  it('builds a research result from parsed contradictions', () => {
    const result = buildResearchCrossCheckResult({
      contradictions: parseResearchContradictions(
        ['### CONTRADICTION', 'TOPIC: X', 'CLAIM_A: a', 'CLAIM_B: b', 'PREFERRED: S2'].join('\n')
      ),
      raw: 'raw',
      modelCalls: 1,
    });
    expect(result.kind).toBe('research');
    expect(result.contradictions).toHaveLength(1);
    expect(result.modelCalls).toBe(1);
  });
});

describe('cross-verification rendering', () => {
  it('renders an unresolved disagreement with both positions, never as consensus', () => {
    const result = buildPeerCrossCheckResult({
      reviewerResponse: parseCrossCheckResponse(
        'reviewer',
        'VERDICT: DISAGREE\nPOINT: Retry can double-charge.'
      ),
      securityResponse: parseCrossCheckResponse('security', 'VERDICT: AGREE\nPOINT: none'),
      reviewerReport: 'reviewer report body',
      securityReport: 'security says charging is idempotent',
      modelCalls: 2,
    });
    const rendered = renderCrossVerificationSection([result]);
    expect(rendered).toContain('UNRESOLVED DISAGREEMENT');
    expect(rendered).toContain('NOT force-converged');
    expect(rendered).toContain('reviewer challenges security');
    expect(rendered).toContain('Retry can double-charge.');
    expect(rendered).toContain("security's position");
    expect(rendered).toContain('security says charging is idempotent');
    expect(rendered).toContain('added 2 model call');
  });

  it('renders research contradictions explicitly with the preferred source', () => {
    const result = buildResearchCrossCheckResult({
      contradictions: [
        {
          topic: 'Market size',
          sourceA: 'A',
          claimA: '$4B',
          sourceB: 'B',
          claimB: '$9B',
          preferred: 'B',
          rationale: 'newer',
        },
      ],
      raw: 'raw',
      modelCalls: 1,
    });
    const rendered = renderCrossVerificationSection([result]);
    expect(rendered).toContain('NOT silently merged');
    expect(rendered).toContain('Market size');
    expect(rendered).toContain('A: $4B');
    expect(rendered).toContain('B: $9B');
    expect(rendered).toContain('preferred (most recent/authoritative): B');
  });

  it('summarizes the measured added cost', () => {
    const summary = summarizeCrossVerification([
      buildCodeReviewResult({ finding: { raised: true, point: 'x' }, addressed: true, modelCalls: 1 }),
      buildPeerCrossCheckResult({
        reviewerResponse: parseCrossCheckResponse('reviewer', 'VERDICT: AGREE'),
        securityResponse: parseCrossCheckResponse('security', 'VERDICT: AGREE'),
        reviewerReport: '',
        securityReport: '',
        modelCalls: 2,
      }),
    ]);
    expect(summary).toEqual({
      enabled: true,
      modelCalls: 3,
      unresolvedDisagreements: 0,
      blindSpots: 0,
      contradictions: 0,
    });
    expect(summarizeCrossVerification(undefined).enabled).toBe(false);
  });
});

describe('cross-verification prompts', () => {
  it('the peer challenge demands a verdict and forbids a fabricated disagreement', () => {
    const prompt = buildPeerChallengePrompt({
      ownRole: 'reviewer',
      peerRole: 'security',
      peerReport: 'security body',
      ownReport: 'reviewer body',
    });
    expect(prompt).toContain('CHALLENGE');
    expect(prompt).toContain('VERDICT: AGREE | DISAGREE | BLIND_SPOT');
    expect(prompt).toContain('Do not invent a disagreement');
    expect(prompt).toContain('security body');
  });

  it('the substantive review explicitly excludes syntax and reuses the review block', () => {
    const instruction = buildSubstantiveReviewInstruction();
    expect(instruction).toContain('Syntax/parse errors are already checked automatically');
    expect(instruction).toContain('VERDICT: POINT_RAISED | LGTM');
  });

  it('the developer re-run reuses the shared corrective-context shape', () => {
    const rerun = buildDeveloperReviewRerunContext({
      reviewPoint: 'Handle the empty list.',
      previousOutput: 'previous',
    });
    expect(rerun).toContain('## Reviewer feedback');
    expect(rerun).toContain('Handle the empty list.');
    expect(rerun).toContain('## Your previous result');
    expect(rerun).toContain('smallest correct change');
    // Same builder the syntax re-run uses — one mechanism, not two.
    const syntax = buildCorrectiveContext({
      reason: 'Your previous changes introduced syntax errors — fix them',
      details: 'a.ts:1 missing brace',
      instruction: 'Re-apply the changes correctly.',
    });
    expect(syntax).toContain('## Your previous changes introduced syntax errors');
    expect(syntax).toContain('a.ts:1 missing brace');
  });

  it('the research prompt forbids silent merging and asks for a preferred source', () => {
    const prompt = buildResearchCrossCheckPrompt([
      { id: 'd1', title: 'Report A', findings: 'A says 4B', summary: '' },
      { id: 'd2', title: 'Report B', findings: 'B says 9B', summary: '' },
    ]);
    expect(prompt).toContain('FACTUAL CONTRADICTIONS');
    expect(prompt).toContain('Never silently merge');
    expect(prompt).toContain('PREFERRED');
    expect(prompt).toContain('Report A');
    expect(prompt).toContain('Report B');
  });

  it('exposes the auditable hard cap on added model calls', () => {
    expect(CROSS_VERIFICATION_COST.peerChallenge).toBe(2);
    expect(CROSS_VERIFICATION_COST.codeReviewRerun).toBe(1);
    expect(CROSS_VERIFICATION_MAX_MODEL_CALLS).toBe(3);
  });
});
