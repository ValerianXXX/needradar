import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewDuplicatesWithJournalFile } from '../src/review-journal-file.mjs';

const candidate = { title: 'Invoice review', persona: 'Review operators', jobToBeDone: 'Review uncertain invoice fields',
  desiredOutcome: 'Verified fields', constraints: { processing: 'offline' } };
const corpus = Array.from({ length: 5 }, (_, i) => ({ ...candidate, id: `record-${i}`, jobToBeDone: `Reconcile invoice queue ${i} before publication` }));
const revision = 'EXPLICIT_CAMPAIGN_CONTRACT_STUB_V1';
const response = request => ({ decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
  leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'CONTRACT_STUB', costUsd: null });
async function setup(t, limit = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'needradar-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, journalPath: join(directory, 'review.json'), reviewerRevision: revision,
    campaignBudget: { path: join(directory, 'budget.json'), scopeDigest: 'a'.repeat(64), maxModelCalls: limit } };
}
const run = (options, extra = {}, records = corpus) => reviewDuplicatesWithJournalFile(candidate, records, {
  ...options, reviewer: async request => response(request), ...extra,
});

test('one durable budget spans separate pair journals', async t => {
  const options = await setup(t, 1); let calls = 0;
  const reviewer = async request => { calls++; return response(request); };
  const first = await run(options, { reviewer }, [corpus[0]]);
  const second = await run(options, { reviewer, journalPath: join(options.directory, 'second.json') }, [corpus[1]]);
  assert.equal(first.modelCalls, 1);
  assert.equal(second.modelCalls, 0);
  assert.equal(second.reviews[0].method, 'HUMAN_REVIEW_REQUIRED');
  assert.equal(calls, 1);
  assert.equal(second.campaignProgress.remainingCalls, 0);
  assert.equal(second.automaticMerge, false);
});

test('reopening the same journal cannot reset the total call ceiling', async t => {
  const options = await setup(t, 2);
  const first = await run(options), second = await run(options);
  assert.deepEqual([first.modelCalls, second.modelCalls], [2, 0]);
  assert.equal(second.reviewProgress.cachedProposals, 2);
  assert.equal(second.reviewProgress.pendingPairs, 3);
  assert.equal(second.campaignProgress.reservedCalls, 2);
});

test('per-invocation pacing remains separate from the durable ceiling', async t => {
  const options = await setup(t, 3), counts = [];
  for (let i = 0; i < 4; i++) counts.push((await run(options, { maxModelCalls: 1 })).modelCalls);
  assert.deepEqual(counts, [1, 1, 1, 0]);
});

test('zero total budget persists without creating pair attempts', async t => {
  const options = await setup(t, 0); let calls = 0;
  const result = await run(options, { reviewer: async request => { calls++; return response(request); } });
  assert.equal(calls, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.reviewJournal.events.length, 0);
  assert.equal(JSON.parse(await readFile(options.campaignBudget.path, 'utf8')).maxModelCalls, 0);
});

test('cached proposals consume no new budget and retain original cost', async t => {
  const options = await setup(t, 1);
  await run(options, { reviewer: async request => ({ ...response(request), costUsd: 0.25 }) }, [corpus[0]]);
  const before = await readFile(options.campaignBudget.path, 'utf8');
  const again = await run(options, { maxModelCalls: 0 }, [corpus[0]]);
  assert.equal(again.modelCalls, 0);
  assert.equal(again.reviews[0].costUsd, 0.25);
  assert.equal(again.campaignProgress.knownCostUsd, 0.25);
  assert.equal(await readFile(options.campaignBudget.path, 'utf8'), before);
});

test('unknown cost is not a zero-price completed campaign', async t => {
  const options = await setup(t, 2); let count = 0;
  const result = await run(options, { reviewer: async request => ({ ...response(request), costUsd: count++ === 0 ? 0.25 : null }) });
  assert.equal(result.campaignProgress.reservedCalls, 2);
  assert.equal(result.campaignProgress.knownCostUsd, 0.25);
  assert.equal(result.campaignProgress.unknownCostCalls, 1);
  assert.equal(result.campaignProgress.totalCostUsd, null);
});

test('a failed reviewer still consumes a reserved call', async t => {
  const options = await setup(t, 1); let calls = 0;
  const first = await run(options, { reviewer: async () => { calls++; throw new Error('SYNTHETIC_PROVIDER_FAILURE'); } }, [corpus[0]]);
  const second = await run(options, { reviewer: async request => { calls++; return response(request); },
    journalPath: join(options.directory, 'second.json') }, [corpus[1]]);
  assert.equal(first.reviews[0].method, 'REVIEW_FAILED');
  assert.equal(calls, 1);
  assert.equal(second.campaignProgress.failedCalls, 1);
  assert.equal(second.campaignProgress.unknownCostCalls, 1);
});

