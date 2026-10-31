import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
if (!args.includes('--output') || !args.includes('--baseline-root') || args.length !== 4) {
  throw new Error('Use --baseline-root <public baseline checkout> --output <new JSON path>');
}
const baselineRoot = resolve(option('--baseline-root')), output = resolve(option('--output'));
const revision = root => execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim();
const modules = [];
for (const [label, root] of [['before', baselineRoot], ['after', project]]) {
  modules.push({ label, root, revision: revision(root),
    provenance: await import(pathToFileURL(resolve(root, 'src/provenance.mjs'))),
    change: await import(pathToFileURL(resolve(root, 'src/evidence-independence.mjs'))) });
}
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const rows = [];
for (const count of [100, 1000, 10000]) {
  for (const mode of ['unchanged', 'relabel_each_author', 'overlapping_correction_chain']) {
    const before = [], after = [];
    for (let index = 0; index < count; index++) {
      const pair = Math.floor(index / 2), previous = mode === 'overlapping_correction_chain' ? pair : index;
      const current = mode === 'overlapping_correction_chain' ? (pair + index % 2) % (count / 2) : index;
      before.push({evidenceKey: `synthetic-${index}`, authorGroup: `before-${previous}`});
      after.push({evidenceKey: `synthetic-${index}`, authorGroup: `${mode === 'unchanged' ? 'before' : 'after'}-${current}`});
    }
    const inputHash = hash([before, after]), expected = {added: 0,
      resolvedExisting: mode === 'unchanged' ? 0 : mode === 'overlapping_correction_chain' ? count / 2 : count,
      consolidatedOrLost: 0};
    for (const module of modules) {
      const observations = [];
      for (let repetition = 0; repetition < 3; repetition++) {
        global.gc?.();
        const memoryBefore = process.memoryUsage(), start = performance.now();
        const prior = module.provenance.evidenceSummary(before), current = module.provenance.evidenceSummary(after);
        const result = module.change.independentEvidenceChange(prior, current, new Set(before));
        const elapsedMs = performance.now() - start, memoryAfter = process.memoryUsage();
        if (module.label === 'after') assert.deepEqual(result, expected);
        observations.push({repetition: repetition + 1, elapsedMs, result,
          heapBeforeBytes: memoryBefore.heapUsed, heapAfterBytes: memoryAfter.heapUsed,
          rssBeforeBytes: memoryBefore.rss, rssAfterBytes: memoryAfter.rss});
      }
      assert.equal(hash([before, after]), inputHash);
      rows.push({revision: module.revision, implementation: module.label, recordsPerSnapshot: count,
        mode, inputHash, expected, medianMs: observations.map(item => item.elapsedMs).sort((a,b) => a-b)[1], observations});
    }
  }
}
const report = {schemaVersion: 1, observedAt: new Date().toISOString(), node: process.version,
  platform: process.platform, syntheticOnly: true, modelCalls: 0, garbageCollectionRequested: Boolean(global.gc),
  scope: 'Two provenance summaries plus delta matching. Shared host, warm modules, memory snapshots rather than peaks. No speed, semantic quality or user-effort improvement claim.', rows};
await writeFile(output, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
process.stdout.write(JSON.stringify({status: 'RECORDED', scenarios: 9, repetitionsPerRevision: 3,
  afterAssertionsPassed: 27, output, largest: rows.filter(row => row.recordsPerSnapshot === 10000)
    .map(row => ({implementation: row.implementation, mode: row.mode, medianMs: row.medianMs, result: row.observations[0].result}))}) + '\n');
