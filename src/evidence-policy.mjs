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
  const observations = qualifyingObservations(cluster.observations);
  const accessibleCount = observations.length;
  const independentAuthorGroups = new Set(observations.map((item) => item.authorGroup).filter(Boolean)).size;
  const sourcePolicies = new Set(observations.map((item) => item.sourcePolicy).filter(Boolean)).size;
  const missingFields = rules.requiredDraftFields.filter((field) => !hasValue(cluster.draft?.[field]));

  const sufficientVolume = accessibleCount >= rules.minimumAccessibleObservations;
  const sufficientIndependence =
    independentAuthorGroups >= rules.minimumIndependentAuthorGroups ||
    sourcePolicies >= rules.minimumSourcePolicies;
  const completeDraft = missingFields.length === 0;

  const reasons = [];
  if (!sufficientVolume) reasons.push('INSUFFICIENT_ACCESSIBLE_EVIDENCE');
  if (!sufficientIndependence) reasons.push('INSUFFICIENT_INDEPENDENCE');
  if (!completeDraft) reasons.push(`MISSING_FIELDS:${missingFields.join(',')}`);

  return {
    eligible: sufficientVolume && sufficientIndependence && completeDraft,
    accessibleCount,
    independentAuthorGroups,
    sourcePolicies,
    missingFields,
    reasons,
  };
}

