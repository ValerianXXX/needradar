import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewClusters, recordClusterSplit } from '../src/opportunity-clusters.mjs';
import { pairDigest } from '../src/semantic-review.mjs';
import { recordPairDecision } from '../src/opportunity-state.mjs';

const drafts = ['a', 'b', 'c'].map(id => ({ id, title: `Synthetic ${id}`, persona: 'Reviewers',
  jobToBeDone: 'Check supplied records and retain evidence.', constraints: { processing: 'offline' },
  observations: [{ evidenceKey: `source-${id}`, authorGroup: `author-${id}` }] }));
const review = (left, right, decision = 'same', recordedAt = '2026-10-29T12:00:00Z') => recordPairDecision(left, right,
  { digest: pairDigest(left, right), decision, actor: 'synthetic-human', reason: 'Reviewed source tasks and constraints', recordedAt });
const memberships = result => result.groups.map(group => group.memberIds);

test('transitive positive links cannot hide a cannot-link decision', () => {
  const [a,b,c] = drafts, events = [review(a,b), review(b,c), review(a,c,'different')];
  for (const items of [drafts, [...drafts].reverse()]) for (const humanDecisions of [events, [...events].reverse(), [...events,...events]]) {
    const result = buildReviewClusters(items, { humanDecisions });
    assert.deepEqual(memberships(result), [['a','b'],['c']]);
    assert.ok(result.blockedEdges.some(row => row.reasons?.includes('CANNOT_LINK_REVIEW')));
    assert.equal(result.originalRecordsRemoved, 0);
    assert.equal(result.automaticMerge, false);
  }
});

test('every cross-pair must be reviewed before a group can join', () => {
  const [a,b,c] = drafts, events = [review(a,b), review(b,c)];
  const partial = buildReviewClusters(drafts, { humanDecisions: events });
  assert.deepEqual(memberships(partial), [['a','b'],['c']]);
  assert.equal(partial.unreviewedPairs, 1);
  const complete = buildReviewClusters(drafts, { humanDecisions: [...events, review(a,c)] });
  assert.deepEqual(memberships(complete), [['a','b','c']]);
  assert.equal(complete.requiresReview, false);
  assert.equal(complete.groups[0].evidence.captureCount, 3);
});

test('split, historical replay and explicit relinking preserve originals and journal', () => {
  const [a,b,c] = drafts, original = structuredClone(drafts), history = [review(a,b),review(a,c),review(b,c)];
  const split = recordClusterSplit(drafts, { groups: [['a'],['b','c']], actor: 'synthetic-human', reason: 'A has a different required outcome', recordedAt: '2026-10-29T13:00:00Z' });
  assert.equal(split.events.length, 2);
  assert.deepEqual(memberships(buildReviewClusters(drafts, { humanDecisions: [...history,...split.events] })), [['a'],['b','c']]);
  assert.deepEqual(memberships(buildReviewClusters(drafts, { humanDecisions: history })), [['a','b','c']]);
  const restored = [...history,...split.events,review(a,b,'same','2026-10-29T14:00:00Z'),review(a,c,'same','2026-10-29T14:00:00Z')];
  assert.deepEqual(memberships(buildReviewClusters(drafts, { humanDecisions: restored })), [['a','b','c']]);
  assert.deepEqual(drafts, original);
  assert.equal(history.length, 3);
});

test('changed content, missing targets and conflicting constraints do not reuse old merges', () => {
  const [a,b] = drafts, old = review(a,b);
  const changed = buildReviewClusters([a,{...b,jobToBeDone:'A new task'}], { humanDecisions:[old] });
  assert.deepEqual(memberships(changed), [['a'],['b']]);
  assert.equal(changed.ignoredReviews[0].reason, 'STALE_OR_INVALID_REVIEW');
  assert.equal(buildReviewClusters([a], { humanDecisions:[old] }).ignoredReviews[0].reason, 'REVIEW_TARGET_MISSING');
  const cloud = {...b,constraints:{processing:'cloud'}};
  const conflict = buildReviewClusters([a,cloud], {humanDecisions:[review(a,cloud)]});
  assert.deepEqual(memberships(conflict), [['a'],['b']]);
  assert.ok(conflict.blockedEdges[0].reasons.includes('EXPLICIT_CONSTRAINT_CONFLICT'));
});

test('bounded checks leave groups separate and malformed split membership fails', () => {
  const [a,b,c] = drafts;
  const result = buildReviewClusters(drafts, {humanDecisions:[review(a,b),review(a,c),review(b,c)],maxPairChecks:1});
  assert.deepEqual(memberships(result), [['a','b'],['c']]);
  assert.ok(result.blockedEdges.some(row=>row.reason==='PAIR_CHECK_BUDGET_EXHAUSTED'));
  assert.throws(()=>buildReviewClusters([a,a]));
  assert.throws(()=>recordClusterSplit(drafts,{groups:[['a'],['a','b']]}));
  assert.throws(()=>recordClusterSplit(drafts,{groups:[['a'],['missing']]}));
});
