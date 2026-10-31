import test from 'node:test';
import assert from 'node:assert/strict';
import { pairDigest, reviewDuplicates, reviewSchema } from '../src/semantic-review.mjs';
import { decidePublicationWithReview } from '../src/pipeline.mjs';
import { createCandidateIndex } from '../src/similarity.mjs';

const draft = () => ({ id: 'candidate', title: 'Invoice review', persona: 'Document operators',
  jobToBeDone: 'Review uncertain invoice fields', desiredOutcome: 'Verified fields',
  constraints: { processing: 'offline' }, currentWorkflow: 'Manual comparison', aiPath: ['Prepare review'],
  humanGates: ['Confirm evidence'], counterEvidence: ['Manual review may suffice'], unknowns: ['Reviewer effort'] });
const peers = () => ['a', 'b'].map(id => ({ ...draft(), id, jobToBeDone: `Reconcile remittance queue ${id}` }));
const cluster = () => ({ draft: draft(), observations: ['a', 'b'].map(id => ({ evidenceKey: id,
  authorGroup: `author-${id}`, sourcePolicy: `policy-${id}`, sourceAccessible: true,
  rightsApproved: true, containsPersonalData: false })) });
const proposal = request => ({ decision: { verdict: 'different', reason: 'DIFFERENT_TASK',
  leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone },
  model: 'CONTRACT_STUB', elapsedMs: 1, usage: { input_tokens: 10 }, costUsd: null });

for (const mode of ['stateless', 'checkpointed']) {
  test(`${mode}: a draft edit during a response cannot change its quoted snapshot or clear review`, async () => {
    const left = draft(), right = peers(), original = structuredClone(left);
    const result = await reviewDuplicates(left, right, {
      ...(mode === 'checkpointed' ? { reviewerRevision: 'contract-v1' } : {}),
      reviewer: async request => {
        left.jobToBeDone = 'Delete invoice originals permanently';
        return proposal(request);
      },
    });
    assert.equal(result.requiresReview, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.inputChanged, true);
    assert.equal(result.modelCalls, 1);
    assert.equal(result.reviews[0].method, 'MODEL_PROPOSAL');
    assert.equal(result.reviews[0].leftQuote, original.jobToBeDone);
    assert.equal(result.reviews[0].pairDigest, pairDigest(original, right[0]));
    assert.equal(result.reviews[1].method, 'REVIEW_INPUT_CHANGED');
  });
}

test('a newly arrived exact duplicate invalidates an otherwise complete distinct result', async () => {
  const left = draft(), right = peers().slice(0, 1);
  const result = await reviewDuplicates(left, right, { reviewer: async request => {
    right.push({ ...structuredClone(left), id: 'new-arrival' });
    return proposal(request);
  } });
  assert.equal(result.inputChanged, true);
  assert.equal(result.requiresReview, true);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.automaticMerge, false);
});

test('editing a later peer never mixes old constraints with new source content', async () => {
  const left = draft(), right = peers();
  const result = await reviewDuplicates(left, right, { reviewer: async request => {
    right[1].constraints.processing = 'cloud';
    right[1].jobToBeDone = left.jobToBeDone;
    return proposal(request);
  } });
  assert.equal(result.inputChanged, true);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.reviews[1].method, 'REVIEW_INPUT_CHANGED');
  assert.equal(result.requiresReview, true);
});

test('human corrections arriving during review require a new coherent invocation', async () => {
  const left = draft(), right = peers(), humanDecisions = [];
  const result = await reviewDuplicates(left, right, { humanDecisions, reviewer: async request => {
    humanDecisions.push({ id: 'synthetic-correction', digest: pairDigest(left, right[1]), decision: 'same',
      actor: 'CONTRACT_REVIEWER', reason: 'Same intended workflow', recordedAt: '2026-10-31T00:00:00Z' });
    return proposal(request);
  } });
  assert.equal(result.requiresReview, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.reviews[1].method, 'REVIEW_INPUT_CHANGED');
  const next = await reviewDuplicates(left, right.slice(1), { humanDecisions, maxModelCalls: 0 });
  assert.equal(next.reviews[0].method, 'HUMAN_DECISION');
  assert.equal(next.duplicate, true);
});

test('request adapters receive detached constraints and cannot mutate the validation schema', async () => {
  const left = draft(), right = peers(), saved = structuredClone({ left, right, schema: reviewSchema });
  try {
    const result = await reviewDuplicates(left, right, { reviewer: async request => {
      request.left.constraints.processing = 'cloud';
      request.right.constraints.processing = 'cloud';
      request.schema.properties.reason.enum.push('ADAPTER_INVENTED_REASON');
      return { ...proposal(request), decision: { ...proposal(request).decision, reason: 'ADAPTER_INVENTED_REASON' } };
    } });
    assert.deepEqual({ left, right, schema: reviewSchema }, saved);
    assert.ok(result.reviews.every(row => row.method === 'REVIEW_FAILED'));
    assert.equal(result.requiresReview, true);
  } finally {
    // Keep the intentionally failing baseline test from contaminating other tests.
    reviewSchema.properties.reason.enum.splice(0, reviewSchema.properties.reason.enum.length,
      ...saved.schema.properties.reason.enum);
  }
});

