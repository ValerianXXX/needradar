import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';
import { findLikelyDuplicate } from '../src/similarity.mjs';
import { reviewDuplicates } from '../src/semantic-review.mjs';
import { evidenceSummary } from '../src/provenance.mjs';

export function metrics(rows) {
  return { pairs: rows.length,
    false_merges: rows.filter(row => row.predicted === 'same' && row.expected === 'different').length,
    missed_merges: rows.filter(row => row.predicted === 'different' && row.expected === 'same').length,
    unresolved_duplicates: rows.filter(row => row.predicted === 'uncertain' && row.expected === 'same').length,
    human_review_pairs: rows.filter(row => row.predicted === 'uncertain').length,
    correct_duplicate_proposals: rows.filter(row => row.predicted === 'same' && row.expected === 'same').length,
    decided_distinct: rows.filter(row => row.predicted === 'different').length,
    synchronous_exact_identity_misses: rows.filter(row => row.exactIdentity && !row.synchronousDuplicate).length,
    reverse_disagreements: rows.every(row => row.reverseComparable !== false)
      ? rows.filter(row => row.reverseVerdict !== row.predicted).length : null,
    evidence_count_mismatches: rows.filter(row => row.independenceMatches === false).length };
}

export async function evaluate({ reviewer, maxModelCalls = 0, selectedIds } = {}) {
  const fixtures = await loadFixtures();
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > 20) throw new Error('INVALID_PILOT_BUDGET');
  if (reviewer && (!selectedIds || selectedIds.length > 20)) throw new Error('FIXED_LIVE_PILOT_REQUIRED');
  const selected = selectedIds ? fixtures.cases.filter(row => selectedIds.includes(row.id)) : fixtures.cases;
  if (selectedIds && selected.length !== selectedIds.length) throw new Error('INVALID_PILOT_SELECTION');
  let calls = 0;
  const rows = [];
  for (const item of selected) {
    const pairStart = performance.now();
    const direct = findLikelyDuplicate(item.left, [item.right]);
    const remaining = maxModelCalls - calls;
    const outcome = await reviewDuplicates(item.left, [item.right], { reviewer, maxModelCalls: remaining });
    calls += outcome.modelCalls;
    // Reverse is deliberately offline: never double a paid run implicitly.
    const reverse = await reviewDuplicates(item.right, [item.left], { maxModelCalls: 0 });
    const decision = outcome.reviews[0];
    const independence = item.observations ? evidenceSummary(item.observations).independentEvidenceCount : null;
    rows.push({ id: item.id, domain: item.domain, split: item.split, category: item.category, expected: item.expected,
      predicted: decision.verdict, method: decision.method, reason: decision.reason,
      synchronousDuplicate: direct.duplicate, exactIdentity: direct.best.autoDuplicate,
      reverseVerdict: reverse.reviews[0].verdict, reverseMode: 'OFFLINE_ONLY', reverseComparable: !reviewer,
      independentEvidence: independence, independenceMatches: independence === null ? null : independence === item.expectedIndependentEvidence,
      leftQuote: decision.leftQuote ?? null, rightQuote: decision.rightQuote ?? null, model: decision.model ?? null,
      modelElapsedMs: decision.elapsedMs ?? null, costUsd: decision.costUsd ?? null, usage: decision.usage ?? null,
      elapsedMs: Number((performance.now() - pairStart).toFixed(3)), automaticMerge: outcome.automaticMerge });
  }
  return { fixtures: fixtureHash, mode: reviewer ? 'REAL_REVIEWER_ATTEMPT' : 'OFFLINE_DETERMINISTIC',
    adapterRequests: calls, maxModelCalls, costUsd: reviewer ? null : 0,
    semantic_quality_note: 'Uncertain is neither correct nor a decided miss. Offline reverse comparisons are not paid-model agreement.',
    overall: metrics(rows), byCategory: Object.fromEntries(fixtures.categories.map(category => [category, metrics(rows.filter(row => row.category === category))])),
    bySplit: Object.fromEntries(['development', 'held_out'].map(split => [split, metrics(rows.filter(row => row.split === split))])), rows };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const output = process.argv[process.argv.indexOf('--output') + 1];
  if (!process.argv.includes('--output') || !output) throw new Error('FRESH_OUTPUT_REQUIRED');
  const files = ['src/similarity.mjs', 'src/semantic-review.mjs', 'src/provenance.mjs', 'scripts/evaluate-boundaries.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
  const result = { observedAt: new Date().toISOString(), syntheticOnly: true, node: process.version,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    workingTreeObservation: true, sourceLFHashes: hashes, ...await evaluate() };
  await writeFile(output, asciiJSON(result), { flag: 'wx' });
  console.log(JSON.stringify(result.overall));
}
