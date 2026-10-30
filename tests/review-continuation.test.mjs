import test from 'node:test';
import assert from 'node:assert/strict';
import { pairDigest, reviewDuplicates } from '../src/semantic-review.mjs';

const candidate = { title: 'Invoice review', persona: 'Review operators', jobToBeDone: 'Review uncertain invoice fields',
  desiredOutcome: 'Verified fields', constraints: { processing: 'offline' } };
const corpus = Array.from({ length: 20 }, (_, index) => ({ ...candidate, id: `record-${String(index).padStart(2, '0')}`,
  jobToBeDone: `Reconcile invoice queue ${index} before publication` }));
const revision = 'contract-stub-prompt-1';
const response = request => ({ decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
  leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'CONTRACT_STUB',
  costUsd: null, elapsedMs: 1, usage: null });

test('three bounded invocations reach twenty candidates instead of repeating the first eight', async () => {
  const requests = [];
  const reviewer = async request => { requests.push(request.right.jobToBeDone); return response(request); };
  let reviewJournal;
  const calls = [];
  for (let page = 0; page < 3; page++) {
    const result = await reviewDuplicates(candidate, corpus, { reviewer, reviewerRevision: revision, reviewJournal });
    reviewJournal = JSON.parse(JSON.stringify(result.reviewJournal ?? null));
    calls.push(result.modelCalls);
    assert.equal(result.automaticMerge, false);
    assert.equal(result.requiresReview, true); // Every response is uncertain, not a correct answer.
  }
  assert.deepEqual(calls, [8, 8, 4]);
  assert.equal(new Set(requests).size, 20);
  assert.equal(requests.length, 20);
});

test('zero-budget replay retains proposals without charging cached costs again', async () => {
  const first = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewer: async request => ({ ...response(request), costUsd: 0.01 }), reviewerRevision: revision });
  const again = await reviewDuplicates(candidate, corpus.slice(0, 1), { maxModelCalls: 0, reviewerRevision: revision, reviewJournal: first.reviewJournal });
  assert.equal(again.modelCalls, 0);
  assert.equal(again.reviews[0].method, 'MODEL_PROPOSAL_REUSED');
  assert.equal(again.reviews[0].costUsd, 0.01); // Original observation, not a new charge.
  assert.equal(again.reviewProgress.cachedProposals, 1);
});

test('write-ahead checkpoint failure prevents a provider call', async () => {
  let calls = 0;
  await assert.rejects(reviewDuplicates(candidate, corpus, { reviewerRevision: revision,
    reviewer: async request => { calls++; return response(request); },
    onCheckpoint: async () => { throw new Error('DISK_FAILURE'); } }), /DISK_FAILURE/u);
  assert.equal(calls, 0);
});

test('lost completion checkpoint stays interrupted and is not silently retried', async () => {
  let saved, calls = 0;
  await assert.rejects(reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision,
    reviewer: async request => { calls++; return response(request); },
    onCheckpoint: async journal => { if (saved) throw new Error('DISK_FAILURE'); saved = structuredClone(journal); } }), /DISK_FAILURE/u);
  const result = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision, reviewJournal: saved,
    reviewer: async request => { calls++; return response(request); } });
  assert.equal(calls, 1);
  assert.equal(result.reviews[0].method, 'REVIEW_INTERRUPTED');
  assert.equal(result.requiresReview, true);
});

test('failed pair requires an explicit bounded retry and retains its failure record', async () => {
  let calls = 0;
  const failed = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision,
    reviewer: async () => { calls++; throw new Error('PROVIDER_FAILURE'); } });
  const result = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision, reviewJournal: failed.reviewJournal,
    reviewer: async request => { calls++; return response(request); } });
  assert.equal(calls, 1);
  assert.equal(result.reviews[0].method, 'REVIEW_FAILED');
  const retried = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision, reviewJournal: result.reviewJournal,
    retryFailedPairs: [pairDigest(candidate, corpus[0])], reviewer: async request => { calls++; return response(request); } });
  assert.equal(calls, 2);
  assert.ok(retried.reviewJournal.events.some(event => event.type === 'FAILED'));
  assert.equal(retried.reviews[0].method, 'MODEL_PROPOSAL');
});

