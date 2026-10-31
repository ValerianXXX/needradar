import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDuplicates } from '../src/semantic-review.mjs';
import { decidePublicationWithReview } from '../src/pipeline.mjs';

const draft = () => ({ title: 'Review invoice fields', persona: 'Document operators',
  jobToBeDone: 'Review uncertain invoice fields', desiredOutcome: 'Verified fields',
  constraints: { processing: 'offline' }, currentWorkflow: 'Manual review', aiPath: ['Prepare'],
  humanGates: ['Confirm'], counterEvidence: ['Manual process'], unknowns: ['Effort'] });
const peers = () => ['a', 'b'].map(id => ({ ...draft(), id, jobToBeDone: `Check remittance queue ${id}` }));
const response = request => ({ decision: { verdict: 'different', reason: 'DIFFERENT_TASK',
  leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'CONTRACT_STUB' });

test('an edit observed after a response stays invalid even if a later checkpoint restores the value', async () => {
  const left = draft(), oldTask = left.jobToBeDone;
  const result = await reviewDuplicates(left, peers(), { reviewerRevision: 'boundary-v1',
    reviewer: async request => { left.jobToBeDone = 'Edited during response'; return response(request); },
    onCheckpoint: async journal => { if (journal.events.at(-1).type === 'RESULT') left.jobToBeDone = oldTask; },
  });
  assert.equal(result.inputChanged, true);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.requiresReview, true);
});

test('revoking evidence rights stops subsequent requests as well as publication', async () => {
  const input = { draft: draft(), observations: ['a', 'b'].map(id => ({ evidenceKey: id,
    authorGroup: id, sourcePolicy: id, sourceAccessible: true, rightsApproved: true })) };
  const result = await decidePublicationWithReview(input, peers(), { reviewer: async request => {
    input.observations[0].rightsApproved = false;
    return response(request);
  } });
  assert.equal(result.decision, 'REVIEW');
  assert.equal(result.semantic.modelCalls, 1);
  assert.equal(result.semantic.reviews[1].method, 'REVIEW_INPUT_CHANGED');
});

test('an optional external revision check must explicitly stay true and never reaches the adapter', async () => {
  for (const isInputCurrent of [() => false, () => undefined, () => { throw new Error('REVISION_UNAVAILABLE'); }]) {
    let calls = 0;
    const result = await reviewDuplicates(draft(), peers(), { isInputCurrent,
      reviewer: async request => { calls++; return response(request); } });
    assert.equal(calls, 0);
    assert.equal(result.inputChanged, true);
    assert.equal(result.requiresReview, true);
  }
  await assert.rejects(reviewDuplicates(draft(), peers(), { isInputCurrent: true }), /INPUT_CURRENT_CALLBACK_REQUIRED/u);
});

test('a revision change in a failed response stops further calls and retains the failure', async () => {
  let current = true;
  const result = await reviewDuplicates(draft(), peers(), { reviewerRevision: 'boundary-v1',
    isInputCurrent: () => current, reviewer: async () => { current = false; throw new Error('SYNTHETIC_FAILURE'); } });
  assert.equal(result.modelCalls, 1);
  assert.equal(result.reviews[0].method, 'REVIEW_FAILED');
  assert.equal(result.reviews[1].method, 'REVIEW_INPUT_CHANGED');
  assert.deepEqual(result.reviewJournal.events.map(event => event.type), ['STARTED', 'FAILED']);
});

test('the publication wrapper preserves a caller revision gate', async () => {
  const input = { draft: draft(), observations: ['a', 'b'].map(id => ({ evidenceKey: id,
    authorGroup: id, sourcePolicy: id, sourceAccessible: true, rightsApproved: true })) };
  const result = await decidePublicationWithReview(input, peers(), { isInputCurrent: () => false,
    reviewer: async request => response(request) });
  assert.equal(result.decision, 'REVIEW');
  assert.equal(result.semantic.modelCalls, 0);
});

test('inaccessible evidence holds before any adapter or caller revision work', async () => {
  const result = await decidePublicationWithReview({ draft: draft(), observations: [] }, peers(), {
    isInputCurrent: () => { throw new Error('SHOULD_NOT_BE_CALLED'); },
    reviewer: async () => { throw new Error('SHOULD_NOT_BE_CALLED'); },
  });
  assert.equal(result.decision, 'HOLD');
});
