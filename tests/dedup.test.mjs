import test from 'node:test';
import assert from 'node:assert/strict';
import { cases } from '../eval/dedup-cases.mjs';
import { tokenize, jaccard, findLikelyDuplicate, retrieveCandidates } from '../src/similarity.mjs';
import { evidenceSummary } from '../src/provenance.mjs';
import { reviewDuplicates, pairDigest } from '../src/semantic-review.mjs';
import { addEvidence, recordPairDecision, recordValidation } from '../src/opportunity-state.mjs';
import { decidePublicationWithReview } from '../src/pipeline.mjs';
import { createResponsesReviewer } from '../src/responses-reviewer.mjs';
import { createCommandReviewer } from '../src/command-reviewer.mjs';
import { evaluateEvidenceCluster } from '../src/evidence-policy.mjs';

const sample = cases[0].left;
const observation = (evidenceKey, extra = {}) => ({ evidenceKey, authorGroup: `author-${evidenceKey}`, sourcePolicy: `policy-${evidenceKey}`,
  sourceAccessible: true, containsPersonalData: false, rightsApproved: true, ...extra });

test('Chinese survives normalization and exact text deduplicates across evidence keys', () => {
  const zh = cases.find((row) => row.id === 'same-chinese');
  assert.ok(tokenize(zh.left.jobToBeDone).length > 1);
  assert.equal(jaccard(zh.left.jobToBeDone, zh.right.jobToBeDone), 1);
  for (const id of ['same-new-evidence', 'same-chinese']) {
    const row = cases.find((item) => item.id === id), result = findLikelyDuplicate(row.left, [row.right]);
    assert.equal(result.duplicate, true);
    assert.equal(result.best.components.evidence, 0);
    assert.equal(result.best.score, 1);
  }
});

test('shared personas, nearby needs, negation and constraints never auto-merge', () => {
  for (const row of cases.filter((item) => item.expected === 'different')) {
    assert.equal(findLikelyDuplicate(row.left, [row.right]).duplicate, false, row.id);
  }
  assert.equal(findLikelyDuplicate({ ...sample, desiredOutcome: 'Retain original' },
    [{ ...sample, desiredOutcome: 'Delete original' }]).duplicate, false);
});

test('small-corpus retrieval retains cross-language and zero-overlap paraphrases', async () => {
  for (const id of ['same-bilingual', 'same-paraphrase']) {
    const row = cases.find((item) => item.id === id);
    assert.equal(retrieveCandidates(row.left, [row.right]).rows.length, 1);
    const offline = await reviewDuplicates(row.left, [row.right]);
    assert.equal(offline.requiresReview, true);
    // Contract stub proves validation/transport integration, not model quality.
    const result = await reviewDuplicates(row.left, [row.right], { reviewer: async () => ({ decision: {
      verdict: 'same', reason: 'SAME_TASK_AND_CONSTRAINTS', leftQuote: row.left.jobToBeDone, rightQuote: row.right.jobToBeDone,
    }, model: 'contract-stub' }) });
    assert.equal(result.duplicate, true);
    assert.equal(result.automaticMerge, false);
  }
});

test('invalid, failed, ungrounded and over-budget reviewers fail to human review', async () => {
  const row = cases.find((item) => item.id === 'same-paraphrase');
  for (const reviewer of [async () => { throw new Error('provider unavailable'); }, async () => ({ decision: {
    verdict: 'same', reason: 'SAME_TASK_AND_CONSTRAINTS', leftQuote: 'fabricated text', rightQuote: 'invented text',
  } })]) {
    const result = await reviewDuplicates(row.left, [row.right], { reviewer });
    assert.equal(result.duplicate, false);
    assert.equal(result.requiresReview, true);
  }
  let calls = 0;
  const budgeted = await reviewDuplicates(row.left, Array.from({ length: 3 }, () => row.right), {
    maxModelCalls: 1, reviewer: async () => { calls++; throw new Error('stop'); },
  });
  assert.equal(calls, 1);
  assert.equal(budgeted.modelCalls, 1);
  const large = await reviewDuplicates(row.left, Array.from({ length: 70 }, () => row.right), { limit: 3 });
  assert.equal(large.retrievalComplete, false);
  assert.equal(large.requiresReview, true);
});

test('reposts, repeat crawls, tracking URLs and copied content count once', () => {
  const hash = 'sha256:' + 'a'.repeat(64);
  const records = [observation('a', { url: 'https://example.test/post?utm_source=x', contentHash: hash }),
    observation('crawl-2', { url: 'https://example.test/post#reply', contentHash: hash }),
    observation('copy', { repostOf: 'a' }), observation('mirror', { contentHash: hash })];
  const result = evidenceSummary(records);
  assert.equal(result.uniqueEvidenceCount, 1);
  assert.equal(result.independentEvidenceCount, 1);
  assert.equal(result.duplicateCaptures, 3);
  assert.equal(result.groups[0].observations.length, 4);
  assert.equal(evidenceSummary([observation('unresolved', { repostOf: 'missing' })]).independentEvidenceCount, 0);
});

