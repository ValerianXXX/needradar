import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceSummary } from '../src/provenance.mjs';
import { addEvidence, assessOpportunityFreshness, recordValidation } from '../src/opportunity-state.mjs';
import { evaluateEvidenceCluster } from '../src/evidence-policy.mjs';

const early = '2026-06-01T12:00:00.000Z', later = '2026-10-30T12:00:00.000Z';
const observation = (key, extra = {}) => ({ evidenceKey: key, authorGroup: `author-${key}`,
  sourcePolicy: 'synthetic-forum', sourceAccessible: true, rightsApproved: true,
  containsPersonalData: false, ...extra });
const draft = Object.fromEntries(['title', 'persona', 'jobToBeDone', 'currentWorkflow',
  'desiredOutcome', 'aiPath', 'humanGates', 'counterEvidence', 'unknowns'].map(key => [key, 'Synthetic example']));
const start = rows => addEvidence({ draft }, rows, { observedAt: early });

test('enriching a capture with an organization does not report fresh independent demand', () => {
  const initial = start([observation('a')]);
  const validated = recordValidation(initial, { status: 'INTERVIEWED', evidenceKeys: ['a'],
    actor: 'synthetic-reviewer', recordedAt: '2026-06-02T12:00:00Z' });
  const enriched = addEvidence(validated, [observation('a', { originGroup: 'organization-a' })], { observedAt: later });
  assert.equal(enriched.independent_evidence, 1);
  assert.equal(enriched.independent_evidence_added, 0);
  assert.equal(enriched.evidence_added, 0);
  assert.equal(enriched.last_new_independent_evidence, early);
  assert.equal(enriched.last_seen, later);
  assert.equal(enriched.observations.length, 2);
  assert.deepEqual(enriched.validation, validated.validation);
  assert.equal(assessOpportunityFreshness(enriched, { asOf: later }).independentEvidence.status, 'STALE');
  assert.deepEqual(initial.observations, [observation('a')]);
});

test('one author across policies remains one origin despite partially enriched attribution', () => {
  const rows = [observation('a', { authorGroup: 'same-author', originGroup: 'business', sourcePolicy: 'forum-a' }),
    observation('b', { authorGroup: 'same-author', sourcePolicy: 'forum-b' })];
  for (const input of [rows, [...rows].reverse()]) {
    const result = evidenceSummary(input);
    assert.equal(result.independentEvidenceCount, 1);
    assert.equal(result.independentAuthorGroups, 1);
    assert.equal(result.sourcePolicies, 2);
    assert.equal(evaluateEvidenceCluster({ observations: input, draft }).eligible, false);
  }
});

test('different authors in a known shared origin cannot pass the author-count shortcut', () => {
  const rows = ['a', 'b', 'c'].map(key => observation(key, { originGroup: 'same-business' }));
  const result = evidenceSummary(rows);
  assert.equal(result.independentEvidenceCount, 1);
  assert.equal(result.independentAuthorGroups, 1);
  assert.equal(evaluateEvidenceCluster({ observations: rows, draft }).eligible, false);
});

test('author and organization namespaces do not collide merely because their labels match', () => {
  const rows = [observation('a', { authorGroup: 'same-label' }),
    observation('b', { authorGroup: undefined, originGroup: 'same-label', sourcePolicy: 'second-policy' })];
  assert.equal(evidenceSummary(rows).independentEvidenceCount, 2);
  assert.equal(evaluateEvidenceCluster({ observations: rows, draft }).eligible, true);
});

