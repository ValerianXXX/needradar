import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProtocol, runFollowup } from '../scripts/evaluate-targeted-followup.mjs';
import { readFrozenFollowupPlan } from '../scripts/frozen-followup-plan.mjs';

async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), 'needradar-targeted-contract-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { plan } = await readFrozenFollowupPlan();
  return { directory: join(parent, 'run'), runtime: plan.runtime };
}

const requests = async directory => (await readFile(join(directory, 'requests.jsonl'), 'utf8'))
  .trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'REQUEST_STARTED');

test('bounded live-shaped calls resume without repeat and replay consumes zero', async t => {
  const options = await setup(t);
  const first = await runFollowup({ ...options, mode: 'start' });
  assert.equal(first.adapterAttemptsThisInvocation, 7);
  assert.equal(first.totalReservedAttempts, 7);
  const next = await runFollowup({ ...options, mode: 'continue' });
  assert.equal(next.adapterAttemptsThisInvocation, 7);
  assert.equal(next.totalReservedAttempts, 14);
  const replay = await runFollowup({ ...options, mode: 'replay' });
  assert.equal(replay.adapterAttemptsThisInvocation, 0);
  assert.equal(replay.rows.filter(r => r.after.method === 'MODEL_PROPOSAL_REUSED').length, 14);
  assert.equal(replay.after.unresolvedPairs, 14);
  const closed = await runFollowup({ ...options, mode: 'continue' });
  assert.equal(closed.adapterAttemptsThisInvocation, 0);
  assert.equal((await requests(options.directory)).length, 14);
  for (const row of await requests(options.directory)) assert.deepEqual(Object.keys(row.request).sort(), ['left', 'protocol', 'right', 'schema']);
  assert.ok(replay.rows.every(row => row.after.model === 'CONTRACT_STUB'));
  assert.equal(replay.automaticMerge, false);
  assert.equal(replay.billedCostUsd, null);
  assert.equal(replay.humanReviewSeconds, null);
  await assert.rejects(runFollowup({ ...options, mode: 'start' }), /EEXIST/u);
  assert.equal((await requests(options.directory)).length, 14);
});

test('two failed attempts stop all further calls including after restart', async t => {
  const options = { ...await setup(t), contractScenario: 'failure' };
  const first = await runFollowup({ ...options, mode: 'start' });
  assert.equal(first.status, 'STOPPED_AFTER_FAILURE_LIMIT');
  assert.equal(first.adapterAttemptsThisInvocation, 2);
  const next = await runFollowup({ ...options, mode: 'continue' });
  assert.equal(next.adapterAttemptsThisInvocation, 0);
  assert.equal((await requests(options.directory)).length, 2);
  assert.equal((await readFile(join(options.directory, 'requests.jsonl'), 'utf8')).includes('sensitive-error'), false);
});

test('changed run identity and existing invocation lock reject before reviewer calls', async t => {
  const options = { ...await setup(t), contractScenario: 'failure' };
  await assert.rejects(runFollowup({ ...options, runtime: { ...options.runtime, configuredModel: 'changed' }, mode: 'start' }), /RUNTIME_MISMATCH/u);
  await assert.rejects(readFile(join(options.directory, 'requests.jsonl')), { code: 'ENOENT' });
  await runFollowup({ ...options, mode: 'start' });
  const lockPath = join(options.directory, 'run.lock');
  await writeFile(lockPath, 'separate-active-writer', { flag: 'wx' });
  await assert.rejects(runFollowup({ ...options, mode: 'continue' }), /EEXIST/u);
  assert.equal(await readFile(lockPath, 'utf8'), 'separate-active-writer');
  await rm(lockPath); // This test created and owns the non-process fixture lock.
  const identityPath = join(options.directory, 'run.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  identity.runnerHash = 'changed';
  await writeFile(identityPath, JSON.stringify(identity));
  await assert.rejects(runFollowup({ ...options, mode: 'continue' }), /RUN_IDENTITY_CHANGED/u);
  assert.equal((await requests(options.directory)).length, 2);
});

test('contract checks reject all caller-supplied provider callbacks before creating a run', async t => {
  const options = await setup(t); let calls = 0;
  for (const mode of ['start', 'continue', 'replay']) {
    await assert.rejects(runFollowup({ ...options, mode, reviewer: () => { calls++; } }), /CONTRACT_STUB_ONLY/u);
  }
  assert.equal(calls, 0);
  await assert.rejects(readFile(join(options.directory, 'run.json')), { code: 'ENOENT' });
});

test('real follow-up retains the historical product hashes and cannot reopen on changed source', async t => {
  const options = await setup(t); let calls = 0;
  await assert.rejects(loadProtocol(), /FOLLOWUP_PRODUCT_CHANGED/u);
  for (const mode of ['start', 'continue', 'replay']) {
    await assert.rejects(runFollowup({ ...options, mode, observationMode: 'REAL_CONFIGURED_HERMES',
      reviewer: () => { calls++; } }), /FOLLOWUP_PRODUCT_CHANGED/u);
  }
  assert.equal(calls, 0);
  await assert.rejects(readFile(join(options.directory, 'run.json')), { code: 'ENOENT' });
});
