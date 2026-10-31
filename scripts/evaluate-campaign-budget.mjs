// Global synthetic queue only. No provider, encoder or command adapter imports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, open, mkdtemp, realpath, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadFixtures, fixtureHash } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const args = process.argv.slice(2), options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--source-root', '--output', '--freeze-plan'].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error('INVALID_EVALUATION_ARGUMENTS');
  options.set(args[i], args[i + 1]);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = resolve(options.get('--source-root') ?? root);
const moduleAt = name => import(pathToFileURL(resolve(sourceRoot, name)).href);
const { retrieveCandidates } = await moduleAt('src/similarity.mjs');
const { pairDigest } = await moduleAt('src/review-contract.mjs');
const { reviewDuplicatesWithJournalFile } = await moduleAt('src/review-journal-file.mjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const fixtures = await loadFixtures(), corpus = fixtures.cases.map(item => item.right);
const queue = fixtures.cases.map(item => {
  const retrieval = retrieveCandidates(item.left, corpus);
  return { queryId: item.id, retrievalComplete: retrieval.complete, total: retrieval.total,
    rows: retrieval.rows.map(row => ({ index: row.index, forward: pairDigest(item.left, row.existing),
      reverse: pairDigest(row.existing, item.left) })) };
});
const planPath = join(root, 'eval/boundaries-v2/campaign-budget-plan.json');
if (options.has('--freeze-plan')) {
  assert.equal(options.get('--freeze-plan'), 'synthetic-only');
  assert.equal(options.has('--output'), false);
  const output = await open(planPath, 'wx');
  try { await output.writeFile(asciiJSON({ protocol: 'GLOBAL_REVIEW_BUDGET_STUB_V1', syntheticOnly: true,
    liveProviderCallsAuthorized: 0, fixtureHash, maxStubCallbacks: 300,
    selection: 'Existing default lexical shortlist; not exhaustive global coverage or a hybrid encoder run', queue })); }
  finally { await output.close(); }
  console.log(JSON.stringify({ frozen: 140, selected: queue.reduce((n, row) => n + row.rows.length, 0), liveProviderCallsAuthorized: 0 }));
} else {
  if (!options.has('--output')) throw new Error('NEW_OUTPUT_REQUIRED');
  const planText = (await readFile(planPath, 'utf8')).replaceAll('\r\n', '\n'), plan = JSON.parse(planText), scopeDigest = hash(planText);
  assert.equal(plan.protocol, 'GLOBAL_REVIEW_BUDGET_STUB_V1'); assert.equal(plan.syntheticOnly, true);
  assert.equal(plan.liveProviderCallsAuthorized, 0); assert.equal(plan.fixtureHash, fixtureHash);
  assert.equal(plan.maxStubCallbacks, 300); assert.deepEqual(queue, plan.queue);
  const output = await open(resolve(options.get('--output')), 'wx');
  const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, 'needradar-global-budget-'));
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
  const files = ['src/review-journal-file.mjs', 'src/review-budget.mjs', 'src/review-state-file.mjs',
    'src/semantic-review.mjs', 'src/review-journal.mjs', 'src/review-contract.mjs', 'src/similarity.mjs'];
  const sourceLFHashes = {};
  for (const path of files) {
    try { sourceLFHashes[path] = hash((await readFile(resolve(sourceRoot, path), 'utf8')).replaceAll('\r\n', '\n')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; sourceLFHashes[path] = null; }
  }
  const results = [], counters = { selected: 0, uncertain: 0, cached: 0, pending: 0, stubCallbacks: 0 }, seen = new Set();
  let progress = null; const started = performance.now();
  try {
    for (const [queryIndex, row] of queue.entries()) {
      const input = fixtures.cases[queryIndex];
      const counts = { queryId: row.queryId, selected: row.rows.length, retrievalComplete: row.retrievalComplete,
        stubCallbacks: 0, uncertain: 0, pending: 0, cached: 0 };
      for (const selected of row.rows) {
        const canonical = [selected.forward, selected.reverse].sort()[0];
        const result = await reviewDuplicatesWithJournalFile(input.left, [corpus[selected.index]], {
          reviewerRevision: 'GLOBAL_UNCERTAIN_STUB_V1:' + sourceCommit,
          journalPath: join(directory, canonical + '.json'), maxModelCalls: 1,
          campaignBudget: { path: join(directory, 'budget.json'), scopeDigest, maxModelCalls: plan.maxStubCallbacks },
          reviewer: async request => {
            assert.equal(pairDigest(request.left, request.right), selected.forward);
            counters.stubCallbacks++; counts.stubCallbacks++; seen.add(canonical);
            return { decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
              leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'EXPLICIT_UNCERTAIN_STUB', costUsd: null };
          },
        });
        assert.equal(result.automaticMerge, false);
        assert.equal(result.inputChanged, false);
        progress = result.campaignProgress ?? null;
        const review = result.reviews[0];
        counters.selected++;
        if (review.verdict === 'uncertain') { counters.uncertain++; counts.uncertain++; }
        if (review.method === 'MODEL_PROPOSAL_REUSED') { counters.cached++; counts.cached++; }
        if (review.method === 'HUMAN_REVIEW_REQUIRED') { counters.pending++; counts.pending++; }
      }
      results.push(counts);
    }
    const journals = await readdir(directory);
    const observation = { observedAt: new Date().toISOString(), mode: 'GLOBAL_QUEUE_WITH_EXPLICIT_UNCERTAIN_STUB',
      sourceCommit, sourceLFHashes, node: process.version, fixtureHash, scopeDigest,
      evaluatorLFHash: hash((await readFile(fileURLToPath(import.meta.url), 'utf8')).replaceAll('\r\n', '\n')),
      syntheticOnly: true, newProviderCalls: 0, providerCostUsd: null, independentHumanReview: false,
      queries: queue.length, incompleteRetrievalQueries: queue.filter(row => !row.retrievalComplete).length,
      maxStubCallbacks: plan.maxStubCallbacks, ...counters, distinctStubRelationships: seen.size,
      callbacksAboveCeiling: Math.max(0, counters.stubCallbacks - plan.maxStubCallbacks), campaignProgress: progress,
      pairJournalFiles: journals.filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).length,
      remainingOwnedLocks: journals.filter(name => name.endsWith('.lock')).length,
      elapsedMs: performance.now() - started, results,
      limitations: ['All model answers are explicit uncertain stubs; no new semantic accuracy measurement',
        'All selected global rows were processed, but the existing top-32 retrieval remains incomplete',
        'Unknown provider costs and human effort stay unknown; no deployment or publication',
        'A separate authorized frozen protocol is required for real calls; old campaign remains closed'] };
    await output.writeFile(asciiJSON(observation));
    console.log(JSON.stringify({ sourceCommit, queries: observation.queries, ...counters,
      callbacksAboveCeiling: observation.callbacksAboveCeiling, progress, elapsedMs: observation.elapsedMs, newProviderCalls: 0 }));
  } catch (error) {
    await output.writeFile(asciiJSON({ status: 'FAILED', sourceCommit, scopeDigest, counters, error: String(error), newProviderCalls: 0 }));
    throw error;
  } finally {
    await output.close();
    const owned = await realpath(directory);
    assert.ok(owned.startsWith(parent + sep) && owned !== parent);
    await rm(owned, { recursive: true, force: true });
  }
}
