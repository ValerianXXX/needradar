import { performance } from 'node:perf_hooks';
import { cases } from '../eval/dedup-cases.mjs';
import { findLikelyDuplicate } from '../src/similarity.mjs';
import { reviewDuplicates } from '../src/semantic-review.mjs';
import { createResponsesReviewer } from '../src/responses-reviewer.mjs';
import { createCommandReviewer } from '../src/command-reviewer.mjs';

// Frozen 2026-08-27 baseline, including its ASCII-only tokenization and weights.
const stops = new Set('a an and are as at be by for from in into is it of on or that the their this to with'.split(' '));
const legacyTokens = (text = '') => new Set(String(text).normalize('NFKD').toLowerCase().replace(/[^a-z0-9\s-]/gu, ' ')
  .split(/[\s-]+/u).filter((part) => part.length > 1 && !stops.has(part)));
const overlap = (a, b) => a.size && b.size ? [...a].filter((item) => b.has(item)).length / new Set([...a, ...b]).size : 0;
export function legacyDuplicate(left, right) {
  const score = ['title', 'jobToBeDone', 'persona'].reduce((sum, field, index) =>
    sum + overlap(legacyTokens(left[field]), legacyTokens(right[field])) * [0.2, 0.45, 0.1][index], 0)
    + overlap(new Set(left.evidenceKeys ?? []), new Set(right.evidenceKeys ?? [])) * 0.25;
  return score >= 0.78;
}

export function metrics(rows) {
  return {
    cases: rows.length,
    false_merges: rows.filter((row) => row.predicted === 'same' && row.expected === 'different').length,
    missed_merges: rows.filter((row) => row.predicted === 'different' && row.expected === 'same').length,
    unresolved_duplicates: rows.filter((row) => row.predicted === 'uncertain' && row.expected === 'same').length,
    human_review_pairs: rows.filter((row) => row.predicted === 'uncertain').length,
    decided_pairs: rows.filter((row) => row.predicted !== 'uncertain').length,
    correct_duplicate_proposals: rows.filter((row) => row.predicted === 'same' && row.expected === 'same').length,
  };
}

const live = process.argv.includes('--live');
const command = process.argv.includes('--command');
if (live && command) throw new Error('SELECT_ONE_PROVIDER');
if (live && process.env.NEEDRADAR_ALLOW_CLOUD !== 'true') throw new Error('EXPLICIT_CLOUD_OPT_IN_REQUIRED');
const reviewer = command ? createCommandReviewer({ executable: process.env.NEEDRADAR_REVIEW_EXECUTABLE,
  args: JSON.parse(process.env.NEEDRADAR_REVIEW_ARGS ?? '[]'), allowExecution: process.env.NEEDRADAR_ALLOW_COMMAND === 'true' })
  : live ? createResponsesReviewer({ apiKey: process.env.OPENAI_API_KEY, model: process.env.NEEDRADAR_MODEL, allowCloud: true }) : null;
const started = performance.now(), legacy = [], current = [];
for (const item of cases) {
  const base = { id: item.id, category: item.category, expected: item.expected };
  legacy.push({ ...base, predicted: legacyDuplicate(item.left, item.right) ? 'same' : 'different' });
  const result = await reviewDuplicates(item.left, [item.right], { reviewer, maxModelCalls: 1 });
  current.push({ ...base, predicted: result.reviews[0].verdict, method: result.reviews[0].method,
    model: result.reviews[0].model ?? null, elapsedMs: result.reviews[0].elapsedMs ?? null,
    usage: result.reviews[0].usage ?? null, costUsd: result.reviews[0].costUsd ?? null,
    lexicalScore: findLikelyDuplicate(item.left, [item.right]).best.score });
}
console.log(JSON.stringify({ evaluatedOn: new Date().toISOString(), node: process.version, fixture: 'SYNTHETIC_V1',
  integration: command ? 'LIVE_COMMAND_ATTEMPT' : live ? 'LIVE_API_ATTEMPT' : 'OFFLINE_DETERMINISTIC', elapsedMs: Math.round(performance.now() - started),
  paidCallsRequested: reviewer ? current.filter((row) => ['MODEL_PROPOSAL', 'REVIEW_FAILED'].includes(row.method)).length : 0,
  legacy: { metrics: metrics(legacy), rows: legacy }, current: { metrics: metrics(current), rows: current },
  claims: 'Synthetic engineering evidence only. Uncertain pairs require human review. Null cost means unmeasured, not free.' }, null, 2));
