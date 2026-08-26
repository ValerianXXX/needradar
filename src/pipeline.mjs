import { evaluateEvidenceCluster } from './evidence-policy.mjs';
import { findLikelyDuplicate } from './similarity.mjs';

export function decidePublication(cluster, existingOpportunities, options = {}) {
  const evidence = evaluateEvidenceCluster(cluster, options.rules);
  if (!evidence.eligible) {
    return {
      decision: 'HOLD',
      reasons: evidence.reasons,
      evidence,
      similarity: null,
    };
  }

  const candidate = {
    ...cluster.draft,
    evidenceKeys: cluster.observations
      .filter((item) => item.sourceAccessible && !item.containsPersonalData && item.rightsApproved)
      .map((item) => item.evidenceKey),
  };
  const similarity = findLikelyDuplicate(
    candidate,
    existingOpportunities,
    options.similarityThreshold ?? 0.78,
  );

  if (similarity.duplicate) {
    return {
      decision: 'SUPPRESS_DUPLICATE',
      reasons: ['LIKELY_SEMANTIC_DUPLICATE'],
      evidence,
      similarity,
    };
  }

  return {
    decision: 'PUBLISH',
    reasons: ['EVIDENCE_COMPLETE', 'DISTINCT_FROM_PUBLISHED_BRIEFS'],
    evidence,
    similarity,
  };
}

