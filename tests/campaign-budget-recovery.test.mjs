import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewDuplicatesWithJournalFile as review } from '../src/review-journal-file.mjs';

const left = { persona: 'Synthetic operators', jobToBeDone: 'Review uncertain invoice fields', constraints: { mode: 'offline' } };
const right = { persona: 'Synthetic operators', jobToBeDone: 'Reconcile the payment queue before publication', constraints: { mode: 'offline' } };
const revision = 'CRASHED_SYNTHETIC_CALLBACK_V1';
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'needradar-budget-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, journalPath: join(directory, 'pair.json'), reviewerRevision: revision,
    campaignBudget: { path: join(directory, 'budget.json'), scopeDigest: 'c'.repeat(64), maxModelCalls: 1 } };
}

test('a real exited callback leaves a reservation and locks; explicit fixture recovery cannot restore its budget', async t => {
  const options = await setup(t), moduleUrl = new URL('../src/review-journal-file.mjs', import.meta.url).href;
  const code = `import {reviewDuplicatesWithJournalFile as review} from ${JSON.stringify(moduleUrl)};
    await review(${JSON.stringify(left)},[${JSON.stringify(right)}],{...JSON.parse(process.argv[1]),reviewer:async()=>process.exit(73)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)], { encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 73, child.stderr);
  const budget = JSON.parse(await readFile(options.campaignBudget.path, 'utf8'));
  assert.equal(budget.events.length, 1);
  assert.equal(budget.events[0].type, 'STARTED');
  let calls = 0;
  await assert.rejects(review(left, [right], { ...options, journalPath: join(options.directory, 'second.json'), reviewer: async () => { calls++; } }), /REVIEW_BUDGET_LOCKED/u);
  // Explicit recovery belongs only to these known fixture locks after the
  // owned child has exited. Production code never removes stale locks.
  await unlink(options.campaignBudget.path + '.lock');
  await unlink(options.journalPath + '.lock');
  const result = await review(left, [right], { ...options, journalPath: join(options.directory, 'second.json'), reviewer: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(result.campaignProgress.unfinishedReservations, 1);
  assert.equal(result.campaignProgress.remainingCalls, 0);
  assert.equal(result.campaignProgress.unknownCostCalls, 1);
  assert.equal(result.campaignProgress.totalCostUsd, null);
});

test('invalid ceilings fail before dispatch', async t => {
  const options = await setup(t); let calls = 0;
  for (const value of [-1, 0.5, '1', 4097, Infinity, null]) {
    await assert.rejects(review(left, [right], { ...options, campaignBudget: { ...options.campaignBudget, maxModelCalls: value },
      reviewer: async () => { calls++; } }), /REVIEW_BUDGET_POLICY_INVALID/u);
  }
  assert.equal(calls, 0);
});

test('duplicate reservations in edited budget history are rejected', async t => {
  const options = await setup(t), event = { type: 'STARTED', attemptId: 1, pairDigest: 'd'.repeat(64), recordedAt: '2026-10-31T12:00:00.000Z' };
  await writeFile(options.campaignBudget.path, JSON.stringify({ version: 1, kind: 'NEEDRADAR_REVIEW_BUDGET_V1',
    scopeDigest: options.campaignBudget.scopeDigest, reviewerRevision: revision, maxModelCalls: 1, events: [event, event] }));
  let calls = 0;
  await assert.rejects(review(left, [right], { ...options, reviewer: async () => { calls++; } }), /REVIEW_BUDGET_RESERVATION_INVALID/u);
  assert.equal(calls, 0);
});
