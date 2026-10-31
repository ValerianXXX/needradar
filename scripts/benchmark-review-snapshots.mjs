import assert from 'node:assert/strict';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createCandidateIndex } from '../src/similarity.mjs';
import { reviewDuplicates } from '../src/semantic-review.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1]) throw new Error('FRESH_OUTPUT_REQUIRED');
// Reserve the destination before measuring; never overwrite a prior observation.
const file = await open(args[1], 'wx');
const measurements = [];
try {
  const sourceFiles = ['src/input-snapshot.mjs', 'src/semantic-review.mjs', 'src/review-contract.mjs',
    'src/review-journal.mjs', 'src/similarity.mjs', 'scripts/benchmark-review-snapshots.mjs'];
  const sourceLFHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name => [name,
    createHash('sha256').update((await readFile(name, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
  const candidate = { id: 'query', title: 'Invoice review', persona: 'Document operators',
    jobToBeDone: 'Review uncertain invoice fields', desiredOutcome: 'Verified fields', constraints: { processing: 'offline' } };
  for (const size of [100, 1000, 10000]) {
    const source = Array.from({ length: size }, (_, index) => ({ ...candidate, id: `record-${index}`,
      jobToBeDone: `Reconcile remittance queue ${index}` }));
    for (const indexed of [false, true]) {
      global.gc?.();
      const beforeBuild = process.memoryUsage();
      const start = performance.now();
      const existing = indexed ? createCandidateIndex(source) : source;
      const buildMs = performance.now() - start;
      for (let repeat = 0; repeat < 3; repeat++) {
        const beforeReview = process.memoryUsage(), reviewStart = performance.now();
        const result = await reviewDuplicates(candidate, existing, { maxModelCalls: 8,
          reviewer: async request => ({ decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
            leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'CONTRACT_STUB' }) });
        const reviewMs = performance.now() - reviewStart;
        assert.equal(result.modelCalls, 8);
        assert.equal(result.reviews.length, 32);
        assert.equal(result.inputChanged, false);
        assert.equal(result.requiresReview, true);
        assert.equal(result.retrievalComplete, false);
        assert.equal(result.automaticMerge, false);
        measurements.push({ size, indexed, repeat, buildMs, reviewMs, adapterStubs: result.modelCalls,
          beforeBuild, beforeReview, afterReview: process.memoryUsage() });
      }
    }
    console.log(JSON.stringify({ size, completed: true, newProviderCalls: 0 }));
  }
  await file.writeFile(JSON.stringify({ observedAt: new Date().toISOString(), node: process.version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    sourceLFHashes, syntheticOnly: true, liveProviderCalls: 0, explicitGC: typeof global.gc === 'function',
    measurementScope: 'Current snapshot/retrieval/review overhead with uncertain contract stubs; not model accuracy, network latency or human work.',
    memoryScope: 'Process RSS and heap snapshots, not peak memory or per-request allocations.',
    concurrentLoad: 'JobFlow full regression shares this host; descriptive observations, not isolated performance guarantees.',
    measurements }, null, 2) + '\n');
} catch (error) {
  await file.writeFile(JSON.stringify({ status: 'FAILED', error: error.message, measurements }, null, 2) + '\n');
  throw error;
} finally { await file.close(); }
