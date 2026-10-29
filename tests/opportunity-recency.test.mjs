import test from 'node:test';
import assert from 'node:assert/strict';
import { addEvidence, assessOpportunityFreshness, recordPairDecision, recordValidation } from '../src/opportunity-state.mjs';
import { pairDigest, resolveHumanDecision } from '../src/semantic-review.mjs';
import { timestamp } from '../src/timestamps.mjs';

const draft = { title: 'Review sources', persona: 'Reviewers', jobToBeDone: 'Check original documents', constraints: {} };
const observation = { evidenceKey: 'a', authorGroup: 'author-a', sourcePolicy: 'synthetic',
  sourceAccessible: true, rightsApproved: true, containsPersonalData: false };

test('recapture and counterevidence do not become new supporting demand or change validation', () => {
  const initial = addEvidence(draft, [observation], { observedAt: '2026-06-01T12:00:00Z' });
  const validated = recordValidation(initial, { status: 'INTERVIEWED', evidenceKeys: ['a'], actor: 'synthetic-reviewer', recordedAt: '2026-06-02T12:00:00Z' });
  const repeated = addEvidence(validated, [{ ...observation, evidenceKey: 'copy', repostOf: 'a' }], { observedAt: '2026-10-29T12:00:00Z' });
  assert.equal(repeated.independent_evidence_added, 0);
  assert.equal(repeated.last_new_independent_evidence, initial.last_new_independent_evidence);
  const view = assessOpportunityFreshness(repeated, { asOf: '2026-10-29T12:00:00Z' });
  assert.equal(view.lastSeen.status, 'FRESH');
  assert.equal(view.independentEvidence.status, 'STALE');
  assert.equal(view.requiresReview, true);
  assert.deepEqual(view.validation, validated.validation);
  const counter = addEvidence(repeated, [{ ...observation, evidenceKey: 'counter', authorGroup: 'author-b', stance: 'counterevidence' }], { observedAt: '2026-10-29T12:00:00Z' });
  assert.deepEqual(counter.counterevidence, ['counter']);
  assert.equal(counter.independent_evidence_added, 1); // Counts provenance, not supportive demand.
  assert.deepEqual(counter.validation, validated.validation);
  assert.deepEqual(assessOpportunityFreshness(counter, { asOf: '2026-10-29T12:00:00Z' }).counterevidenceKeys, ['counter']);
});

test('freshness boundaries, unknown legacy dates and future timestamps remain explicit', () => {
  const opportunity = { last_seen: '2026-07-31T12:00:00Z', last_new_independent_evidence: '2026-09-29T12:00:00Z' };
  const view = assessOpportunityFreshness(opportunity, { asOf: '2026-10-29T12:00:00Z' });
  assert.equal(view.lastSeen.status, 'STALE');
  assert.equal(view.lastSeen.ageDays, 90);
  assert.equal(view.independentEvidence.status, 'AGING');
  assert.equal(view.independentEvidence.ageDays, 30);
  assert.equal(view.policy.calibrated, false);
  assert.equal(assessOpportunityFreshness({}, { asOf: '2026-10-29T12:00:00Z' }).independentEvidence.status, 'UNKNOWN');
  assert.equal(assessOpportunityFreshness({ last_seen: '2026-10-30T12:00:00Z' }, { asOf: '2026-10-29T12:00:00Z' }).lastSeen.status, 'CLOCK_SKEW');
  assert.throws(() => assessOpportunityFreshness({}, { asOf: '2026-10-29T12:00:00Z', agingDays: 90, staleDays: 30 }), /INVALID_FRESHNESS_POLICY/u);
});

test('out-of-order evidence keeps both clocks monotonic and rejected evidence advances neither', () => {
  const latest = addEvidence(draft, [observation], { observedAt: '2026-10-29T12:00:00Z' });
  const older = addEvidence(latest, [{ ...observation, evidenceKey: 'b', authorGroup: 'author-b' }], { observedAt: '2026-09-29T12:00:00Z' });
  assert.equal(older.last_seen, latest.last_seen);
  assert.equal(older.last_new_independent_evidence, latest.last_new_independent_evidence);
  const rejected = addEvidence(older, [{ ...observation, evidenceKey: 'private', containsPersonalData: true }], { observedAt: '2026-11-01T12:00:00Z' });
  assert.equal(rejected.last_seen, latest.last_seen);
  assert.equal(rejected.independent_evidence_added, 0);
});

test('journal timestamps reject impossible dates and local times without throwing on malformed entries', () => {
  const options = { digest: pairDigest(draft, draft), decision: 'different', actor: 'synthetic-reviewer', reason: 'Explicit distinction', recordedAt: '2026-10-29T12:00:00Z' };
  const event = recordPairDecision(draft, draft, options);
  for (const value of ['2026-02-30T12:00:00Z', '2026-10-29T12:00:00', '2026-10-29', '2026-10-29T24:00:00Z', '2026-10-29T12:00:00+24:00']) {
    assert.throws(() => timestamp(value), /VALID_TIMESTAMP_REQUIRED/u);
    assert.throws(() => recordPairDecision(draft, draft, { ...options, recordedAt: value }), /VALID_TIMESTAMP_REQUIRED/u);
    assert.equal(resolveHumanDecision(draft, draft, [null, {}, false, { ...event, recordedAt: value }]), null);
  }
  assert.equal(timestamp('2024-02-29T08:00:00-04:00'), '2024-02-29T12:00:00.000Z');
  assert.equal(resolveHumanDecision(draft, draft, [null, {}, event]).decision, 'different');
  assert.throws(() => resolveHumanDecision(draft, draft, Array(20001).fill(event)), /HUMAN_REVIEW_JOURNAL_LIMIT/u);
});
