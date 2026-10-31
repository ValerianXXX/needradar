import { evaluateEvidenceCluster, PUBLICATION_RULES } from './evidence-policy.mjs';
import { findLikelyDuplicate } from './similarity.mjs';
import { reviewDuplicates } from './semantic-review.mjs';
import { lexicalCandidateIndex } from './semantic-retrieval.mjs';
import { captureInput } from './input-snapshot.mjs';

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
    lexicalCandidateIndex(existingOpportunities),
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

  if (similarity.requiresReview) {
    return { decision: 'REVIEW', reasons: ['SEMANTIC_REVIEW_REQUIRED'], evidence, similarity };
  }

  return {
    decision: 'PUBLISH',
    reasons: ['EVIDENCE_COMPLETE', 'DISTINCT_FROM_PUBLISHED_BRIEFS'],
    evidence,
    similarity,
  };
}

export async function decidePublicationWithReview(cluster, existingOpportunities, options = {}) {
  const input = captureInput(() => ({ cluster, rules: options.rules ?? PUBLICATION_RULES }));
  const initial = structuredClone(decidePublication(input.snapshot.cluster, existingOpportunities,
    { ...options, rules: input.snapshot.rules }));
  if (initial.decision === 'HOLD') return initial;
  const semantic = await reviewDuplicates(cluster.draft, existingOpportunities, options);
  if (input.changed() || semantic.inputChanged) return { ...initial, decision: 'REVIEW', semantic,
    reasons: ['REVIEW_INPUT_CHANGED'], inputChanged: true, automaticMerge: false };
  const decision = semantic.duplicate ? 'SUPPRESS_DUPLICATE' : semantic.requiresReview ? 'REVIEW' : 'PUBLISH';
  return { ...initial, decision, semantic,
    reasons: [semantic.duplicate ? 'REVIEWED_DUPLICATE_PROPOSAL' : semantic.requiresReview ? 'SEMANTIC_REVIEW_REQUIRED' : 'REVIEWED_DISTINCT'],
    automaticMerge: false };
}