test('new evidence, last_seen, counterevidence and validation are separate state', () => {
  const before = addEvidence({ ...sample, id: 'opp-1' }, [observation('a')], { observedAt: '2026-10-26T12:00:00Z' });
  const repeated = addEvidence(before, [observation('a')], { observedAt: '2026-10-27T12:00:00Z' });
  assert.equal(repeated.evidence_added, 0);
  assert.equal(repeated.last_seen, '2026-10-27T12:00:00.000Z');
  assert.equal(repeated.validation.status, 'UNVALIDATED');
  const counter = addEvidence(repeated, [observation('b', { stance: 'counterevidence' })], { observedAt: '2026-10-27T13:00:00Z' });
  assert.deepEqual(counter.counterevidence, ['b']);
  assert.equal(before.observations.length, 1);
  assert.throws(() => recordValidation(counter, { status: 'PILOT_OBSERVED', evidenceKeys: ['invented'], actor: 'reviewer', recordedAt: '2026-10-27T14:00:00Z' }));
  const valid = recordValidation(counter, { status: 'INVALIDATED', evidenceKeys: ['b'], actor: 'reviewer', recordedAt: '2026-10-27T14:00:00Z' });
  assert.equal(valid.validation.status, 'INVALIDATED');
});

test('human correction is reversible and bound to the actual compared content', () => {
  const right = cases[0].right;
  const review = { digest: pairDigest(sample, right), decision: 'different', actor: 'reviewer', reason: 'Different operational constraint', recordedAt: '2026-10-27T00:00:00Z' };
  const result = recordPairDecision(sample, right, review);
  assert.equal(result.reversible, true);
  assert.deepEqual(result.originals, [sample, right]);
  assert.throws(() => recordPairDecision({ ...sample, jobToBeDone: 'Changed task' }, right, review));
});

test('optional provider requires explicit cloud opt-in and validates completed no-tool output', async () => {
  assert.throws(() => createResponsesReviewer({ apiKey: 'synthetic', model: 'test' }));
  const decision = { verdict: 'different', reason: 'DIFFERENT_TASK', leftQuote: sample.jobToBeDone, rightQuote: cases[6].right.jobToBeDone };
  let body;
  const reviewer = createResponsesReviewer({ apiKey: 'synthetic', model: 'test', allowCloud: true,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: 'completed', model: 'test', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(decision) }] }] }));
    } });
  const result = await reviewer({ protocol: 'test', left: sample, right: cases[6].right, schema: {} });
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.deepEqual(result.decision, decision);
  assert.equal(result.costUsd, null);
});

test('counterevidence cannot satisfy supporting-demand gates and rejected captures do not advance last_seen', () => {
  const checked = evaluateEvidenceCluster({ observations: [observation('a'), observation('b', { stance: 'counterevidence' })] });
  assert.equal(checked.accessibleCount, 1);
  assert.equal(checked.counterevidenceCount, 1);
  assert.equal(checked.eligible, false);
  const item = addEvidence({}, [observation('private', { containsPersonalData: true })], { observedAt: '2026-10-27T00:00:00Z' });
  assert.equal(item.last_seen, null);
});

test('human correction actually controls the async publication decision and expires when content changes', async () => {
  const complete = { ...sample, currentWorkflow: 'Manual', desiredOutcome: 'Audited', aiPath: ['Review'], humanGates: ['Confirm'], counterEvidence: ['Manual works'], unknowns: ['Time saved'] };
  const peer = { ...complete };
  const cluster = { draft: complete, observations: [observation('a'), observation('b')] };
  const event = recordPairDecision(complete, peer, { digest: pairDigest(complete, peer), decision: 'different', actor: 'human', reason: 'Different scope confirmed', recordedAt: '2026-10-27T00:00:00Z' });
  const result = await decidePublicationWithReview(cluster, [peer], { humanDecisions: [event] });
  assert.equal(result.decision, 'PUBLISH');
  assert.equal(result.semantic.reviews[0].method, 'HUMAN_DECISION');
  const changed = await reviewDuplicates({ ...complete, jobToBeDone: 'Another task entirely' }, [peer], { humanDecisions: [event] });
  assert.equal(changed.requiresReview, true);
});

test('command transport requires opt-in, sends JSON on stdin and rejects tools or invalid output', async () => {
  assert.throws(() => createCommandReviewer({ executable: process.execPath }));
  for (const toolCalls of [0, 1]) {
    const reviewer = createCommandReviewer({ executable: process.execPath, allowExecution: true,
      args: ['--input-type=module', '-e', `let s='';for await(const c of process.stdin)s+=c;const r=JSON.parse(s);console.log(JSON.stringify({decision:r,model:'contract-stub',toolCalls:${toolCalls}}));`] });
    if (toolCalls) await assert.rejects(reviewer({ verdict: 'same' }));
    else assert.equal((await reviewer({ verdict: 'same' })).decision.verdict, 'same');
  }
});
