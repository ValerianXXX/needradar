import { open, readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { reviewDuplicates } from '../src/semantic-review.mjs';
import { reviewDuplicatesWithJournalFile } from '../src/review-journal-file.mjs';
import { retrieveCandidates } from '../src/similarity.mjs';
import { loadFixtures, fixtureHash } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

// An offline scheduling comparison. No live adapter, credentials or encoder.
const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
if (!output) throw new Error('NEW_OUTPUT_PATH_REQUIRED');
const receipt = await open(output, 'wx');
const directory = await mkdtemp(join(tmpdir(), 'needradar-review-continuation-'));
try {
  const fixtures = await loadFixtures(), pair = fixtures.cases.find(row => row.id === 'invoice--cross_language');
  const journalText = (await readFile(new URL('../eval/results/2026-10-29-boundaries-hermes.requests.jsonl', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const journalLFHash = createHash('sha256').update(journalText).digest('hex');
  assert.equal(journalLFHash, '793cc457fbe3916bf781bd1ee484d1968fe2c5d01f6f6889f060988fa4ded710');
  const entries = journalText.trim().split('\n').map(line => JSON.parse(line)), recorded = new Map();
  for (let index = 0; index < entries.length; index += 2) {
    const request = entries[index], response = entries[index + 1];
    assert.equal(request.type, 'REQUEST_STARTED');
    assert.equal(response.type, 'RESPONSE');
    assert.equal(response.ordinal, request.ordinal);
    recorded.set(JSON.stringify(request.request), response.response);
  }
  const corpus = Array.from({ length: 19 }, (_, index) => ({ ...pair.left, id: `d-${String(index).padStart(2, '0')}`,
    jobToBeDone: `${pair.left.jobToBeDone} Review a separate archive ${index}.` }));
  corpus.push({ ...pair.right, id: 'target' });
  assert.equal(retrieveCandidates(pair.left, corpus).rows.findIndex(row => row.existing.id === 'target') + 1, 20);
  const observe = async durable => {
    const requests = [], invocations = [];
    let recordedResponses = 0, uncertainStubs = 0, last;
    const reviewer = async request => {
      requests.push(JSON.stringify(request));
      if (recorded.has(JSON.stringify(request))) { recordedResponses++; return structuredClone(recorded.get(JSON.stringify(request))); }
      uncertainStubs++;
      return { decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
        leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'EXPLICIT_UNCERTAIN_CONTRACT_STUB' };
    };
    const started = performance.now();
    for (let invocation = 0; invocation < 3; invocation++) {
      last = durable ? await reviewDuplicatesWithJournalFile(pair.left, corpus, { reviewer, maxModelCalls: 8,
        reviewerRevision: 'pinned-hermes-replay-plus-uncertain-stubs-v1', journalPath: join(directory, 'review.json') })
        : await reviewDuplicates(pair.left, corpus, { reviewer, maxModelCalls: 8 });
      invocations.push(last.modelCalls);
    }
    return { invocations, totalReviewerCallbacks: requests.length, distinctRequests: new Set(requests).size,
      duplicateCallbacks: requests.length - new Set(requests).size, unvisitedRetrievedPairs: corpus.length - new Set(requests).size,
      recordedResponses, uncertainStubs, targetProposedSame: last.reviews.find(row => row.index === 19)?.verdict === 'same',
      unresolvedPairs: last.reviews.filter(row => row.verdict === 'uncertain').length, requiresReview: last.requiresReview,
      retrievalComplete: last.retrievalComplete, automaticMerge: last.automaticMerge,
      replayWallMs: Number((performance.now() - started).toFixed(3)) };
  };
  const stateless = await observe(false), continuation = await observe(true);
  assert.deepEqual(stateless.invocations, [8, 8, 8]);
  assert.deepEqual(continuation.invocations, [8, 8, 4]);
  assert.equal(stateless.distinctRequests, 8);
  assert.equal(continuation.distinctRequests, 20);
  assert.equal(continuation.recordedResponses, 1);
  assert.equal(continuation.uncertainStubs, 19);
  assert.equal(continuation.targetProposedSame, true);
  assert.equal(continuation.requiresReview, true);
  assert.equal(continuation.automaticMerge, false);
  const files = ['src/semantic-review.mjs', 'src/review-contract.mjs', 'src/review-journal.mjs', 'src/review-journal-file.mjs', 'scripts/evaluate-review-continuation.mjs'];
  const sourceLFHashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
  await receipt.writeFile(asciiJSON({ observedAt: new Date().toISOString(), status: 'PASS',
    mode: 'OFFLINE_RECORDED_RESPONSE_AND_UNCERTAIN_STUB_COMPARISON', syntheticOnly: true,
    fixtureHash, journalLFHash, sourceLFHashes, targetRank: 20, invocations: 3, maxCallsPerInvocation: 8,
    stateless, continuation, liveModelCalls: 0, originalProviderCostUsd: null, originalProviderTokens: null,
    evidence: 'Actual local file checkpoint/reload; one pinned earlier Hermes response and nineteen explicit uncertain contract stubs.',
    limits: ['No new model quality observation', 'No independent holdout or human acceptance',
      'Replay wall time is not model latency', 'No retrieval rerun or improvement to the historical 140-pair semantic score',
      'No hosted source, database, merge, publication or deployment change'] }));
  console.log(JSON.stringify({ status: 'PASS', stateless, continuation, liveModelCalls: 0 }));
} finally { await receipt.close(); await rm(directory, { recursive: true, force: true }); }
