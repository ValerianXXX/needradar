import test from 'node:test';
import assert from 'node:assert/strict';
import { addEvidence, recordValidation, assessOpportunityFreshness } from '../src/opportunity-state.mjs';
import { evaluateEvidenceCluster } from '../src/evidence-policy.mjs';

// The public transition API is frozen before implementation. A missing module
// is an unimplemented contract, not a measured historical production incident.
const api = () => import('../src/evidence-corrections.mjs');
const early = '2026-06-01T12:00:00.000Z', later = '2026-10-31T12:00:00.000Z';
const next = '2026-10-31T13:00:00.000Z';
const row = (key, extra = {}) => ({ evidenceKey: key, authorGroup: `author-${key}`,
  quote: `Original synthetic statement ${key}`, sourcePolicy: 'synthetic',
  sourceAccessible: true, rightsApproved: true, containsPersonalData: false, ...extra });
const draft = Object.fromEntries(['title','persona','jobToBeDone','currentWorkflow','desiredOutcome',
  'aiPath','humanGates','counterEvidence','unknowns'].map(key => [key, 'Synthetic example']));
const initial = (rows = [row('a')]) => recordValidation(addEvidence({ draft }, rows, { observedAt: early }),
  { status: 'INTERVIEWED', evidenceKeys: ['a'], actor: 'synthetic-reviewer', recordedAt: '2026-06-02T12:00:00Z' });
const request = (module, state, extra = {}) => ({ expectedDigest: module.evidenceCorrectionDigest(state),
  evidenceKeys: ['a'], patch: { authorGroup: 'corrected-a' }, actor: 'synthetic-reviewer',
  reason: 'Checked the supplied original-source attribution.', recordedAt: later, ...extra });

test('explicit correction retains raw source, dates, validation and an independent prior state', async () => {
  const module = await api(), before = initial(), saved = structuredClone(before);
  const after = module.correctEvidenceAttribution(before, request(module, before));
  assert.deepEqual(before, saved);
  assert.equal(after.observations[0].authorGroup, 'corrected-a');
  assert.equal(after.observations[0].quote, saved.observations[0].quote);
  assert.equal(after.last_seen, early); assert.equal(after.last_new_independent_evidence, early);
  assert.equal(after.independent_evidence, 1); assert.equal(after.independent_evidence_added, 0);
  assert.equal(after.evidence_added, 0); assert.equal(after.independent_recency_verified, true);
  assert.deepEqual(after.provenance_change, {newIndependentOrigins: 0, resolvedExistingOrigins: 1, consolidatedOrLostOrigins: 0});
  assert.deepEqual(after.validation, saved.validation);
  const event = after.provenance_corrections[0];
  assert.equal(event.kind, 'ATTRIBUTION_CORRECTED');
  assert.equal(event.actor, 'synthetic-reviewer'); assert.equal(event.recordedAt, later);
  assert.deepEqual(event.changes[0].before, saved.observations[0]);
  assert.deepEqual(event.changes[0].after, after.observations[0]);
});

test('correction requires a current full-state digest and rejects replay without another event', async () => {
  const module = await api(), before = initial(), payload = request(module, before);
  const after = module.correctEvidenceAttribution(before, payload), saved = structuredClone(after);
  assert.throws(() => module.correctEvidenceAttribution(after, payload), /EVIDENCE_CORRECTION_STALE_INPUT/);
  after.validation.events[0].actor = 'different reviewer';
  assert.throws(() => module.correctEvidenceAttribution(after, request(module, saved)), /EVIDENCE_CORRECTION_STALE_INPUT/);
  assert.equal(after.provenance_corrections.length, 1);
});

test('only explicit author and organization corrections are accepted', async () => {
  const module = await api(), before = initial();
  for (const patch of [{ rightsApproved: true }, { quote: 'invented' }, { evidenceKey: 'replacement' },
    { authorGroup: 'new', sourceAccessible: true }, { originGroup: [] }, { authorGroup: '' }, {}]) {
    assert.throws(() => module.correctEvidenceAttribution(before, request(module, before, { patch })), /EVIDENCE_CORRECTION_PATCH_INVALID/);
  }
  assert.equal(before.observations[0].authorGroup, 'author-a');
});

test('actor, reason, target keys and strictly advancing event time are required', async () => {
  const module = await api(), before = initial();
  for (const extra of [{actor: ''}, {reason: ''}, {evidenceKeys: []}, {evidenceKeys: ['missing']},
    {evidenceKeys: ['a','a']}, {recordedAt: '2026-02-30T12:00:00Z'}]) {
    assert.throws(() => module.correctEvidenceAttribution(before, request(module, before, extra)));
  }
  const after = module.correctEvidenceAttribution(before, request(module, before));
  assert.throws(() => module.correctEvidenceAttribution(after, request(module, after, {patch: {originGroup: 'org'}})), /EVIDENCE_CORRECTION_TIME_MUST_ADVANCE/);
});

test('a no-op cannot append a misleading correction or refresh recency', async () => {
  const module = await api(), before = initial();
  assert.throws(() => module.correctEvidenceAttribution(before, request(module, before,
    {patch: {authorGroup: 'author-a'}})), /EVIDENCE_CORRECTION_NO_CHANGE/);
  assert.equal(before.provenance_corrections, undefined);
});