test('provider-returned but invalid decisions do not become successful reviews', async t => {
  const options = await setup(t, 1);
  const result = await run(options, { reviewer: async () => ({ decision: {}, costUsd: 0.25 }) }, [corpus[0]]);
  assert.equal(result.reviews[0].method, 'REVIEW_FAILED');
  assert.equal(result.campaignProgress.returnedCalls, 1);
  assert.equal(result.campaignProgress.remainingCalls, 0);
  assert.equal(result.campaignProgress.knownCostUsd, 0.25);
});

for (const [label, change] of [['ceiling', { maxModelCalls: 3 }], ['scope', { scopeDigest: 'b'.repeat(64) }]]) {
  test(`stored ${label} cannot change on resume`, async t => {
    const options = await setup(t, 1); await run(options, {}, [corpus[0]]);
    let calls = 0;
    await assert.rejects(run(options, { campaignBudget: { ...options.campaignBudget, ...change },
      reviewer: async request => { calls++; return response(request); } }), /REVIEW_BUDGET_POLICY_MISMATCH/u);
    assert.equal(calls, 0);
  });
}

test('reviewer revision is bound across different pair journals', async t => {
  const options = await setup(t, 1); await run(options, {}, [corpus[0]]);
  await assert.rejects(run(options, { reviewerRevision: revision + '-changed', journalPath: join(options.directory, 'second.json') }), /REVIEW_BUDGET_POLICY_MISMATCH/u);
});

test('malformed durable budget blocks before any reviewer call', async t => {
  const options = await setup(t); await writeFile(options.campaignBudget.path, '{'); let calls = 0;
  await assert.rejects(run(options, { reviewer: async request => { calls++; return response(request); } }), /REVIEW_BUDGET_JSON_INVALID/u);
  assert.equal(calls, 0);
});

test('existing campaign lock blocks every pair journal', async t => {
  const options = await setup(t); await writeFile(options.campaignBudget.path + '.lock', 'existing-owner'); let calls = 0;
  await assert.rejects(run(options, { reviewer: async request => { calls++; return response(request); } }), /REVIEW_BUDGET_LOCKED/u);
  assert.equal(calls, 0);
  assert.equal(await readFile(options.campaignBudget.path + '.lock', 'utf8'), 'existing-owner');
});

test('concurrent distinct pair files cannot share one reservation', async t => {
  const options = await setup(t, 1); let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const first = run(options, { reviewer: async request => { entered(); await barrier; return response(request); } }, [corpus[0]]);
  await ready;
  try {
    await assert.rejects(run(options, { journalPath: join(options.directory, 'second.json') }, [corpus[1]]), /REVIEW_BUDGET_LOCKED/u);
  } finally { release(); await first; }
});

test('a reservation is on disk before the potentially billable callback', async t => {
  const options = await setup(t, 1); let reserved = false;
  const result = await run(options, { reviewer: async request => {
    const saved = JSON.parse(await readFile(options.campaignBudget.path, 'utf8'));
    reserved = saved.events.length === 1 && saved.events[0].type === 'STARTED';
    return response(request);
  } }, [corpus[0]]);
  assert.equal(reserved, true);
  assert.equal(result.modelCalls, 1);
});

test('a lost budget completion checkpoint propagates instead of looking completed', async t => {
  const options = await setup(t, 1);
  await assert.rejects(run(options, { reviewer: async request => {
    await writeFile(options.campaignBudget.path, '{"external_change":true}'); return response(request);
  } }, [corpus[0]]), /REVIEW_BUDGET_FILE_CHANGED/u);
});

test('already aborted work neither calls the reviewer nor reserves budget', async t => {
  const options = await setup(t, 2), controller = new AbortController(); controller.abort();
  const result = await run(options, { signal: controller.signal });
  assert.equal(result.modelCalls, 0);
  assert.equal(result.campaignProgress.reservedCalls, 0);
  assert.ok(result.reviews.every(row => row.method === 'REVIEW_CANCELLED'));
});

test('separate Node processes obey the same durable ceiling', async t => {
  const options = await setup(t, 1);
  const moduleUrl = new URL('../src/review-journal-file.mjs', import.meta.url).href;
  const code = `import { reviewDuplicatesWithJournalFile as run } from ${JSON.stringify(moduleUrl)};
    const options=JSON.parse(process.argv[1]);
    const result=await run(${JSON.stringify(candidate)},${JSON.stringify(corpus)},
      {...options,reviewer:async request=>(${response.toString()})(request)});
    console.log(JSON.stringify({calls:result.modelCalls,remaining:result.campaignProgress?.remainingCalls}));`;
  const counts = [];
  for (let i = 0; i < 2; i++) counts.push(JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', code, JSON.stringify(options)], { encoding: 'utf8', windowsHide: true })).calls);
  assert.deepEqual(counts, [1, 0]);
});
