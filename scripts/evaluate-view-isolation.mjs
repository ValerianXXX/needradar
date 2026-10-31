import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const { values } = parseArgs({ options: { 'module-root': { type: 'string', default: '.' }, output: { type: 'string' } } });
if (!values.output) throw new Error('FRESH_OUTPUT_PATH_REQUIRED');
if (!globalThis.gc) throw new Error('RUN_NODE_WITH_EXPOSE_GC');
const output = await open(resolve(values.output), 'wx');
const root = resolve(values['module-root']);
const load = name => import(pathToFileURL(resolve(root, 'src', `${name}.mjs`)).href);
const { buildReviewClusters, recordClusterSplit } = await load('opportunity-clusters');
const { recordValidation, recordPairDecision } = await load('opportunity-state');
const { pairDigest } = await load('semantic-review');
const { decidePublication } = await load('pipeline');
const hash = value => createHash('sha256').update(value).digest('hex');
const drafts = count => Array.from({ length: count }, (_, index) => ({
  id: `synthetic-${String(index).padStart(5, '0')}`, title: 'Synthetic source review', persona: 'Synthetic reviewers',
  jobToBeDone: 'Check supplied source records.', currentWorkflow: 'Manual source checks',
  desiredOutcome: 'A traceable decision', aiPath: 'Prepare candidates', humanGates: ['Check source rights'],
  counterEvidence: ['No customer observation'], unknowns: ['Demand is unverified'], constraints: { processing: 'offline' },
  observations: [{ evidenceKey: `source-${index}`, authorGroup: `author-${index}`, sourcePolicy: 'synthetic-policy',
    rightsApproved: index !== 2, sourceAccessible: true, containsPersonalData: false, quote: `Synthetic statement ${index}` }],
}));
const review = (left, right, recordedAt = '2026-10-31T12:00:00Z') => recordPairDecision(left, right, {
  digest: pairDigest(left, right), decision: 'same', actor: 'synthetic-reviewer',
  reason: 'Same synthetic task and constraints', recordedAt,
});
const trio = items => [review(items[0], items[1]), review(items[0], items[2]), review(items[1], items[2])];

try {
  const items = drafts(3), history = trio(items), sourceCluster = { draft: items[0], observations: items.flatMap(item => item.observations) };
  const before = decidePublication(sourceCluster, []);
  const view = buildReviewClusters(items, { humanDecisions: history });
  const savedView = structuredClone(view);
  view.groups[0].evidence.groups.flatMap(group => group.observations).find(item => item.evidenceKey === 'source-2').rightsApproved = true;
  const after = decidePublication(sourceCluster, []);
  const sourceRightsPreserved = items[2].observations[0].rightsApproved === false;
  const laterSource = drafts(3), oldView = buildReviewClusters(laterSource, { humanDecisions: trio(laterSource) });
  laterSource[0].observations[0].quote = 'A later source edit';
  const viewPreserved = oldView.groups[0].evidence.groups[0].original.quote === 'Synthetic statement 0';
  const prior = recordValidation(drafts(1)[0], { status: 'INTERVIEWED', evidenceKeys: ['source-0'],
    actor: 'synthetic-reviewer', recordedAt: '2026-10-31T12:00:00Z' });
  const next = recordValidation(prior, { status: 'INVALIDATED', evidenceKeys: ['source-0'],
    actor: 'synthetic-reviewer', recordedAt: '2026-10-31T13:00:00Z' });
  next.validation.events[0].status = 'OUTCOME_OBSERVED';
  const priorHistoryPreserved = prior.validation.events[0].status === 'INTERVIEWED';

  const clean = drafts(3), original = structuredClone(clean), journal = trio(clean), originalJournal = structuredClone(journal);
  const split = recordClusterSplit(clean, { groups: [[clean[0].id], [clean[1].id, clean[2].id]], actor: 'synthetic-reviewer',
    reason: 'Separate required outcomes', recordedAt: '2026-10-31T13:00:00Z' });
  const splitView = buildReviewClusters(clean, { humanDecisions: [...journal, ...split.events] });
  const restored = buildReviewClusters(clean, { humanDecisions: [...journal, ...split.events,
    review(clean[0], clean[1], '2026-10-31T14:00:00Z'), review(clean[0], clean[2], '2026-10-31T14:00:00Z')] });
  assert.equal(splitView.groups.length, 2);
  assert.equal(restored.groups.length, 1);
  assert.deepEqual(clean, original);
  assert.deepEqual(journal, originalJournal);

  const scale = [];
  for (const size of [100, 1000, 10000]) {
    const corpus = drafts(size), events = [];
    for (let index = 0; index + 2 < size; index += 3) events.push(...trio(corpus.slice(index, index + 3)));
    const inputHash = hash(JSON.stringify({ corpus, events })), observations = [];
    let expected = null;
    for (let repeat = 0; repeat < 3; repeat++) {
      globalThis.gc();
      const memoryBefore = process.memoryUsage(), started = performance.now();
      const result = buildReviewClusters(corpus, { humanDecisions: events });
      const elapsedMs = performance.now() - started, memoryAfter = process.memoryUsage();
      const resultHash = hash(JSON.stringify(result));
      expected ??= resultHash;
      assert.equal(resultHash, expected);
      assert.equal(result.groups.length, Math.floor(size / 3) + size % 3);
      observations.push({ elapsedMs, heapBeforeBytes: memoryBefore.heapUsed, heapAfterBytes: memoryAfter.heapUsed,
        rssAfterBytes: memoryAfter.rss, pairChecks: result.pairChecks, groups: result.groups.length, resultHash });
    }
    assert.equal(hash(JSON.stringify({ corpus, events })), inputHash);
    const ordered = observations.map(row => row.elapsedMs).sort((a,b) => a-b);
    scale.push({ size, humanEvents: events.length, inputHash, medianMs: ordered[1], observations });
  }
  const sourceHashes = {};
  for (const name of ['opportunity-clusters', 'opportunity-state']) {
    sourceHashes[`src/${name}.mjs`] = hash((await readFile(resolve(root, 'src', `${name}.mjs`), 'utf8')).replaceAll('\r\n', '\n'));
  }
  const receipt = {
    observedAt: new Date().toISOString(), protocol: 'EVIDENCE_VIEW_ISOLATION_V1', syntheticOnly: true,
    sourceCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceHashes,
    runtime: { node: process.version, platform: process.platform },
    behavior: { publicationBeforePreviewEdit: before, publicationAfterPreviewEdit: after, sourceRightsPreserved,
      returnedViewPreservedAfterSourceEdit: viewPreserved, priorValidationHistoryPreserved: priorHistoryPreserved,
      explicitSplitAndRestorePreserved: true, originalUneditedViewHash: hash(JSON.stringify(savedView)) },
    scale, modelCalls: 0, externalActions: 0, hostedProductChanged: false, independentHumanAcceptance: false,
    limits: ['Public policy library on synthetic in-memory data, not a deployment or authenticated persistence transaction',
      'Three shared-host observations per size; memory snapshots are not peak memory or allocations',
      'Three-member reviewed groups do not measure dense graph worst-case behavior',
      'No semantic-accuracy, model-latency or human-effort benefit measured'],
  };
  await output.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ behavior: receipt.behavior, scale: scale.map(({size,medianMs})=>({size,medianMs})) }));
} finally { await output.close(); }