test('journal binds the reviewer revision and rejects a silent provider change', async () => {
  const first = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewer: async request => response(request), reviewerRevision: revision });
  await assert.rejects(reviewDuplicates(candidate, corpus, { reviewerRevision: 'different-prompt-model', reviewJournal: first.reviewJournal }), /REVIEW_JOURNAL_REVISION/u);
});

test('changed content is reconsidered but reordering and returned-state mutation do not affect the input journal', async () => {
  const first = await reviewDuplicates(candidate, corpus.slice(0, 2), { reviewer: async request => response(request), reviewerRevision: revision });
  assert.ok(first.reviewJournal);
  const previous = JSON.stringify(first.reviewJournal);
  const changed = [{ ...corpus[1], jobToBeDone: 'Check duplicate remittances instead' }, corpus[0]];
  const result = await reviewDuplicates(candidate, changed, { reviewerRevision: revision, reviewJournal: first.reviewJournal, reviewer: async request => response(request) });
  assert.equal(result.modelCalls, 1);
  result.reviewJournal.events.length = 0;
  assert.equal(JSON.stringify(first.reviewJournal), previous);
});

test('cancelled work starts no requests and remains explicitly unresolved', async () => {
  const control = new AbortController();
  control.abort();
  let calls = 0;
  const result = await reviewDuplicates(candidate, corpus, { reviewerRevision: revision, signal: control.signal,
    reviewer: async request => { calls++; return response(request); } });
  assert.equal(calls, 0);
  assert.equal(result.reviews[0].method, 'REVIEW_CANCELLED');
  assert.equal(result.requiresReview, true);
});

test('cancellation after an active response preserves that attempt and starts no more', async () => {
  const control = new AbortController();
  const result = await reviewDuplicates(candidate, corpus, { reviewerRevision: revision, signal: control.signal,
    reviewer: async request => { control.abort(); return response(request); } });
  assert.equal(result.modelCalls, 1);
  assert.equal(result.reviews[0].method, 'MODEL_PROPOSAL');
  assert.equal(result.reviews[1].method, 'REVIEW_CANCELLED');
});

test('current human correction wins over a cached model proposal', async () => {
  const first = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision,
    reviewer: async request => ({ ...response(request), decision: { ...response(request).decision, verdict: 'same', reason: 'SAME_TASK_AND_CONSTRAINTS' } }) });
  const result = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision, reviewJournal: first.reviewJournal,
    humanDecisions: [{ id: 'correction', digest: pairDigest(candidate, corpus[0]), decision: 'different',
      actor: 'SYNTHETIC_REVIEWER', reason: 'Different workflow', recordedAt: '2026-10-29T00:00:00Z' }] });
  assert.equal(result.reviews[0].method, 'HUMAN_DECISION');
  assert.equal(result.duplicate, false);
  assert.equal(result.modelCalls, 0);
});

test('malformed and ungrounded saved results fail closed before model execution', async () => {
  const first = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision, reviewer: async request => response(request) });
  assert.ok(first.reviewJournal);
  const journal = structuredClone(first.reviewJournal);
  journal.events.find(event => event.type === 'RESULT').response.decision.leftQuote = 'invented content';
  await assert.rejects(reviewDuplicates(candidate, corpus, { reviewerRevision: revision, reviewJournal: journal }), /REVIEW|UNGROUNDED/u);
  await assert.rejects(reviewDuplicates(candidate, corpus, { reviewerRevision: revision, reviewJournal: { ...first.reviewJournal, version: 99 } }), /REVIEW_JOURNAL/u);
});

test('a partial retrieval remains incomplete after its whole shortlist has been visited', async () => {
  const many = Array.from({ length: 100 }, (_, index) => ({ ...corpus[index % 20], id: `record-${index}` }));
  let reviewJournal, result;
  for (let page = 0; page < 4; page++) {
    result = await reviewDuplicates(candidate, many, { reviewerRevision: revision, reviewJournal,
      reviewer: async request => ({ ...response(request), decision: { ...response(request).decision, verdict: 'different', reason: 'DIFFERENT_TASK' } }) });
    reviewJournal = result.reviewJournal;
  }
  assert.equal(result.retrievalComplete, false);
  assert.equal(result.requiresReview, true);
  assert.equal(result.automaticMerge, false);
});
