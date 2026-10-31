import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewClusters, recordClusterSplit } from '../src/opportunity-clusters.mjs';
import { recordPairDecision, recordValidation } from '../src/opportunity-state.mjs';
import { pairDigest } from '../src/semantic-review.mjs';
import { evaluateEvidenceCluster } from '../src/evidence-policy.mjs';

const makeDrafts = () => ['a', 'b', 'c'].map(id => ({
  id, title: 'Synthetic evidence review', persona: 'Synthetic reviewers',
  jobToBeDone: 'Check supplied records and retain source evidence.',
  currentWorkflow: 'Read source records manually.', desiredOutcome: 'A traceable review.',
  aiPath: 'Prepare candidates for human review.', humanGates: ['Review source rights'],
  counterEvidence: ['No independent adoption observation'], unknowns: ['Real workflow demand'],
  constraints: { processing: 'offline' },
  observations: [{ evidenceKey: `source-${id}`, authorGroup: `author-${id}`,
    sourcePolicy: 'synthetic-public', sourceAccessible: true, rightsApproved: id !== 'c',
    containsPersonalData: false, quote: `Synthetic statement ${id}`, metadata: { label: id } }],
}));
const review = (left, right, time = '2026-10-31T12:00:00Z') => recordPairDecision(left, right, {
  digest: pairDigest(left, right), decision: 'same', actor: 'synthetic-reviewer',
  reason: 'Same synthetic task and supported constraints', recordedAt: time,
});
const joined = drafts => buildReviewClusters(drafts, { humanDecisions: [
  review(drafts[0], drafts[1]), review(drafts[0], drafts[2]), review(drafts[1], drafts[2]),
] });
const priorValidation = () => recordValidation(makeDrafts()[0], {
  status: 'INTERVIEWED', evidenceKeys: ['source-a'], actor: 'synthetic-reviewer', recordedAt: '2026-10-31T12:00:00Z',
});
const nextValidation = prior => recordValidation(prior, {
  status: 'INVALIDATED', evidenceKeys: ['source-a'], actor: 'synthetic-reviewer', recordedAt: '2026-10-31T13:00:00Z',
});

test('editing returned validation history cannot rewrite the prior state', () => {
  const prior = priorValidation(), before = structuredClone(prior);
  const next = nextValidation(prior);
  next.validation.events[0].status = 'OUTCOME_OBSERVED';
  next.validation.events[0].evidenceKeys.push('invented');
  assert.deepEqual(prior, before);
});

test('later edits of the prior history cannot rewrite a returned transition', () => {
  const prior = priorValidation(), next = nextValidation(prior), before = structuredClone(next);
  prior.validation.events[0].actor = 'changed caller';
  prior.validation.events[0].evidenceKeys.length = 0;
  assert.deepEqual(next, before);
});

test('cluster original and capture objects are detached from source records', () => {
  const drafts = makeDrafts(), before = structuredClone(drafts), view = joined(drafts);
  view.groups[0].evidence.groups[0].original.quote = 'Local draft edit';
  view.groups[0].evidence.groups[1].observations[0].metadata.label = 'Edited preview label';
  assert.deepEqual(drafts, before);
});

test('later edits of source records do not rewrite an already returned cluster view', () => {
  const drafts = makeDrafts(), view = joined(drafts), before = structuredClone(view);
  drafts[0].observations[0].quote = 'New source revision';
  drafts[1].observations[0].metadata.label = 'New annotation';
  assert.deepEqual(view, before);
});

test('editing preview rights cannot turn unapproved source evidence into an eligible publication', () => {
  const drafts = makeDrafts();
  const sourceCluster = { draft: drafts[0], observations: drafts.flatMap(draft => draft.observations) };
  const before = evaluateEvidenceCluster(sourceCluster);
  assert.equal(before.eligible, false);
  const view = joined(drafts);
  const capture = view.groups[0].evidence.groups.flatMap(group => group.observations)
    .find(item => item.evidenceKey === 'source-c');
  capture.rightsApproved = true;
  const after = evaluateEvidenceCluster(sourceCluster);
  assert.equal(after.eligible, false);
  assert.deepEqual(after, before);
  assert.equal(drafts[2].observations[0].rightsApproved, false);
});

test('a split view preserves original rights and source snapshots independently', () => {
  const drafts = makeDrafts(), split = recordClusterSplit(drafts, { groups: [['a'], ['b', 'c']],
    actor: 'synthetic-reviewer', reason: 'Separate desired outcomes', recordedAt: '2026-10-31T13:00:00Z' });
  const view = buildReviewClusters(drafts, { humanDecisions: split.events });
  const before = structuredClone(drafts), savedSplit = structuredClone(split);
  for (const group of view.groups) for (const evidence of group.evidence.groups) {
    evidence.original.rightsApproved = true;
    evidence.original.metadata.label = 'Local split preview edit';
  }
  assert.deepEqual(drafts, before);
  assert.deepEqual(split, savedSplit);
});

test('explicit review events and their originals already remain detached', () => {
  const drafts = makeDrafts(), before = structuredClone(drafts), event = review(drafts[0], drafts[1]);
  event.originals[0].observations[0].quote = 'Local event preview';
  assert.deepEqual(drafts, before);
});

test('new validation event input and original source observations remain detached', () => {
  const source = makeDrafts()[0], keys = ['source-a'];
  const next = recordValidation(source, { status: 'INTERVIEWED', evidenceKeys: keys,
    actor: 'synthetic-reviewer', recordedAt: '2026-10-31T12:00:00Z' });
  keys.length = 0;
  source.observations[0].quote = 'New source';
  assert.deepEqual(next.validation.events[0].evidenceKeys, ['source-a']);
  assert.equal(next.observations[0].quote, 'Synthetic statement a');
});
