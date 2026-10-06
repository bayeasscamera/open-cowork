import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MultiAgentCoordinator,
  type AgentTask,
  type SubAgentRunResult,
} from '../src/main/agent/multi-agent-coordinator';
import { renderCrossVerificationSection } from '../src/main/agent/cross-verification';

/**
 * A scripted swarm runner. It answers by TASK IDENTITY (base DAG task vs
 * ephemeral cross-check/re-run task), which is exactly how the coordinator
 * distinguishes them — so the assertions below prove the extra calls are the
 * cross-verification ones, not a reshuffle of the base DAG.
 */
function makeScriptedRunner(opts: {
  reviewerBase?: string;
  securityBase?: string;
  reviewerChallenge?: string;
  securityChallenge?: string;
  developerRerun?: string;
}) {
  const calls: AgentTask[] = [];
  const contexts: string[] = [];
  const runner = async (task: AgentTask, context: string): Promise<SubAgentRunResult> => {
    calls.push(task);
    contexts.push(context);
    if (task.id.endsWith('-cross-check')) {
      const output =
        task.role === 'reviewer'
          ? (opts.reviewerChallenge ?? 'VERDICT: AGREE\nPOINT: none')
          : (opts.securityChallenge ?? 'VERDICT: AGREE\nPOINT: none');
      return { output };
    }
    if (task.id.endsWith('-review-rerun')) {
      return { output: opts.developerRerun ?? 'fixed by the targeted re-run' };
    }
    switch (task.role) {
      case 'architect':
        return { output: 'architecture decided' };
      case 'developer':
        return { output: 'developer implemented it' };
      case 'reviewer':
        return { output: opts.reviewerBase ?? 'review passed' };
      case 'security':
        return { output: opts.securityBase ?? 'security audit passed' };
      default:
        return { output: '' };
    }
  };
  return { runner, calls, contexts };
}

describe('swarm cross-verification — OPT-IN cost gate', () => {
  it('is OFF by default: no extra model call, no cross-verification results', async () => {
    const { runner, calls } = makeScriptedRunner({});
    const coordinator = new MultiAgentCoordinator(runner);
    const plan = coordinator.createCollaborativePlan('do something');

    expect(plan.crossVerification).toBe(false);
    const executed = await coordinator.executePlan(plan.id);

    // Exactly the four DAG tasks — the debate adds nothing on the default path.
    expect(calls).toHaveLength(4);
    expect(
      calls.every((c) => !c.id.endsWith('-cross-check') && !c.id.endsWith('-review-rerun'))
    ).toBe(true);
    expect(executed.crossVerificationResults).toBeUndefined();
    expect(renderCrossVerificationSection(executed.crossVerificationResults)).toBe('');
  });

  it('does NOT inject the substantive-review contract into the reviewer prompt when OFF', () => {
    const coordinator = new MultiAgentCoordinator();
    const plan = coordinator.createCollaborativePlan('goal');
    const reviewer = plan.tasks.find((t) => t.role === 'reviewer');
    expect(reviewer?.prompt).not.toContain('Substantive review');
  });

  it('injects the substantive-review contract into the reviewer prompt when ON', () => {
    const coordinator = new MultiAgentCoordinator();
    const plan = coordinator.createCollaborativePlan('goal', { crossVerification: true });
    const reviewer = plan.tasks.find((t) => t.role === 'reviewer');
    expect(reviewer?.prompt).toContain('Substantive review');
    expect(reviewer?.prompt).toContain('VERDICT: POINT_RAISED | LGTM');
  });
});

