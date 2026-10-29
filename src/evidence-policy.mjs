import { evidenceSummary } from './provenance.mjs';

export const PUBLICATION_RULES = Object.freeze({
  minimumAccessibleObservations: 2,
  minimumIndependentAuthorGroups: 3,
  minimumSourcePolicies: 2,
  requiredDraftFields: [
    'title',
    'persona',
    'jobToBeDone',
    'currentWorkflow',
    'desiredOutcome',
    'aiPath',
    'humanGates',
    'counterEvidence',
    'unknowns',
  ],
});

function hasValue(value) {
  if (Array.isArray(value)) return value.some((item) => String(item).trim().length > 0);
  return typeof value === 'string' && value.trim().length > 0;
}

export function qualifyingObservations(observations = []) {
  return observations.filter((observation) =>
    observation.sourceAccessible === true &&
    observation.containsPersonalData !== true &&
    observation.rightsApproved === true,
  );
}

export function evaluateEvidenceCluster(cluster, rules = PUBLICATION_RULES) {
  const qualified = qualifyingObservations(cluster.observations);
  const observations = qualified.filter((item) => !item.stance || item.stance === 'supporting');
  const provenance = evidenceSummary(observations);
  const accessibleCount = provenance.uniqueEvidenceCount;
  const { independentAuthorGroups, sourcePolicies, independentEvidenceCount } = provenance;
  const missingFields = rules.requiredDraftFields.filter((field) => !hasValue(cluster.draft?.[field]));

  const sufficientVolume = accessibleCount >= rules.minimumAccessibleObservations;
  const sufficientIndependence =
    independentAuthorGroups >= rules.minimumIndependentAuthorGroups ||
    (sourcePolicies >= rules.minimumSourcePolicies && independentEvidenceCount >= 2);
  const completeDraft = missingFields.length === 0;

  const reasons = [];
  if (!sufficientVolume) reasons.push('INSUFFICIENT_ACCESSIBLE_EVIDENCE');
  if (!sufficientIndependence) reasons.push('INSUFFICIENT_INDEPENDENCE');
  if (!completeDraft) reasons.push(`MISSING_FIELDS:${missingFields.join(',')}`);

  return {
    eligible: sufficientVolume && sufficientIndependence && completeDraft,
    accessibleCount,
    counterevidenceCount: evidenceSummary(qualified.filter((item) => item.stance === 'counterevidence')).uniqueEvidenceCount,
    independentAuthorGroups,
    sourcePolicies,
    independentEvidenceCount,
    duplicateCaptures: provenance.duplicateCaptures,
    unresolvedProvenanceCount: provenance.unresolvedProvenanceCount,
    missingFields,
    reasons,
  };
}

