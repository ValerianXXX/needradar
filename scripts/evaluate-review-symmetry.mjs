// Offline component observations only. No provider or command-review adapter is loaded.
import { readFile, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { loadFixtures, fixtureHash } from '../eval/boundaries-v2/load.mjs';
import { readFrozenFollowupPlan } from './frozen-followup-plan.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) {
  if (!['--output', '--source-root'].includes(args[index]) || !args[index + 1] || options.has(args[index])) throw new Error('INVALID_EVALUATION_ARGUMENTS');
  options.set(args[index], args[index + 1]);
}
if (!options.has('--output')) throw new Error('NEW_OUTPUT_PATH_REQUIRED');
const repository = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = resolve(options.get('--source-root') ?? repository);
const moduleAt = name => import(pathToFileURL(resolve(sourceRoot, name)).href);
const { reviewDuplicates, pairDigest } = await moduleAt('src/semantic-review.mjs');
const { publicDraft } = await moduleAt('src/review-contract.mjs');
const { retrieveCandidates } = await moduleAt('src/similarity.mjs');
const { validateReviewJournal } = await moduleAt('src/review-journal.mjs');
const { decidePublicationWithReview } = await moduleAt('src/pipeline.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const lf = value => value.replaceAll('\r\n', '\n');
const sourceFiles = ['src/semantic-review.mjs', 'src/review-contract.mjs', 'src/review-journal.mjs',
  'src/review-journal-file.mjs', 'src/similarity.mjs', 'src/input-snapshot.mjs', 'src/pipeline.mjs'];
const sourceLFHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, hash(lf(await readFile(resolve(sourceRoot, file), 'utf8')))])));
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
const fixtures = await loadFixtures(), { plan, cases, protocolHash } = await readFrozenFollowupPlan();
const saved = async suffix => readFile(new URL(`../eval/results/2026-10-30-targeted-followup-${suffix}`, import.meta.url), 'utf8');
const historicalReceipt = JSON.parse(await saved('verification.json'));
for (const [file, expected] of Object.entries(historicalReceipt.publishedLFHashes)) {
  assert.equal(hash(lf(await readFile(new URL('../eval/results/' + file, import.meta.url), 'utf8'))), expected);
}
const journalText = await saved('proposals.json'), journal = JSON.parse(journalText);
const revision = hash(JSON.stringify([plan.runtime, plan.productLFHashes, protocolHash]));
validateReviewJournal(journal, revision);
const beforeJournal = JSON.stringify(journal), reversed = [];
const output = await open(resolve(options.get('--output')), 'wx');
try {
  const started = performance.now();
  for (const item of cases) {
    const result = await reviewDuplicates(item.right, [item.left], {
      reviewerRevision: revision, reviewJournal: journal, maxModelCalls: 0,
      reviewer: () => { throw new Error('REPLAY_MUST_NOT_CALL_PROVIDER'); },
    });
    assert.equal(result.modelCalls, 0);
    assert.equal(result.automaticMerge, false);
    assert.deepEqual(result.reviewJournal, journal);
    const row = result.reviews[0];
    if (row.method === 'MODEL_PROPOSAL_REUSED') {
      assert.equal(row.leftQuote, journal.events.find(event => event.type === 'RESULT'
        && event.pairDigest === pairDigest(item.left, item.right)).response.decision.rightQuote);
    }
    const cluster = { draft: { ...item.right, currentWorkflow: 'Synthetic manual review',
      aiPath: ['Prepare a comparison'], humanGates: ['Confirm interpretation'],
      counterEvidence: ['Existing manual work may suffice'], unknowns: ['Actual user benefit'] },
      observations: [0, 1, 2].map(index => ({ evidenceKey: `synthetic-${index}`, authorGroup: `synthetic-author-${index}`,
        sourcePolicy: `synthetic-policy-${index}`, sourceAccessible: true, rightsApproved: true, containsPersonalData: false })) };
    const policy = await decidePublicationWithReview(cluster, [item.left], {
      reviewerRevision: revision, reviewJournal: journal, maxModelCalls: 0,
      reviewer: () => { throw new Error('REPLAY_MUST_NOT_CALL_PROVIDER'); },
    });
    assert.equal(policy.evidence.eligible, true);
    assert.equal(policy.semantic.modelCalls, 0);
    assert.equal(policy.automaticMerge, false);
    reversed.push({ id: item.id, expected: item.expected, verdict: row.verdict, method: row.method,
      originalAttemptId: row.originalAttemptId ?? null, originalPairDigest: row.originalPairDigest ?? null,
      costUsd: row.costUsd ?? null, automaticMerge: result.automaticMerge, syntheticPolicyDecision: policy.decision });
  }
  assert.equal(JSON.stringify(journal), beforeJournal);

  // These are complete per-domain synthetic cohorts, not the global retrieval
  // population. Every non-deterministic response is explicitly uncertain.
  const cohorts = [];
  for (const domain of [...new Set(fixtures.cases.map(item => item.domain))]) {
    const drafts = new Map();
    for (const item of fixtures.cases.filter(item => item.domain === domain)) for (const draft of [item.left, item.right]) {
      drafts.set(JSON.stringify(publicDraft(draft)), publicDraft(draft));
    }
    const records = [...drafts.values()].map((draft, index) => ({ id: `${domain}-${index}`, ...draft }));
    assert.ok(records.length > 1 && records.length <= 64);
    let reviewJournal, callbacks = 0, selected = 0, uncertain = 0, cached = 0;
    const directed = new Set(), symmetric = new Set();
    for (const candidate of records) {
      const result = await reviewDuplicates(candidate, records.filter(record => record.id !== candidate.id), {
        reviewerRevision: 'EXPLICIT_UNCERTAIN_COHORT_STUB_V1', reviewJournal, maxModelCalls: 64,
        reviewer: async request => {
          callbacks++;
          const first = pairDigest(request.left, request.right), second = pairDigest(request.right, request.left);
          directed.add(first); symmetric.add([first, second].sort().join(':'));
          return { decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
            leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'EXPLICIT_UNCERTAIN_COHORT_STUB' };
        },
      });
      assert.equal(result.retrievalComplete, true);
      assert.equal(result.automaticMerge, false);
      selected += result.reviews.length;
      uncertain += result.reviews.filter(row => row.verdict === 'uncertain').length;
      cached += result.reviewProgress.cachedProposals;
      reviewJournal = JSON.parse(JSON.stringify(result.reviewJournal));
    }
    cohorts.push({ domain, records: records.length, selected, uncertain, stubCallbacks: callbacks,
      uniqueDirectedRequests: directed.size, uniqueSymmetricRelations: symmetric.size,
      redundantReverseCallbacks: callbacks - symmetric.size, reusedProposals: cached,
      journalEvents: reviewJournal.events.length, journalSHA256: hash(JSON.stringify(reviewJournal)) });
  }

  // A dry inspection of the existing global lexical queue; no encoder/model is
  // run and truncated retrieval is never promoted to complete coverage.
  const corpus = fixtures.cases.map(item => item.right), directed = new Set(), symmetric = new Set();
  let selected = 0, ambiguous = 0, incomplete = 0;
  for (const item of fixtures.cases) {
    const retrieval = retrieveCandidates(item.left, corpus);
    if (!retrieval.complete) incomplete++;
    for (const row of retrieval.rows) {
      selected++;
      if (row.autoDuplicate || row.constraints.conflicts.length) continue;
      ambiguous++;
      const a = pairDigest(item.left, row.existing), b = pairDigest(row.existing, item.left);
      directed.add(a); symmetric.add([a, b].sort().join(':'));
    }
  }
  const result = { observedAt: new Date().toISOString(), mode: 'OFFLINE_SAVED_PROPOSALS_AND_EXPLICIT_UNCERTAIN_STUBS',
    syntheticOnly: true, sourceCommit, sourceLFHashes, evaluatorLFHash: hash(lf(await readFile(fileURLToPath(import.meta.url), 'utf8'))),
    fixtureHash, historicalProtocolHash: protocolHash, historicalJournalLFHash: hash(lf(journalText)), node: process.version,
    reversed: { pairs: reversed.length, reused: reversed.filter(row => row.method === 'MODEL_PROPOSAL_REUSED').length,
      falseMerge: reversed.filter(row => row.expected === 'different' && row.verdict === 'same').length,
      falseDistinct: reversed.filter(row => row.expected === 'same' && row.verdict === 'different').length,
      unresolved: reversed.filter(row => row.verdict === 'uncertain').length,
      unresolvedDuplicates: reversed.filter(row => row.expected === 'same' && row.verdict === 'uncertain').length,
      syntheticPolicyDecisions: Object.fromEntries(['REVIEW', 'SUPPRESS_DUPLICATE', 'PUBLISH']
        .map(value => [value, reversed.filter(row => row.syntheticPolicyDecision === value).length])),
      rows: reversed, newProviderCalls: 0, originalProviderCostUsd: null },
    cohortSummary: { cohorts: cohorts.length, completePerDomainQueues: cohorts.length,
      stubCallbacks: cohorts.reduce((n, row) => n + row.stubCallbacks, 0),
      redundantReverseCallbacks: cohorts.reduce((n, row) => n + row.redundantReverseCallbacks, 0),
      selected: cohorts.reduce((n, row) => n + row.selected, 0),
      uncertain: cohorts.reduce((n, row) => n + row.uncertain, 0) }, cohorts,
    globalLexicalQueueInspection: { queries: fixtures.cases.length, selected, ambiguous,
      directedContentPairs: directed.size, uniqueSymmetricRelations: symmetric.size, incompleteQueries: incomplete,
      modelExecution: 'NOT_RUN', hybridEncoderExecution: 'NOT_RUN', authorization: 'No new campaign authorized by this inspection' },
    elapsedMs: performance.now() - started, newProviderCalls: 0, humanReviewSeconds: null, deploymentActions: 0,
    limitations: ['Historical exposed synthetic observations, not a fresh model or independent holdout',
      'Contract-stub callback savings are not measured provider cost or human time savings',
      'Complete per-domain cohorts do not establish full global retrieval-queue completion',
      'Global queue and costs require a separately frozen, budgeted evaluation; prior live campaign stays closed'] };
  await output.writeFile(asciiJSON(result));
  console.log(JSON.stringify({ sourceCommit, reversed: { pairs: result.reversed.pairs, reused: result.reversed.reused,
    unresolved: result.reversed.unresolved, falseMerge: result.reversed.falseMerge, falseDistinct: result.reversed.falseDistinct },
    cohorts: result.cohortSummary, globalQueue: result.globalLexicalQueueInspection, newProviderCalls: 0 }));
} finally { await output.close(); }