describe('swarm cross-verification — Zone 1 (reviewer vs security)', () => {
  it('surfaces a DISAGREE with BOTH positions instead of forcing consensus', async () => {
    const { runner, calls } = makeScriptedRunner({
      reviewerBase: 'VERDICT: LGTM\nPOINT: none',
      securityBase: 'Charging is idempotent, no double-charge risk.',
      reviewerChallenge: 'VERDICT: DISAGREE\nPOINT: The retry path can double-charge.',
      securityChallenge: 'VERDICT: AGREE\nPOINT: none',
    });
    const coordinator = new MultiAgentCoordinator(runner);
    const plan = coordinator.createCollaborativePlan('billing work', { crossVerification: true });
    const executed = await coordinator.executePlan(plan.id);

    // 4 DAG tasks + 2 peer-challenge calls. No developer re-run (reviewer LGTM).
    expect(calls).toHaveLength(6);
    const peer = executed.crossVerificationResults?.find((r) => r.kind === 'reviewer_security');
    expect(peer?.hasUnresolvedDisagreement).toBe(true);
    expect(peer?.modelCalls).toBe(2);
    expect(peer?.divergences).toHaveLength(1);
    expect(peer?.divergences[0]).toMatchObject({
      challenger: 'reviewer',
      target: 'security',
      challenge: 'The retry path can double-charge.',
      unresolved: true,
    });
    // The challenged position is preserved verbatim, not overwritten.
    expect(peer?.divergences[0].targetPosition).toBe(
      'Charging is idempotent, no double-charge risk.'
    );

    // The final report shows the disagreement explicitly.
    const rendered = renderCrossVerificationSection(executed.crossVerificationResults);
    expect(rendered).toContain('UNRESOLVED DISAGREEMENT');
    expect(rendered).toContain('NOT force-converged');
    expect(rendered).toContain('The retry path can double-charge.');
    expect(rendered).toContain('Charging is idempotent, no double-charge risk.');
    expect(rendered).toContain('added 2 model call');
  });

  it('reports agreement honestly when both peers agree', async () => {
    const { runner } = makeScriptedRunner({
      reviewerChallenge: 'VERDICT: AGREE\nPOINT: none',
      securityChallenge: 'VERDICT: AGREE\nPOINT: none',
    });
    const coordinator = new MultiAgentCoordinator(runner);
    const plan = coordinator.createCollaborativePlan('g', { crossVerification: true });
    const executed = await coordinator.executePlan(plan.id);
    const peer = executed.crossVerificationResults?.find((r) => r.kind === 'reviewer_security');
    expect(peer?.hasUnresolvedDisagreement).toBe(false);
    expect(peer?.divergences).toHaveLength(0);
  });
});

describe('swarm cross-verification — Zone 3 (developer vs reviewer)', () => {
  it('relaunches the developer EXACTLY ONCE with the precise review point', async () => {
    const { runner, calls, contexts } = makeScriptedRunner({
      reviewerBase: 'VERDICT: POINT_RAISED\nPOINT: The cache key omits the tenant id.',
      reviewerChallenge: 'VERDICT: AGREE\nPOINT: none',
      securityChallenge: 'VERDICT: AGREE\nPOINT: none',
    });
    const coordinator = new MultiAgentCoordinator(runner);
    const plan = coordinator.createCollaborativePlan('cache work', { crossVerification: true });
    const executed = await coordinator.executePlan(plan.id);

    const rerunIndexes = calls
      .map((c, i) => (c.id.endsWith('-review-rerun') ? i : -1))
      .filter((i) => i >= 0);
    expect(rerunIndexes).toHaveLength(1); // hard limit: ONE aller-retour
    // The re-run carries the reviewer's PRECISE point (reused corrective shape).
    expect(contexts[rerunIndexes[0]]).toContain('The cache key omits the tenant id.');
    expect(contexts[rerunIndexes[0]]).toContain('## Reviewer feedback');

    const code = executed.crossVerificationResults?.find((r) => r.kind === 'code_review');
    expect(code?.reviewPointRaised).toBe(true);
    expect(code?.reviewPointAddressed).toBe(true);
    expect(code?.modelCalls).toBe(1);

    // 4 DAG + 1 re-run + 2 peer = 7.
    expect(calls).toHaveLength(7);

    // Traceability: the raised point is still in the final report even though resolved.
    const rendered = renderCrossVerificationSection(executed.crossVerificationResults);
    expect(rendered).toContain('reviewer raised: The cache key omits the tenant id.');
    expect(rendered).toContain('addressed by ONE targeted developer re-run');
  });

  it('never loops: a still-complaining re-run does not trigger a second re-run', async () => {
    const { runner, calls } = makeScriptedRunner({
      reviewerBase: 'VERDICT: POINT_RAISED\nPOINT: Handle the empty list.',
      reviewerChallenge: 'VERDICT: AGREE\nPOINT: none',
      securityChallenge: 'VERDICT: AGREE\nPOINT: none',
      developerRerun: 'VERDICT: POINT_RAISED\nPOINT: still not satisfied',
    });
    const coordinator = new MultiAgentCoordinator(runner);
    const plan = coordinator.createCollaborativePlan('g', { crossVerification: true });
    await coordinator.executePlan(plan.id);
    expect(calls.filter((c) => c.id.endsWith('-review-rerun'))).toHaveLength(1);
  });

  it('does NOT re-run the developer when the reviewer reports LGTM', async () => {
    const { runner, calls } = makeScriptedRunner({
      reviewerBase: 'VERDICT: LGTM\nPOINT: none',
      reviewerChallenge: 'VERDICT: AGREE\nPOINT: none',
      securityChallenge: 'VERDICT: AGREE\nPOINT: none',
    });
    const coordinator = new MultiAgentCoordinator(runner);
    const plan = coordinator.createCollaborativePlan('g', { crossVerification: true });
    const executed = await coordinator.executePlan(plan.id);
    expect(calls.filter((c) => c.id.endsWith('-review-rerun'))).toHaveLength(0);
    const code = executed.crossVerificationResults?.find((r) => r.kind === 'code_review');
    expect(code?.reviewPointRaised).toBe(false);
    expect(code?.modelCalls).toBe(0);
  });
});

