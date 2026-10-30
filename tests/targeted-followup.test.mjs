import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProtocol, runFollowup } from '../scripts/evaluate-targeted-followup.mjs';

async function setup(t) {
  const parent = await mkdtemp(join(tmpdir(), 'needradar-targeted-contract-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { plan } = await loadProtocol();
  return { directory: join(parent, 'run'), runtime: plan.runtime };
}

test('bounded live-shaped calls resume without repeat and replay consumes zero', async t => {
  const options = await setup(t);
  let calls = 0;
  const reviewer = async request => {
    calls++;
    assert.deepEqual(Object.keys(request).sort(), ['left', 'protocol', 'right', 'schema']);
    return { decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
      leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone },
    toolCalls: 0, model: options.runtime.configuredModel, usage: null, costUsd: null };
  };
  const first = await runFollowup({ ...options, reviewer, mode: 'start' });
  assert.equal(first.adapterAttemptsThisInvocation, 7);
  assert.equal(first.totalReservedAttempts, 7);
  const next = await runFollowup({ ...options, reviewer, mode: 'continue' });
  assert.equal(next.adapterAttemptsThisInvocation, 7);
  assert.equal(next.totalReservedAttempts, 14);
  const replay = await runFollowup({ ...options, mode: 'replay', reviewer: () => { throw new Error('MUST_NOT_RUN'); } });
  assert.equal(replay.adapterAttemptsThisInvocation, 0);
  assert.equal(replay.rows.filter(r => r.after.method === 'MODEL_PROPOSAL_REUSED').length, 14);
  assert.equal(replay.after.unresolvedPairs, 14);
  const closed = await runFollowup({ ...options, reviewer, mode: 'continue' });
  assert.equal(closed.adapterAttemptsThisInvocation, 0);
  assert.equal(calls, 14);
  assert.equal(replay.automaticMerge, false);
  assert.equal(replay.billedCostUsd, null);
  assert.equal(replay.humanReviewSeconds, null);
  await assert.rejects(runFollowup({ ...options, reviewer, mode: 'start' }), /EEXIST/u);
  assert.equal(calls, 14);
});

test('two failed attempts stop all further calls including after restart', async t => {
  const options = await setup(t); let calls = 0;
  const reviewer = async () => { calls++; throw new Error('sensitive-error-must-not-escape'); };
  const first = await runFollowup({ ...options, reviewer, mode: 'start' });
  assert.equal(first.status, 'STOPPED_AFTER_FAILURE_LIMIT');
  assert.equal(first.adapterAttemptsThisInvocation, 2);
  const next = await runFollowup({ ...options, reviewer, mode: 'continue' });
  assert.equal(next.adapterAttemptsThisInvocation, 0);
  assert.equal(calls, 2);
  assert.equal((await readFile(join(options.directory, 'requests.jsonl'), 'utf8')).includes('sensitive-error'), false);
});

test('changed run identity and existing invocation lock reject before reviewer calls', async t => {
  const options = await setup(t); let calls = 0;
  const reviewer = async () => { calls++; throw new Error('FIXTURE_FAILURE'); };
  await assert.rejects(runFollowup({ ...options, runtime: { ...options.runtime, configuredModel: 'changed' }, reviewer, mode: 'start' }), /RUNTIME_MISMATCH/u);
  assert.equal(calls, 0);
  await runFollowup({ ...options, reviewer, mode: 'start' });
  const lockPath = join(options.directory, 'run.lock');
  await writeFile(lockPath, 'separate-active-writer', { flag: 'wx' });
  await assert.rejects(runFollowup({ ...options, reviewer, mode: 'continue' }), /EEXIST/u);
  assert.equal(await readFile(lockPath, 'utf8'), 'separate-active-writer');
  await rm(lockPath); // This test created and owns the non-process fixture lock.
  const identityPath = join(options.directory, 'run.json');
  const identity = JSON.parse(await readFile(identityPath, 'utf8'));
  identity.runnerHash = 'changed';
  await writeFile(identityPath, JSON.stringify(identity));
  await assert.rejects(runFollowup({ ...options, reviewer, mode: 'continue' }), /RUN_IDENTITY_CHANGED/u);
  assert.equal(calls, 2);
});