test('undo appends its own reason and restores the exact selected source without deleting history', async () => {
  const module = await api(), before = initial(), after = module.correctEvidenceAttribution(before, request(module, before));
  const saved = structuredClone(after), event = after.provenance_corrections[0];
  const restored = module.revertEvidenceAttribution(after, { expectedDigest: module.evidenceCorrectionDigest(after),
    eventId: event.id, actor: 'synthetic-reviewer', reason: 'Original attribution was confirmed.', recordedAt: next });
  assert.deepEqual(after, saved); assert.deepEqual(restored.observations, before.observations);
  assert.deepEqual(restored.validation, before.validation);
  assert.equal(restored.provenance_corrections.length, 2);
  assert.deepEqual(restored.provenance_corrections[0], event);
  assert.equal(restored.provenance_corrections[1].kind, 'ATTRIBUTION_REVERTED');
  assert.equal(restored.provenance_corrections[1].undoes, event.id);
  assert.equal(restored.independent_evidence_added, 0); assert.equal(restored.last_seen, early);
});

test('undo refuses stale source snapshots and cannot discard a later capture', async () => {
  const module = await api(), before = initial(), corrected = module.correctEvidenceAttribution(before, request(module, before));
  const after = addEvidence(corrected, [row('new')], { observedAt: next }), saved = structuredClone(after);
  assert.throws(() => module.revertEvidenceAttribution(after, { expectedDigest: module.evidenceCorrectionDigest(after),
    eventId: corrected.provenance_corrections[0].id, actor: 'synthetic-reviewer', reason: 'Reconsidered.',
    recordedAt: '2026-10-31T14:00:00Z' }), /EVIDENCE_CORRECTION_SOURCE_CHANGED/);
  assert.deepEqual(after, saved);
});

test('corrupt correction history is rejected instead of silently discarded or rewritten', async () => {
  const module = await api(), before = initial(), after = module.correctEvidenceAttribution(before, request(module, before));
  after.provenance_corrections[0].changes[0].before.quote = 'tampered source';
  assert.throws(() => module.correctEvidenceAttribution(after, request(module, after,
    {patch: {originGroup: 'org'}, recordedAt: next})), /EVIDENCE_CORRECTION_HISTORY_INVALID/);
});

test('consolidation makes recency unverified without changing recorded business validation', async () => {
  const module = await api(), before = initial([row('a'), row('b', {sourcePolicy: 'second'})]);
  assert.equal(evaluateEvidenceCluster(before).eligible, true);
  const after = module.correctEvidenceAttribution(before, request(module, before,
    {evidenceKeys: ['a','b'], patch: {originGroup: 'shared-organization'}}));
  assert.equal(after.independent_evidence, 1); assert.equal(after.independent_evidence_added, 0);
  assert.equal(after.provenance_change.consolidatedOrLostOrigins, 1);
  assert.equal(assessOpportunityFreshness(after, {asOf: later}).independentEvidence.verified, false);
  assert.equal(evaluateEvidenceCluster(after).eligible, false);
  assert.deepEqual(after.validation, before.validation);
});

test('resolving old unknown attribution leaves the independent-arrival date unknown', async () => {
  const module = await api(), before = initial([row('a', {authorGroup: null})]);
  const after = module.correctEvidenceAttribution(before, request(module, before));
  assert.equal(after.independent_evidence, 1); assert.equal(after.independent_evidence_added, 0);
  assert.equal(after.last_new_independent_evidence, null);
  assert.equal(after.independent_recency_verified, false);
});

test('returned current values, audit snapshots and caller inputs never share editable objects', async () => {
  const module = await api(), before = initial(), payload = request(module, before);
  const after = module.correctEvidenceAttribution(before, payload), saved = structuredClone(after);
  payload.patch.authorGroup = 'changed caller'; before.observations[0].quote = 'changed prior';
  assert.deepEqual(after, saved);
  after.observations[0].quote = 'changed returned current';
  assert.deepEqual(after.provenance_corrections[0], saved.provenance_corrections[0]);
  after.provenance_corrections[0].changes[0].after.authorGroup = 'changed audit view';
  assert.equal(after.observations[0].authorGroup, 'corrected-a');
});

test('only selected captures change; permissions, quotes, counterevidence and originals survive', async () => {
  const module = await api(), before = initial([row('a'), row('a', {quote: 'Same source recaptured'}),
    row('counter', {stance: 'counterevidence', sourcePolicy: 'second'})]);
  const after = module.correctEvidenceAttribution(before, request(module, before));
  assert.equal(after.provenance_corrections[0].changes.length, 2);
  assert.deepEqual(after.counterevidence, ['counter']);
  assert.deepEqual(after.observations[2], before.observations[2]);
  assert.deepEqual(after.observations.map(row => row.quote), before.observations.map(row => row.quote));
  assert.ok(after.observations.every(row => row.rightsApproved && row.sourceAccessible && !row.containsPersonalData));
  assert.equal(after.observations.length, before.observations.length);
});