describe('swarm cross-verification — measured added cost', () => {
  it('adds exactly 2 calls with no review point, 3 with one, 0 when disabled', async () => {
    const run = async (crossVerification: boolean, reviewerBase?: string) => {
      const { runner } = makeScriptedRunner({
        reviewerBase,
        reviewerChallenge: 'VERDICT: AGREE\nPOINT: none',
        securityChallenge: 'VERDICT: AGREE\nPOINT: none',
      });
      const coordinator = new MultiAgentCoordinator(runner);
      const plan = coordinator.createCollaborativePlan('g', { crossVerification });
      const executed = await coordinator.executePlan(plan.id);
      return (executed.crossVerificationResults ?? []).reduce((sum, r) => sum + r.modelCalls, 0);
    };

    expect(await run(false)).toBe(0);
    expect(await run(true, 'VERDICT: LGTM\nPOINT: none')).toBe(2);
    expect(await run(true, 'VERDICT: POINT_RAISED\nPOINT: edge case')).toBe(3);
  });
});

describe('cross-verification wiring — source contracts', () => {
  // These assertions read source as text, so they must not depend on how the
  // formatter wraps a call. Source and needle both go through `norm`, which
  // collapses whitespace and drops the space around brackets, so a prettier
  // re-wrap cannot break a contract.
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*([(){},])\s*/g, '$1');
  const read = (p: string) => norm(readFileSync(p, 'utf8'));
  const contains = (source: string, needle: string) => expect(source).toContain(norm(needle));

  it('reuses the SINGLE corrective re-run mechanism (no second parallel one)', () => {
    const runner = read('src/main/agent/swarm-runner.ts');
    const coordinator = read('src/main/agent/multi-agent-coordinator.ts');
    const xv = read('src/main/agent/cross-verification.ts');

    // The syntax re-run and the review re-run both build through the shared helper.
    contains(runner, "from './cross-verification'");
    contains(runner, 'buildCorrectiveContext({');
    contains(coordinator, 'buildDeveloperReviewRerunContext(');
    contains(xv, 'buildCorrectiveContext({');
    // The review re-run goes through the SAME runner, never a raw session launch.
    expect(coordinator).not.toContain('launchSession');
    contains(coordinator, 'await runner(');
  });

  it('the swarm tool exposes the OPT-IN flag and renders the divergence report', () => {
    const tools = read('src/main/tools/dynamic-tool-creator.ts');
    contains(tools, 'crossVerification: Type.Optional');
    contains(tools, 'createCollaborativePlan(args.goal, {');
    contains(tools, 'renderCrossVerificationSection(executed.crossVerificationResults)');
    // Research delegations expose the same opt-in flag.
    contains(tools, 'crossVerify: true');
  });

  it('the research cross-check reuses the swarm runner and never blocks delivery', () => {
    const bg = read('src/main/agent/background-delegations.ts');
    contains(bg, 'buildResearchCrossCheckPrompt(');
    contains(bg, 'parseResearchContradictions(');
    contains(bg, 'createSwarmRunner(runnerOptions)(task');
    // Injection stays synchronous; the model call is scheduled on completion.
    contains(
      bg,
      'scheduleResearchCrossVerification(current.sessionId, options, effectiveGetConfig)'
    );
  });
});