test('response usage is copied before a later adapter invocation can alter it', async () => {
  const responses = [];
  const result = await reviewDuplicates(draft(), peers(), { reviewer: async request => {
    if (responses.length) responses[0].usage.input_tokens = 999;
    const response = proposal(request);
    responses.push(response);
    return response;
  } });
  assert.equal(result.reviews[0].usage.input_tokens, 10);
  responses[1].usage.input_tokens = 888;
  assert.equal(result.reviews[1].usage.input_tokens, 10);
});

test('a checkpoint-time edit starts no provider request and preserves the interrupted attempt', async () => {
  const left = draft();
  let calls = 0;
  const result = await reviewDuplicates(left, peers(), { reviewerRevision: 'contract-v1',
    onCheckpoint: async () => { left.jobToBeDone = 'Changed while persisting the checkpoint'; },
    reviewer: async request => { calls++; return proposal(request); },
  });
  assert.equal(calls, 0);
  assert.equal(result.inputChanged, true);
  assert.equal(result.requiresReview, true);
  assert.equal(result.reviews[0].method, 'REVIEW_INPUT_CHANGED');
  assert.deepEqual(result.reviewJournal.events.map(event => event.type), ['STARTED', 'FAILED']);
});

test('a completed old-snapshot response remains replayable without hiding its original cost', async () => {
  const left = draft(), old = structuredClone(left), right = peers().slice(0, 1);
  const first = await reviewDuplicates(left, right, { reviewerRevision: 'contract-v1', reviewer: async request => {
    left.jobToBeDone = 'A newly edited workflow';
    return { ...proposal(request), costUsd: 0.01 };
  } });
  assert.equal(first.requiresReview, true);
  assert.equal(first.inputChanged, true);
  const replay = await reviewDuplicates(old, right, { reviewerRevision: 'contract-v1',
    reviewJournal: first.reviewJournal, maxModelCalls: 0 });
  assert.equal(replay.reviews[0].method, 'MODEL_PROPOSAL_REUSED');
  assert.equal(replay.reviews[0].costUsd, 0.01);
  assert.equal(replay.requiresReview, false);
  const edited = await reviewDuplicates(left, right, { reviewerRevision: 'contract-v1',
    reviewJournal: first.reviewJournal, maxModelCalls: 0 });
  assert.equal(edited.reviews[0].method, 'HUMAN_REVIEW_REQUIRED');
});

for (const change of ['rights', 'draft', 'rules', 'new-peer']) {
  test(`publication cannot clear an input edit during review: ${change}`, async () => {
    const input = cluster(), existing = peers().slice(0, 1);
    const rules = { minimumAccessibleObservations: 2, minimumIndependentAuthorGroups: 3,
      minimumSourcePolicies: 2, requiredDraftFields: ['title', 'persona', 'jobToBeDone'] };
    const result = await decidePublicationWithReview(input, existing, { rules, reviewer: async request => {
      if (change === 'rights') input.observations[0].rightsApproved = false;
      if (change === 'draft') input.draft.unknowns = [];
      if (change === 'rules') rules.minimumAccessibleObservations = 3;
      if (change === 'new-peer') existing.push({ ...input.draft, id: 'new-duplicate' });
      return proposal(request);
    } });
    assert.equal(result.decision, 'REVIEW');
    assert.ok(result.reasons.includes('REVIEW_INPUT_CHANGED'));
    assert.equal(result.automaticMerge, false);
  });
}

test('unchanged inputs still permit a distinct decision with no schema or digest migration', async () => {
  const input = cluster(), existing = peers().slice(0, 1);
  const result = await decidePublicationWithReview(input, existing, { reviewer: async request => proposal(request) });
  assert.equal(result.decision, 'PUBLISH');
  assert.equal(result.semantic.reviews[0].pairDigest, pairDigest(input.draft, existing[0]));
  assert.equal(result.automaticMerge, false);
});

test('an explicit immutable index remains bound to its own snapshot when its old source array changes', async () => {
  const left = draft(), source = peers().slice(0, 1), index = createCandidateIndex(source);
  const result = await reviewDuplicates(left, index, { reviewer: async request => {
    source.push({ ...left, id: 'not-in-this-snapshot' });
    return proposal(request);
  } });
  assert.equal(result.requiresReview, false);
  assert.equal(index.size, 1);
  assert.equal(result.reviews.length, 1);
});
