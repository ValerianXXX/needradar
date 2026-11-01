import test from 'node:test';
import assert from 'node:assert/strict';
import { pairDigest, resolveHumanDecision, reviewDuplicates } from '../src/semantic-review.mjs';
import { recordPairDecision } from '../src/opportunity-state.mjs';
import { buildReviewClusters, recordClusterSplit } from '../src/opportunity-clusters.mjs';
import { decidePublicationWithReview } from '../src/pipeline.mjs';

const left = { id: 'reviewed-left', title: 'Invoice review', persona: 'Finance reviewers',
  jobToBeDone: 'Check invoice values against receipts', desiredOutcome: 'Verified records',
  constraints: { processing: 'offline' } };
const right = { ...left, id: 'reviewed-right', jobToBeDone: 'Reconcile bills with source documents' };
const foreign = [{ ...left, id: 'unreviewed-left' }, { ...right, id: 'unreviewed-right' }];
const options = { actor: 'SYNTHETIC_REVIEWER', reason: 'Reviewed this specific pair of source records',
  recordedAt: '2026-11-01T00:00:00Z' };
const record = (a = left, b = right, decision = 'same', extra = {}) => recordPairDecision(a, b,
  { ...options, digest: pairDigest(a, b), decision, ...extra });
const legacy = event => { const copy = structuredClone(event); delete copy.recordScope; return copy; };

for (const decision of ['same', 'different', 'uncertain']) {
  test(`recorded ${decision} correction cannot apply to another pair with the same text`, async () => {
    const event = record(left, right, decision), original = structuredClone(event);
    for (const [a, b] of [foreign, [...foreign].reverse()]) {
      const result = await reviewDuplicates(a, [b], { humanDecisions: [event], maxModelCalls: 0 });
      assert.equal(result.reviews[0].method, 'HUMAN_REVIEW_REQUIRED');
      assert.equal(result.duplicate, false);
      assert.equal(result.requiresReview, true);
      assert.equal(result.modelCalls, 0);
    }
    assert.deepEqual(event, original);
  });
}

test('the same IDs and contents survive reverse order and JSON persistence', async () => {
  const event = JSON.parse(JSON.stringify(record()));
  assert.deepEqual(event.recordScope, { protocol: 'OPPORTUNITY_RECORD_PAIR_V1', ids: [left.id, right.id] });
  for (const [a, b] of [[left, right], [right, left]]) {
    const row = (await reviewDuplicates(a, [b], { humanDecisions: [event] })).reviews[0];
    assert.equal(row.method, 'HUMAN_DECISION');
    assert.equal(row.verdict, 'same');
    assert.equal(row.humanScope, 'RECORD_PAIR');
  }
});

test('event identities distinguish different record pairs at the same time', () => {
  assert.notEqual(record().id, record(...foreign).id);
  assert.equal(record().id, record().id);
});

test('legacy full snapshots bind their own IDs without rewriting their history', () => {
  const event = legacy(record()), snapshot = JSON.stringify(event);
  assert.equal(resolveHumanDecision(right, left, [event]).decision, 'same');
  assert.equal(resolveHumanDecision(...foreign, [event]), null);
  assert.equal(JSON.stringify(event), snapshot);
});

test('a partially identified pair does not treat its missing ID as a wildcard', () => {
  const a = { ...left }; delete a.id;
  const event = record(a, right);
  assert.equal(resolveHumanDecision(a, right, [event]).decision, 'same');
  assert.equal(resolveHumanDecision(left, right, [event]), null);
  assert.equal(resolveHumanDecision(a, foreign[1], [event]), null);
});

test('unidentified source snapshots remain usable only without newly assigned IDs', () => {
  const a = { ...left }, b = { ...right }; delete a.id; delete b.id;
  const event = record(a, b);
  assert.equal(resolveHumanDecision(b, a, [event]).decision, 'same');
  assert.equal(resolveHumanDecision(left, right, [event]), null);
});

test('IDs cannot be swapped independently of their reviewed contents', () => {
  const event = record();
  assert.equal(resolveHumanDecision({ ...left, id: right.id }, { ...right, id: left.id }, [event]), null);
  assert.equal(resolveHumanDecision({ ...left, jobToBeDone: 'Archive source records' }, right, [event]), null);
});