test('complementary original annotations and transitive attribution are order invariant', () => {
  const rows = [observation('a', { authorGroup: 'author-a' }),
    observation('a', { authorGroup: undefined, originGroup: 'organization-a' }),
    observation('b', { authorGroup: 'author-b', originGroup: 'organization-a' }),
    observation('c', { authorGroup: 'author-b' })];
  const counts = [];
  for (const input of [rows, [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
    const result = evidenceSummary(input);
    assert.equal(result.uniqueEvidenceCount, 3);
    assert.equal(result.independentEvidenceCount, 1);
    counts.push(result.independentOriginIds);
  }
  assert.deepEqual(counts[0], counts[1]);
  assert.deepEqual(counts[0], counts[2]);
});

test('malformed attribution does not create independence through JavaScript coercion', () => {
  for (const value of [{}, ['author'], 1, true]) {
    const result = evidenceSummary([observation('a', { authorGroup: value, originGroup: 'otherwise-valid' })]);
    assert.equal(result.independentEvidenceCount, 0);
    assert.equal(result.unresolvedProvenanceCount, 1);
  }
  assert.equal(evidenceSummary([observation('a', { authorGroup: '  ', originGroup: '' })]).independentEvidenceCount, 0);
});

test('nonempty trimmed attribution is stable without name guessing or lowercasing', () => {
  const result = evidenceSummary([observation('a', { authorGroup: ' token ' }), observation('b', { authorGroup: 'token' }),
    observation('c', { authorGroup: 'TOKEN' })]);
  assert.equal(result.independentEvidenceCount, 2);
});

test('resolving an existing unattributed capture does not invent its observation date', () => {
  const initial = start([observation('a', { authorGroup: undefined })]);
  const resolved = addEvidence(initial, [observation('a')], { observedAt: later });
  assert.equal(initial.independent_evidence, 0);
  assert.equal(resolved.independent_evidence, 1);
  assert.equal(resolved.independent_evidence_added, 0);
  assert.equal(resolved.last_new_independent_evidence, null);
  assert.equal(assessOpportunityFreshness(resolved, { asOf: later }).requiresReview, true);
});

test('a new unrelated origin still counts when other annotations consolidate old origins', () => {
  const initial = start([observation('a'), observation('b', { originGroup: 'shared-business' })]);
  const after = addEvidence(initial, [observation('a', { originGroup: 'shared-business' }), observation('c')], { observedAt: later });
  assert.equal(after.independent_evidence, 2);
  assert.equal(after.independent_evidence_added, 1);
  assert.equal(after.evidence_added, 1);
  assert.equal(after.last_new_independent_evidence, later);
  assert.equal(assessOpportunityFreshness(after, { asOf: later }).requiresReview, false);
});

test('legacy derived recency remains visible but is not silently certified by a recapture', () => {
  const legacy = { draft, observations: [observation('a')], independent_evidence: 99,
    last_seen: later, last_new_independent_evidence: later };
  assert.equal(assessOpportunityFreshness(legacy, { asOf: later }).requiresReview, true);
  const after = addEvidence(legacy, [observation('a', { originGroup: 'business' })], { observedAt: later });
  assert.equal(after.independent_evidence, 1);
  assert.equal(after.last_new_independent_evidence, later);
  assert.equal(after.independent_evidence_added, 0);
  assert.equal(assessOpportunityFreshness(after, { asOf: later }).independentEvidence.verified, false);
  assert.equal(assessOpportunityFreshness(after, { asOf: later }).requiresReview, true);
  assert.equal(legacy.independent_evidence, 99);
});

test('an earlier new origin cannot certify an unverified later legacy clock', () => {
  const legacy = { draft, observations: [observation('a')], last_seen: later, last_new_independent_evidence: later };
  const older = addEvidence(legacy, [observation('b')], { observedAt: early });
  assert.equal(older.independent_evidence_added, 1);
  assert.equal(older.last_new_independent_evidence, later);
  assert.equal(assessOpportunityFreshness(older, { asOf: later }).independentEvidence.verified, false);
  const current = addEvidence(older, [observation('c')], { observedAt: later });
  assert.equal(assessOpportunityFreshness(current, { asOf: later }).independentEvidence.verified, true);
});

test('losing or consolidating previously known origins requires recency review', () => {
  const initial = addEvidence({ draft }, [observation('a'), observation('b', { originGroup: 'business' })], { observedAt: later });
  const merged = addEvidence(initial, [observation('a', { originGroup: 'business' })], { observedAt: later });
  assert.equal(merged.independent_evidence_added, 0);
  assert.equal(merged.last_new_independent_evidence, later);
  assert.equal(assessOpportunityFreshness(merged, { asOf: later }).independentEvidence.verified, false);
  const conflicted = addEvidence(initial, [observation('b', { authorGroup: 'conflicting-author', originGroup: 'business' })], { observedAt: later });
  assert.equal(assessOpportunityFreshness(conflicted, { asOf: later }).requiresReview, true);
});

test('reposts and rejected private captures do not supply new attribution', () => {
  const initial = start([observation('a')]);
  const after = addEvidence(initial, [observation('repost', { repostOf: 'a', originGroup: 'reposter-business' }),
    observation('private', { containsPersonalData: true })], { observedAt: later });
  assert.equal(after.independent_evidence, 1);
  assert.equal(after.independent_evidence_added, 0);
  assert.equal(after.last_new_independent_evidence, early);
  assert.equal(after.observations.length, 2);
});

test('genuinely independent authors can qualify while counterevidence stays outside support gates', () => {
  const rows = ['a', 'b', 'c'].map(key => observation(key));
  assert.equal(evaluateEvidenceCluster({ observations: rows, draft }).eligible, true);
  const counter = rows.map(row => ({ ...row, stance: 'counterevidence' }));
  assert.equal(evaluateEvidenceCluster({ observations: counter, draft }).eligible, false);
  const state = start(counter);
  assert.equal(state.independent_evidence_added, 3);
  assert.deepEqual(state.counterevidence, ['a', 'b', 'c']);
  assert.equal(state.validation.status, 'UNVALIDATED');
});
