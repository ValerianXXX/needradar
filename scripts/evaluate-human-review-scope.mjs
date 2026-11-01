import { writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';
import { recordPairDecision } from '../src/opportunity-state.mjs';
import { pairDigest, reviewDuplicates } from '../src/semantic-review.mjs';
import { buildReviewClusters } from '../src/opportunity-clusters.mjs';

const output = process.argv[process.argv.indexOf('--output') + 1];
if (!process.argv.includes('--output') || !output) throw new Error('FRESH_OUTPUT_REQUIRED');
const fixtures = (await loadFixtures()).cases.filter(row => row.category === 'low_overlap');
if (fixtures.length !== 20) throw new Error('FIXED_TWENTY_DOMAINS_REQUIRED');
const rows = [], started = performance.now();
for (const item of fixtures) {
  const [a, b] = [{ ...item.left, id: `${item.domain}-reviewed-a` }, { ...item.right, id: `${item.domain}-reviewed-b` }];
  const [c, d] = [{ ...a, id: `${item.domain}-unreviewed-c` }, { ...b, id: `${item.domain}-unreviewed-d` }];
  for (const decision of ['same', 'different', 'uncertain']) {
    const options = { digest: pairDigest(a, b), decision, actor: 'SYNTHETIC_CONTRACT_REVIEWER',
      reason: 'Scope contract only; no actual human approval', recordedAt: '2026-11-01T00:00:00Z' };
    const event = recordPairDecision(a, b, options), other = recordPairDecision(c, d, options);
    const history = JSON.parse(JSON.stringify([event]));
    const own = await reviewDuplicates(a, [b], { humanDecisions: history, maxModelCalls: 0 });
    const forward = await reviewDuplicates(c, [d], { humanDecisions: history, maxModelCalls: 0 });
    const reverse = await reviewDuplicates(d, [c], { humanDecisions: history, maxModelCalls: 0 });
    const clusters = buildReviewClusters([a, b, c, d], { humanDecisions: history });
    rows.push({ domain: item.domain, syntheticDecision: decision, ownDecision: own.reviews[0].verdict,
      foreignMethod: forward.reviews[0].method, foreignVerdict: forward.reviews[0].verdict,
      foreignRequiresReview: forward.requiresReview, foreignDuplicate: forward.duplicate,
      reverseMethod: reverse.reviews[0].method, eventIdCollision: event.id === other.id,
      foreignClusterSeparated: clusters.groups.some(group => group.memberIds.length === 1 && group.memberIds[0] === c.id),
      providerCalls: own.modelCalls + forward.modelCalls + reverse.modelCalls });
  }
}
const files = ['src/semantic-review.mjs', 'src/opportunity-state.mjs', 'src/opportunity-clusters.mjs',
  'src/review-contract.mjs', 'scripts/evaluate-human-review-scope.mjs', 'tests/human-review-scope.test.mjs'];
try { await readFile('src/human-review.mjs'); files.push('src/human-review.mjs'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
  createHash('sha256').update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
const summary = { cases: rows.length, ownDecisionsPreserved: rows.filter(row => row.ownDecision === row.syntheticDecision).length,
  foreignHumanDecisionsApplied: rows.filter(row => row.foreignMethod === 'HUMAN_DECISION').length,
  foreignDefiniteDecisions: rows.filter(row => row.foreignVerdict !== 'uncertain').length,
  foreignPairsRequiringReview: rows.filter(row => row.foreignRequiresReview).length,
  foreignClusterSingletons: rows.filter(row => row.foreignClusterSeparated).length,
  eventIdCollisions: rows.filter(row => row.eventIdCollision).length,
  reverseHumanDecisionsApplied: rows.filter(row => row.reverseMethod === 'HUMAN_DECISION').length,
  providerCalls: rows.reduce((count, row) => count + row.providerCalls, 0) };
await writeFile(output, asciiJSON({ observedAt: new Date().toISOString(), protocol: 'HUMAN_RECORD_SCOPE_OBSERVATION_V1',
  syntheticOnly: true, independentHumanReview: false, fixtureHash, sourceLFHashes: hashes,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  node: process.version, elapsedMs: performance.now() - started, summary, rows,
  limits: 'Twenty exposed synthetic domains, three simulated decisions each. Scope consistency only, not semantic accuracy or reviewer effort.' }), { flag: 'wx' });
console.log(JSON.stringify(summary));
