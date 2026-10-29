import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEvidenceUrl, evidenceSummary } from '../src/provenance.mjs';
import { addEvidence, recordPairDecision } from '../src/opportunity-state.mjs';
import { pairDigest, reviewDuplicates } from '../src/semantic-review.mjs';
import { findLikelyDuplicate } from '../src/similarity.mjs';

const draft = { id: 'a', title: 'Invoice uncertainty review', persona: 'Accounts payable reviewers',
  jobToBeDone: 'Review uncertain supplier invoice fields against original images.', desiredOutcome: 'A source-linked review queue',
  constraints: { processing: 'offline' } };
const observation = (key, extra = {}) => ({ evidenceKey: key, authorGroup: `author-${key}`, sourcePolicy: `policy-${key}`,
  sourceAccessible: true, rightsApproved: true, containsPersonalData: false, ...extra });
const decision = (left, right, verdict, timestamp = '2026-10-29T12:00:00Z') => recordPairDecision(left, right,
  { digest: pairDigest(left, right), decision: verdict, actor: 'synthetic-reviewer', reason: 'Compared the actual task and boundaries', recordedAt: timestamp });

test('an exact opportunity does not become novel when only its title changes', () => {
  const result = findLikelyDuplicate(draft, [{ ...draft, title: 'Alternative presentation' }]);
  assert.equal(result.best.autoDuplicate, true);
  assert.equal(result.duplicate, true);
});

test('malformed identity values do not become matching literal object strings', async () => {
  for (const key of ['persona', 'jobToBeDone', 'desiredOutcome']) {
    for (const value of [{}, ['untrusted'], 42, true]) {
      const malformed = { ...draft, [key]: value };
      assert.equal(findLikelyDuplicate(malformed, [malformed]).duplicate, false, key);
      assert.equal((await reviewDuplicates(malformed, [malformed])).requiresReview, true, key);
    }
  }
});

test('different URL fragments can identify independent comments on one page', () => {
  const observations = [observation('a', { url: 'https://evidence.example.test/thread#comment-a' }),
    observation('b', { url: 'https://evidence.example.test/thread#comment-b' })];
  assert.equal(evidenceSummary(observations).uniqueEvidenceCount, 2);
  assert.equal(evidenceSummary(observations).independentEvidenceCount, 2);
  assert.equal(canonicalEvidenceUrl('https://evidence.example.test/thread?utm_source=copy#comment-a'),
    'https://evidence.example.test/thread#comment-a');
});

test('conflicting original authors do not acquire independence from input order', () => {
  const contentHash = 'sha256:' + 'b'.repeat(64);
  const observations = [observation('a', { contentHash }), observation('b', { contentHash })];
  for (const rows of [observations, [...observations].reverse()]) {
    const result = evidenceSummary(rows);
    assert.equal(result.uniqueEvidenceCount, 1);
    assert.equal(result.independentEvidenceCount, 0);
    assert.equal(result.unresolvedProvenanceCount, 1);
  }
});

test('an explicit original reference resolves a repost without discarding any capture', () => {
  const contentHash = 'sha256:' + 'c'.repeat(64);
  const observations = [observation('original', { contentHash }), observation('unannotated-mirror', { contentHash }),
    observation('repost', { repostOf: 'original' })];
  for (const rows of [observations, [...observations].reverse()]) {
    const result = evidenceSummary(rows);
    assert.equal(result.independentEvidenceCount, 1);
    assert.equal(result.groups[0].original.evidenceKey, 'original');
    assert.equal(result.groups[0].observations.length, 3);
  }
});

test('a new independent observation is counted even when another input joins two old groups', () => {
  const before = addEvidence(draft, [observation('a'), observation('b')], { observedAt: '2026-10-28T12:00:00Z' });
  const after = addEvidence(before, [observation('bridge', { originKey: 'a', repostOf: 'b' }), observation('new')],
    { observedAt: '2026-10-29T12:00:00Z' });
  assert.equal(after.evidence_added, 1);
  assert.equal(after.independent_evidence_added, 1);
  assert.equal(after.observations.length, 4);
  assert.equal(before.observations.length, 2);
});

test('human correction applies to either comparison direction and expires on changed content', async () => {
  const right = { ...draft, id: 'b', title: 'Alternative wording' };
  const event = decision(draft, right, 'different');
  const reverse = await reviewDuplicates(right, [draft], { humanDecisions: [event] });
  assert.equal(reverse.reviews[0].verdict, 'different');
  assert.equal(reverse.reviews[0].method, 'HUMAN_DECISION');
  const changed = await reviewDuplicates({ ...right, jobToBeDone: 'Another task' }, [draft], { humanDecisions: [event] });
  assert.equal(changed.reviews[0].verdict, 'uncertain');
});

test('same-time conflicting human decisions are uncertain regardless of event order', async () => {
  const right = { ...draft, id: 'b' };
  const events = [decision(draft, right, 'same'), decision(draft, right, 'different')];
  for (const humanDecisions of [events, [...events].reverse()]) {
    const result = await reviewDuplicates(draft, [right], { humanDecisions });
    assert.equal(result.reviews[0].verdict, 'uncertain');
    assert.equal(result.reviews[0].method, 'HUMAN_DECISION_CONFLICT');
    assert.equal(result.automaticMerge, false);
  }
  const resolved = await reviewDuplicates(draft, [right], { humanDecisions: [...events, decision(draft, right, 'different', '2026-10-29T13:00:00Z')] });
  assert.equal(resolved.reviews[0].verdict, 'different');
});

test('human same proposals cannot bypass conflicting or incomplete current boundaries', async () => {
  for (const [right, verdict] of [
    [{ ...draft, id: 'b', constraints: { processing: 'cloud' } }, 'different'],
    [{ ...draft, id: 'b', constraints: {} }, 'uncertain'],
    [{ ...draft, id: 'b', persona: null }, 'uncertain'],
  ]) {
    const event = decision(draft, right, 'same');
    const result = await reviewDuplicates(draft, [right], { humanDecisions: [event] });
    assert.equal(result.reviews[0].verdict, verdict);
    assert.equal(result.reviews[0].reviewId, event.id);
    assert.equal(result.reviews[0].method, 'HUMAN_DECISION_BLOCKED');
    assert.equal(result.automaticMerge, false);
  }
});
