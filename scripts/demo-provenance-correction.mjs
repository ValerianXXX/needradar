import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { addEvidence, assessOpportunityFreshness } from '../src/opportunity-state.mjs';
import { evidenceCorrectionDigest, correctEvidenceAttribution, revertEvidenceAttribution } from '../src/evidence-corrections.mjs';
import { evaluateEvidenceCluster } from '../src/evidence-policy.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('Use --output <new JSON path>');
const draft = Object.fromEntries(['title','persona','jobToBeDone','currentWorkflow','desiredOutcome',
  'aiPath','humanGates','counterEvidence','unknowns'].map(key => [key, 'Synthetic attribution-review example']));
const observations = ['a','b','c'].map(key => ({evidenceKey: key, authorGroup: `author-${key}`,
  quote: `Original synthetic source ${key}`, sourcePolicy: 'synthetic-forum', sourceAccessible: true,
  rightsApproved: true, containsPersonalData: false}));
const initial = addEvidence({draft}, observations, {observedAt: '2026-10-30T12:00:00Z'});
const corrected = correctEvidenceAttribution(initial, {expectedDigest: evidenceCorrectionDigest(initial),
  evidenceKeys: ['a','b','c'], patch: {originGroup: 'same-synthetic-organization'},
  actor: 'synthetic-reviewer', reason: 'The supplied source annotations identify one shared organization.',
  recordedAt: '2026-10-31T12:00:00Z'});
const restored = revertEvidenceAttribution(corrected, {expectedDigest: evidenceCorrectionDigest(corrected),
  eventId: corrected.provenance_corrections[0].id, actor: 'synthetic-reviewer',
  reason: 'Withdraw the synthetic organization annotation after review.', recordedAt: '2026-10-31T13:00:00Z'});
let staleRejected = false;
try { correctEvidenceAttribution(corrected, {expectedDigest: evidenceCorrectionDigest(initial),
  evidenceKeys: ['a'], patch: {authorGroup: 'replacement'}, actor: 'synthetic-reviewer',
  reason: 'This deliberately stale edit must not apply.', recordedAt: '2026-10-31T14:00:00Z'}); }
catch (error) { assert.match(error.message, /EVIDENCE_CORRECTION_STALE_INPUT/); staleRejected = true; }
assert.deepEqual(initial.observations, observations);
assert.equal(corrected.independent_evidence, 1); assert.equal(evaluateEvidenceCluster(corrected).eligible, false);
assert.deepEqual(restored.observations, observations); assert.equal(restored.independent_evidence, 3);
assert.equal(restored.provenance_corrections.length, 2); assert.equal(staleRejected, true);
for (const state of [corrected, restored]) {
  assert.equal(state.independent_evidence_added, 0);
  assert.equal(state.last_seen, initial.last_seen);
  assert.equal(state.last_new_independent_evidence, initial.last_new_independent_evidence);
  assert.equal(state.validation.status, 'UNVALIDATED');
}
const view = state => ({captureCount: state.observations.length, independentEvidence: state.independent_evidence,
  evidenceGateEligible: evaluateEvidenceCluster(state).eligible, validationStatus: state.validation.status,
  independentRecencyVerified: assessOpportunityFreshness(state, {asOf: '2026-10-31T14:00:00Z'}).independentEvidence.verified,
  newIndependentEvidence: state.independent_evidence_added, lastSeen: state.last_seen,
  lastNewIndependentEvidence: state.last_new_independent_evidence, auditEvents: state.provenance_corrections?.length ?? 0});
const report = {schemaVersion: 1, syntheticOnly: true, modelCalls: 0, publicationActions: 0, databaseWrites: 0,
  steps: {initial: view(initial), corrected: view(corrected), restored: view(restored)}, staleRejected,
  originalSources: observations, correctionHistory: restored.provenance_corrections,
  note: 'Gate eligibility is not publication or business validation. Undo restores sources and retains audit; it does not recertify recency invalidated by consolidation.'};
await writeFile(args[1], JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
process.stdout.write(JSON.stringify({status: 'PASS', ...report.steps, staleRejected, modelCalls: 0, publicationActions: 0}) + '\n');