test('malformed scopes or a scope conflicting with original snapshots cannot fall back to content', () => {
  const event = record();
  for (const recordScope of [null, {}, { protocol: 'OPPORTUNITY_RECORD_PAIR_V1', ids: [foreign[0].id, foreign[1].id] },
    { protocol: 'OPPORTUNITY_RECORD_PAIR_V1', ids: [left.id] },
    { protocol: 'UNKNOWN_SCOPE', ids: [left.id, right.id] }]) {
    assert.equal(resolveHumanDecision(left, right, [{ ...event, recordScope }]), null);
  }
});

test('inconsistent source snapshots cannot validate an otherwise matching content digest', () => {
  const event = legacy(record());
  event.originals[0].jobToBeDone = 'Another source task';
  assert.equal(resolveHumanDecision(left, right, [event]), null);
});

test('a later foreign correction cannot supersede the current pair decision', () => {
  const own = record(), other = record(...foreign, 'different', { recordedAt: '2026-11-01T01:00:00Z' });
  for (const history of [[own, other], [other, own], [own, other, own]]) {
    assert.equal(resolveHumanDecision(left, right, history).decision, 'same');
  }
});

test('split events agree between cluster and direct-pair views without changing other records', async () => {
  const originals = [left, right, ...foreign], before = structuredClone(originals);
  const split = recordClusterSplit(originals, { groups: [[left.id], [right.id]], ...options });
  assert.equal(resolveHumanDecision(left, right, split.events).decision, 'different');
  const result = await reviewDuplicates(...[foreign[0], [foreign[1]]], { humanDecisions: split.events, maxModelCalls: 0 });
  assert.equal(result.reviews[0].method, 'HUMAN_REVIEW_REQUIRED');
  const view = buildReviewClusters(originals, { humanDecisions: split.events });
  assert.equal(view.groups.length, 4);
  assert.equal(view.unreviewedPairs, 5);
  assert.deepEqual(originals, before);
});

test('foreign human decisions cannot clear publication review or suppress a different pair', async () => {
  const draft = { ...foreign[0], currentWorkflow: 'Manual comparison', aiPath: ['Prepare'], humanGates: ['Confirm'],
    counterEvidence: ['Manual comparison may suffice'], unknowns: ['Measured effort'] };
  const observations = ['a', 'b'].map(id => ({ evidenceKey: id, authorGroup: id, sourcePolicy: id,
    sourceAccessible: true, containsPersonalData: false, rightsApproved: true }));
  for (const verdict of ['same', 'different']) {
    const result = await decidePublicationWithReview({ draft, observations }, [foreign[1]],
      { humanDecisions: [record(left, right, verdict)], maxModelCalls: 0 });
    assert.equal(result.decision, 'REVIEW');
    assert.equal(result.automaticMerge, false);
  }
});

test('model proposals still reuse identical public content across IDs', async () => {
  const first = await reviewDuplicates(left, [right], { reviewerRevision: 'SYNTHETIC_SCOPE_CONTRACT',
    reviewer: async request => ({ decision: { verdict: 'same', reason: 'SAME_TASK_AND_CONSTRAINTS',
      leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'SYNTHETIC_STUB' }) });
  const result = await reviewDuplicates(foreign[0], [foreign[1]], { reviewerRevision: 'SYNTHETIC_SCOPE_CONTRACT',
    reviewJournal: first.reviewJournal, maxModelCalls: 0 });
  assert.equal(result.reviews[0].method, 'MODEL_PROPOSAL_REUSED');
  assert.equal(result.modelCalls, 0);
  assert.equal(result.automaticMerge, false);
});

test('invalid provided record IDs cannot create new recorded decisions', () => {
  for (const id of [null, '', '   ', 17, {}, 'x'.repeat(201)]) {
    assert.throws(() => record({ ...left, id }, right), /HUMAN_REVIEW_RECORD_ID_REQUIRED/u);
  }
});

test('legacy caller-built content decisions remain explicit compatibility observations', () => {
  const { digest, decision, actor, reason, recordedAt, id } = record();
  const result = resolveHumanDecision(left, right, [{ digest, decision, actor, reason, recordedAt, id }]);
  assert.equal(result.decision, 'same');
  assert.equal(result.humanScope, 'LEGACY_CONTENT_ONLY');
});
