import { createHash } from 'node:crypto';
import { evidenceSummary } from './provenance.mjs';
import { qualifyingObservations } from './evidence-policy.mjs';
import { pairDigest } from './semantic-review.mjs';

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError('VALID_TIMESTAMP_REQUIRED');
  }
  return new Date(value).toISOString();
}

export function addEvidence(opportunity, observations, { observedAt } = {}) {
  const seenAt = timestamp(observedAt);
  const prior = opportunity.observations ?? [];
  const accepted = qualifyingObservations(observations);
  const combined = [...prior, ...accepted];
  const before = evidenceSummary(prior), after = evidenceSummary(combined);
  const lastSeen = opportunity.last_seen ? timestamp(opportunity.last_seen) : seenAt;
  return { ...structuredClone(opportunity), observations: structuredClone(combined),
    last_seen: accepted.length ? (lastSeen > seenAt ? lastSeen : seenAt) : (opportunity.last_seen ?? null),
    evidence_added: Math.max(0, after.uniqueEvidenceCount - before.uniqueEvidenceCount),
    independent_evidence: after.independentEvidenceCount,
    duplicate_captures: after.duplicateCaptures,
    counterevidence: [...new Set(combined.filter((item) => item.stance === 'counterevidence').map((item) => item.evidenceKey))],
    validation: structuredClone(opportunity.validation ?? { status: 'UNVALIDATED', events: [] }),
  };
}

export function recordValidation(opportunity, { status, evidenceKeys, recordedAt, actor } = {}) {
  if (!['UNVALIDATED', 'INTERVIEWED', 'PILOT_OBSERVED', 'OUTCOME_OBSERVED', 'INVALIDATED'].includes(status)
      || typeof actor !== 'string' || !actor.trim() || !Array.isArray(evidenceKeys) || !evidenceKeys.length
      || evidenceKeys.some((key) => !(opportunity.observations ?? []).some((item) => item.evidenceKey === key))) {
    throw new Error('VALIDATION_EVIDENCE_REQUIRED');
  }
  const event = { status, evidenceKeys: [...evidenceKeys], recordedAt: timestamp(recordedAt), actor };
  if ((opportunity.validation?.events ?? []).some((item) => timestamp(item.recordedAt) >= event.recordedAt)) {
    throw new Error('VALIDATION_EVENT_MUST_ADVANCE');
  }
  return { ...structuredClone(opportunity), validation: { status,
    events: [...(opportunity.validation?.events ?? []), event] } };
}

export function recordPairDecision(left, right, { digest, decision, actor, reason, recordedAt } = {}) {
  if (digest !== pairDigest(left, right) || !['same', 'different', 'uncertain'].includes(decision)
      || typeof actor !== 'string' || !actor.trim() || typeof reason !== 'string' || !reason.trim()) {
    throw new Error('CURRENT_HUMAN_REVIEW_REQUIRED');
  }
  const event = { digest, decision, actor, reason, recordedAt: timestamp(recordedAt) };
  return { ...event, id: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
    reversible: true, originals: structuredClone([left, right]) };
}
