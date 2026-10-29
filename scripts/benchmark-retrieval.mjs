import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import * as similarity from '../src/similarity.mjs';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const output = process.argv[process.argv.indexOf('--output') + 1];
if (!process.argv.includes('--output') || !output) throw new Error('FRESH_OUTPUT_REQUIRED');
const fixtures = await loadFixtures();
const queryIds = ['invoice--cross_language', 'research--low_overlap'];
const queries = queryIds.map(id => fixtures.cases.find(row => row.id === id));
const result = { observedAt: new Date().toISOString(), syntheticOnly: true, fixtureHash, node: process.version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  sourceLFHash: createHash('sha256').update((await readFile('src/similarity.mjs', 'utf8')).replaceAll('\r\n', '\n')).digest('hex'),
  liveProviderCalls: 0, explicitGC: typeof global.gc === 'function', concurrentLoad: 'JobFlow regression may run on the same host; timings are descriptive, not an isolated speed claim.',
  memoryScope: 'Process RSS/heap snapshots, not peak memory or per-query allocations.', measurements: [] };
for (const size of [100, 1000, 10000]) {
  for (const item of queries) {
    const distractor = fixtures.cases.find(row => row.domain === item.domain && row.category === 'nearby_distinct').right;
    const existing = Array.from({ length: size - 1 }, (_, index) => ({ ...distractor, id: `synthetic-${index}`,
      jobToBeDone: `${distractor.jobToBeDone} Reference queue ${index}.` }));
    existing.push({ ...item.right, id: 'expected-target' });
    for (const indexed of [false, ...(similarity.createCandidateIndex ? [true] : [])]) {
      global.gc?.();
      const memoryBefore = process.memoryUsage(), buildStart = performance.now();
      const corpus = indexed ? similarity.createCandidateIndex(existing) : existing;
      const buildMs = performance.now() - buildStart;
      for (let repeat = 0; repeat < 3; repeat++) {
        const started = performance.now();
        const found = similarity.retrieveCandidates(item.left, corpus);
        result.measurements.push({ size, queryId: item.id, indexed, repeat, buildMs: Number(buildMs.toFixed(3)),
          queryMs: Number((performance.now() - started).toFixed(3)), targetRetrieved: found.rows.some(row => row.existing.id === 'expected-target'),
          selected: found.rows.length, complete: found.complete, strategy: found.strategy,
          memoryBefore, memoryAfter: process.memoryUsage() });
      }
    }
    console.log(JSON.stringify({ size, query: item.id, finished: true }));
  }
}
await writeFile(output, asciiJSON(result), { flag: 'wx' });
