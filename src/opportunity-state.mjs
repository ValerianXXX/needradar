import { createHash } from 'node:crypto';
import { evidenceSummary } from './provenance.mjs';
import { qualifyingObservations } from './evidence-policy.mjs';
import { pairDigest } from './semantic-review.mjs';
import { timestamp } from './timestamps.mjs';

export function addEvidence(opportunity, observations, { observedAt } = {}) {
  const seenAt = timestamp(observedAt);
  const prior = opportunity.observations ?? [];
  const accepted = qualifyingObservations(observations);
  const combined = [...prior, ...accepted];
  const before = evidenceSummary(prior), after = evidenceSummary(combined);
  const lastSeen = opportunity.last_seen ? timestamp(opportunity.last_seen) : seenAt;
  const priorCaptures = new Set(prior), priorOrigins = new Set(before.independentOriginIds);
  const newIndependent = after.independentOriginIds.filter(id => !priorOrigins.has(id)).length;
  const lastIndependent = opportunity.last_new_independent_evidence ? timestamp(opportunity.last_new_independent_evidence) : seenAt;
  return { ...structuredClone(opportunity), observations: structuredClone(combined),
    last_seen: accepted.length ? (lastSeen > seenAt ? lastSeen : seenAt) : (opportunity.last_seen ?? null),
    evidence_added: after.groups.filter(group => group.observations.every(item => !priorCaptures.has(item))).length,
    independent_evidence_added: newIndependent,
    last_new_independent_evidence: newIndependent ? (lastIndependent > seenAt ? lastIndependent : seenAt) : (opportunity.last_new_independent_evidence ?? null),
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

// Deterministic review scheduling, not a calibrated probability of demand.
// Recaptures can update last_seen without refreshing independent evidence.
// Never silently invalidate a recorded interview, pilot or business outcome.
export function assessOpportunityFreshness(opportunity, { asOf, agingDays = 30, staleDays = 90 } = {}) {
  const checkedAt = timestamp(asOf);
  if (!Number.isInteger(agingDays) || !Number.isInteger(staleDays) || agingDays < 1 || staleDays <= agingDays
    || staleDays > 3650) throw new TypeError('INVALID_FRESHNESS_POLICY');
  const status = value => {
    if (value == null) return { status: 'UNKNOWN', at: null, ageDays: null };
    const at = timestamp(value), ageDays = (Date.parse(checkedAt) - Date.parse(at)) / 86400000;
    return { status: ageDays < 0 ? 'CLOCK_SKEW' : ageDays >= staleDays ? 'STALE' : ageDays >= agingDays ? 'AGING' : 'FRESH',
      at, ageDays: Number(ageDays.toFixed(4)) };
  };
  const lastSeen = status(opportunity.last_seen), independentEvidence = status(opportunity.last_new_independent_evidence);
  return { checkedAt, policy: { agingDays, staleDays, calibrated: false }, lastSeen, independentEvidence,
    requiresReview: [lastSeen, independentEvidence].some(item => item.status !== 'FRESH'),
    validation: structuredClone(opportunity.validation ?? { status: 'UNVALIDATED', events: [] }),
    counterevidenceKeys: [...(opportunity.counterevidence ?? [])],
    scope: 'Source and independent-origin recency only; no automatic publication, deletion, demand score or business validation.' };
}
