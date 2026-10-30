// Validate published synthetic observations without any provider, command or file writes.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadProtocol, summarize } from './evaluate-targeted-followup.mjs';
import { reviewDuplicates } from '../src/semantic-review.mjs';
import { validateReviewJournal } from '../src/review-journal.mjs';

const read = async name => JSON.parse(await readFile(new URL('../eval/results/' + name, import.meta.url), 'utf8'));
const { plan, cases, protocolHash, runnerHash } = await loadProtocol();
const prefix = '2026-10-30-targeted-followup-';
const first = await read(prefix + 'first.json'), second = await read(prefix + 'second.json');
const recorded = await read(prefix + 'replay.json'), journal = await read(prefix + 'proposals.json');
const receipt = await read(prefix + 'verification.json');
for (const [name, expected] of Object.entries(receipt.publishedLFHashes)) {
  const bytes = (await readFile(new URL('../eval/results/' + name, import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
}
const revision = createHash('sha256').update(JSON.stringify([plan.runtime, plan.productLFHashes, protocolHash])).digest('hex');
validateReviewJournal(journal, revision);
assert.deepEqual([first.adapterAttemptsThisInvocation, second.adapterAttemptsThisInvocation, recorded.adapterAttemptsThisInvocation], [7, 7, 0]);
assert.equal(recorded.protocolHash, protocolHash);
assert.equal(recorded.runnerHash, runnerHash);
const rows = [];
for (const item of cases) {
  const result = await reviewDuplicates(item.left, [item.right], {
    reviewJournal: journal, reviewerRevision: revision, maxModelCalls: 0,
    reviewer: () => { throw new Error('REPLAY_MUST_NOT_CALL_PROVIDER'); },
  });
  assert.equal(result.modelCalls, 0);
  assert.equal(result.automaticMerge, false);
  const after = result.reviews[0], original = recorded.rows.find(row => row.id === item.id);
  assert.equal(after.pairDigest, original.after.pairDigest);
  assert.equal(after.verdict, original.after.verdict);
  assert.equal(after.leftQuote, original.after.leftQuote);
  assert.equal(after.rightQuote, original.after.rightQuote);
  rows.push({ id: item.id, expected: item.expected, after });
}
assert.deepEqual(summarize(rows, 'after'), recorded.after);
assert.equal(rows.filter(r => r.after.method === 'MODEL_PROPOSAL_REUSED').length, 14);
console.log(JSON.stringify({ status: 'PASS', mode: 'OFFLINE_SAVED_PROPOSAL_REPLAY', cases: rows.length,
  actualNewModelCalls: 0, originalModelCostUsd: null, automaticMerge: false, result: recorded.after }));
