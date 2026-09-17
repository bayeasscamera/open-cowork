'use strict';

const MAX_REVIEW_BYTES = 60000;

function validateReview(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_REVIEW_BYTES) {
    throw new Error('Invalid review output size');
  }
  const review = JSON.parse(raw);
  if (
    !review ||
    typeof review !== 'object' ||
    Array.isArray(review) ||
    Object.keys(review).join(',') !== 'body' ||
    typeof review.body !== 'string' ||
    !review.body.trim() ||
    !review.body.trimEnd().endsWith('*Open Cowork Bot*')
  ) {
    throw new Error('Invalid review output schema');
  }
  return { body: review.body };
}

async function publishReview({ github, context, raw, analysisResult, shouldPublish }) {
  if (analysisResult !== 'success' || shouldPublish !== 'true') {
    throw new Error('Review analysis did not complete successfully');
  }
  const { body } = validateReview(raw);
  const pr = context.payload.pull_request;
  const target = { owner: context.repo.owner, repo: context.repo.repo, pull_number: pr.number };
  const current = await github.rest.pulls.get(target);
  if (current.data.state !== 'open' || current.data.head.sha !== pr.head.sha) return false;
  await github.rest.pulls.createReview({
    ...target,
    commit_id: pr.head.sha,
    event: 'COMMENT',
    body,
  });
  return true;
}

module.exports = { validateReview, publishReview };
