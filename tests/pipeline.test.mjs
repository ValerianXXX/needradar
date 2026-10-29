import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEvidenceCluster } from '../src/evidence-policy.mjs';
import { decidePublication } from '../src/pipeline.mjs';
import { opportunitySimilarity } from '../src/similarity.mjs';

const completeDraft = {
  title: 'Preserve source images when OCR confidence is low',
  persona: 'Specialist document operations teams',
  jobToBeDone: 'Route uncertain OCR regions to review while preserving original pixels and coordinates',
  currentWorkflow: 'Operators compare extracted text with the original image and correct errors manually',
  desiredOutcome: 'A review queue that keeps source evidence and correction history together',
  aiPath: ['Detect low-confidence regions', 'Prioritize review', 'Retain corrections'],
  humanGates: ['A specialist approves uncertain text'],
  counterEvidence: ['High-quality documents may not need a specialist workflow'],
  unknowns: ['Representative error rate and reviewer time'],
};

function observation(id, authorGroup, sourcePolicy) {
  return {
    evidenceKey: id,
    authorGroup,
    sourcePolicy,
    sourceAccessible: true,
    containsPersonalData: false,
    rightsApproved: true,
  };
}

test('holds a complete draft when evidence is not sufficiently independent', () => {
  const result = evaluateEvidenceCluster({
    draft: completeDraft,
    observations: [observation('a', 'author-1', 'policy-1'), observation('b', 'author-1', 'policy-1')],
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('INSUFFICIENT_INDEPENDENCE'));
});

test('accepts independence through three author groups', () => {
  const result = evaluateEvidenceCluster({
    draft: completeDraft,
    observations: [
      observation('a', 'author-1', 'policy-1'),
      observation('b', 'author-2', 'policy-1'),
      observation('c', 'author-3', 'policy-1'),
    ],
  });
  assert.equal(result.eligible, true);
});

test('filters inaccessible or personal-data observations before applying thresholds', () => {
  const unsafe = { ...observation('b', 'author-2', 'policy-2'), containsPersonalData: true };
  const result = evaluateEvidenceCluster({
    draft: completeDraft,
    observations: [observation('a', 'author-1', 'policy-1'), unsafe],
  });
  assert.equal(result.accessibleCount, 1);
  assert.equal(result.eligible, false);
});

test('suppresses a candidate that substantially repeats a published brief', () => {
  const cluster = {
    draft: completeDraft,
    observations: [
      observation('a', 'author-1', 'policy-1'),
      observation('b', 'author-2', 'policy-2'),
    ],
  };
  const existing = [{ ...completeDraft, evidenceKeys: ['a', 'b'] }];
  const result = decidePublication(cluster, existing);
  assert.equal(result.decision, 'SUPPRESS_DUPLICATE');
  assert.ok(result.similarity.best.score >= result.similarity.threshold);
});

test('requires semantic review before asserting low-overlap drafts are distinct', () => {
  const cluster = {
    draft: completeDraft,
    observations: [
      observation('ocr-1', 'author-1', 'policy-1'),
      observation('ocr-2', 'author-2', 'policy-2'),
    ],
  };
  const existing = [{
    title: 'Make vector-search migrations predictable',
    persona: 'Search infrastructure teams',
    jobToBeDone: 'Reconcile index state and retrieval consistency during a storage migration',
    evidenceKeys: ['vector-1', 'vector-2'],
  }];
  const result = decidePublication(cluster, existing);
  assert.equal(result.decision, 'REVIEW');
  assert.ok(result.reasons.includes('SEMANTIC_REVIEW_REQUIRED'));
});

test('reports transparent similarity components', () => {
  const result = opportunitySimilarity(
    { ...completeDraft, evidenceKeys: ['a'] },
    { ...completeDraft, evidenceKeys: ['a', 'b'] },
  );
  assert.equal(result.components.title, 1);
  assert.equal(result.components.job, 1);
  assert.equal(result.components.persona, 1);
  assert.equal(result.components.evidence, 0.5);
});

