import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { validateReview, publishReview } = require('../.github/scripts/pr-review-output.cjs');
const raw = JSON.stringify({ body: 'Review mode: initial\nNo findings.\n*Open Cowork Bot*' });

function fixture() {
  return {
    raw,
    analysisResult: 'success',
    shouldPublish: 'true',
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      payload: { pull_request: { number: 17, head: { sha: 'trusted-head' } } },
    },
    github: {
      rest: {
        pulls: {
          get: vi
            .fn()
            .mockResolvedValue({ data: { state: 'open', head: { sha: 'trusted-head' } } }),
          createReview: vi.fn().mockResolvedValue({}),
        },
      },
    },
  };
}

describe('isolated review publisher', () => {
  it.each(['failure', 'cancelled', 'skipped', ''])(
    'never publishes after analysis result %s',
    async (analysisResult) => {
      const f = fixture();
      await expect(publishReview({ ...f, analysisResult })).rejects.toThrow('did not complete');
      expect(f.github.rest.pulls.get).not.toHaveBeenCalled();
      expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
    }
  );

  it('requires explicit validated-output approval', async () => {
    const f = fixture();
    await expect(publishReview({ ...f, shouldPublish: '' })).rejects.toThrow();
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it.each([
    '',
    '{}',
    'null',
    '[]',
    '{"body":42}',
    '{"body":"unsigned"}',
    JSON.stringify({ body: 'ok *Open Cowork Bot*', commit_id: 'other' }),
    'x'.repeat(60001),
  ])('rejects invalid output without publishing', async (input) => {
    const f = fixture();
    expect(() => validateReview(input)).toThrow();
    await expect(publishReview({ ...f, raw: input })).rejects.toThrow();
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('uses only trusted event target and COMMENT semantics', async () => {
    const f = fixture();
    expect(await publishReview(f)).toBe(true);
    expect(f.github.rest.pulls.createReview).toHaveBeenCalledExactlyOnceWith({
      owner: 'owner',
      repo: 'repo',
      pull_number: 17,
      commit_id: 'trusted-head',
      event: 'COMMENT',
      body: JSON.parse(raw).body,
    });
  });

  it.each([
    { state: 'open', head: { sha: 'new-head' } },
    { state: 'closed', head: { sha: 'trusted-head' } },
  ])('skips stale or closed PRs', async (data) => {
    const f = fixture();
    f.github.rest.pulls.get.mockResolvedValue({ data });
    expect(await publishReview(f)).toBe(false);
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('fails when the live-head check fails', async () => {
    const f = fixture();
    f.github.rest.pulls.get.mockRejectedValue(new Error('API unavailable'));
    await expect(publishReview(f)).rejects.toThrow('API unavailable');
    expect(f.github.rest.pulls.createReview).not.toHaveBeenCalled();
  });

  it('separates permissions and gates publication on successful analysis', () => {
    const workflow = readFileSync('.github/workflows/codex-pr-review.yml', 'utf8');
    const [analysis, publishing] = workflow.split('  publish-review:');
    expect(analysis).toContain('pull-requests: read');
    expect(analysis).not.toContain('pull-requests: write');
    expect(analysis).toContain('sandbox: read-only');
    expect(analysis).not.toContain('danger-full-access');
    expect(publishing).toContain(
      "if: needs.pr-review.result == 'success' && needs.pr-review.outputs.should_publish == 'true'"
    );
    expect(publishing).toContain('pull-requests: write');
    expect(publishing).not.toContain('secrets.');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow).not.toContain('continue-on-error');
    const runner = readFileSync('.github/scripts/deepseek-pr-review.mjs', 'utf8');
    expect(runner).not.toContain("'POST'");
    expect(runner).toContain('validateReview(output)');
    expect(runner).toContain('process.exit(1)');
  });
});
