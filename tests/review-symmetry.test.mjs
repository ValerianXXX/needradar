import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { REVIEW_VERSION, pairDigest, reviewDuplicates } from '../src/semantic-review.mjs';
import { validateReviewJournal } from '../src/review-journal.mjs';

const left = { title: 'Review invoice fields', persona: 'Invoice operators',
  jobToBeDone: 'Reconcile uncertain invoice fields before saving', desiredOutcome: 'Verified invoice records',
  constraints: { processing: 'offline' } };
const right = { ...left, title: 'Check a document', jobToBeDone: 'Match doubtful invoice values to the source document' };
const revision = 'synthetic-symmetric-review-contract-v1';
const decision = (a, b, verdict = 'same', reason) => ({ verdict,
  reason: reason ?? ({ same: 'SAME_TASK_AND_CONSTRAINTS', different: 'DIFFERENT_TASK', uncertain: 'INSUFFICIENT_INFORMATION' })[verdict],
  leftQuote: a.jobToBeDone, rightQuote: b.jobToBeDone });
const observation = value => ({ decision: value, model: 'SYNTHETIC_CONTRACT_STUB',
  elapsedMs: 11, costUsd: null, usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } });
function history(entries, a = left, b = right) {
  const events = [];
  for (const [index, entry] of entries.entries()) {
    const [first, second] = entry.reverse ? [b, a] : [a, b];
    const base = { attemptId: index + 1, pairDigest: pairDigest(first, second),
      recordedAt: new Date(Date.UTC(2026, 9, 31, 0, 0, index)).toISOString() };
    events.push({ type: 'STARTED', ...base });
    if (entry.type !== 'STARTED') events.push({ type: entry.type ?? 'RESULT', ...base,
      ...(entry.type === 'FAILED' ? {} : { response: observation(decision(first, second, entry.verdict, entry.reason)) }) });
  }
  const journal = { version: 1, reviewProtocol: REVIEW_VERSION, reviewerRevision: revision, events };
  validateReviewJournal(journal, revision);
  return journal;
}
async function run(a, b, journal, extra = {}) {
  let callbacks = 0;
  const result = await reviewDuplicates(a, [b], { reviewerRevision: revision, reviewJournal: journal,
    reviewer: async request => { callbacks++; return observation(decision(request.left, request.right)); }, ...extra });
  return { result, row: result.reviews[0], callbacks };
}

for (const verdict of ['same', 'different', 'uncertain']) test(`reverse ${verdict} proposal reuses one observation with correctly oriented quotes`, async () => {
  const journal = history([{ verdict }]), original = structuredClone(journal);
  const { result, row, callbacks } = await run(right, left, journal);
  assert.equal(callbacks, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(row.method, 'MODEL_PROPOSAL_REUSED');
  assert.equal(row.verdict, verdict);
  assert.equal(row.leftQuote, right.jobToBeDone);
  assert.equal(row.rightQuote, left.jobToBeDone);
  assert.equal(row.pairDigest, pairDigest(right, left));
  assert.equal(row.originalPairDigest, pairDigest(left, right));
  assert.equal(row.originalAttemptId, 1);
  assert.equal(row.cacheOrientation, 'reversed');
  assert.equal(row.costUsd, null);
  assert.equal(row.elapsedMs, 11);
  assert.deepEqual(row.usage, { input_tokens: 8, output_tokens: 2, total_tokens: 10 });
  assert.equal(result.automaticMerge, false);
  assert.equal(result.requiresReview, verdict === 'uncertain');
  assert.deepEqual(journal, original);
  assert.deepEqual(result.reviewJournal, original);
});

test('same-direction cached metadata and original journal remain intact', async () => {
  const journal = history([{}]), { result, row, callbacks } = await run(left, right, journal, { maxModelCalls: 0 });
  assert.equal(callbacks, 0);
  assert.equal(row.cacheOrientation, 'same');
  assert.equal(row.originalPairDigest, row.pairDigest);
  assert.equal(row.originalAttemptId, 1);
  assert.deepEqual(result.reviewJournal, journal);
});

test('two agreeing legacy orientations select the latest attempt without deleting either', async () => {
  const journal = history([{}, { reverse: true }]);
  for (const [a, b] of [[left, right], [right, left]]) {
    const { result, row, callbacks } = await run(a, b, journal);
    assert.equal(callbacks, 0);
    assert.equal(row.originalAttemptId, 2);
    assert.equal(row.originalPairDigest, pairDigest(right, left));
    assert.equal(row.leftQuote, a.jobToBeDone);
    assert.deepEqual(result.reviewJournal, journal);
  }
});

for (const alternative of ['different', 'uncertain']) test(`contradictory same/${alternative} legacy observations require human review in both directions`, async () => {
  const journal = history([{}, { reverse: true, verdict: alternative }]);
  for (const [a, b] of [[left, right], [right, left]]) {
    const { result, row, callbacks } = await run(a, b, journal,
      { retryFailedPairs: [pairDigest(a, b)] });
    assert.equal(callbacks, 0);
    assert.equal(row.method, 'MODEL_PROPOSAL_CONFLICT');
    assert.equal(row.verdict, 'uncertain');
    assert.equal(row.reason, 'INSUFFICIENT_INFORMATION');
    assert.deepEqual(row.conflictingAttemptIds, [1, 2]);
    assert.equal(result.reviewProgress.conflictingPairs, 1);
    assert.equal(result.duplicate, false);
    assert.equal(result.requiresReview, true);
    assert.equal(result.automaticMerge, false);
    assert.deepEqual(result.reviewJournal, journal);
  }
});

test('agreeing distinct verdicts can retain different reasons while showing the latest source', async () => {
  const journal = history([{ verdict: 'different' }, { reverse: true, verdict: 'different', reason: 'DIFFERENT_PERSONA' }]);
  const { row, callbacks } = await run(left, right, journal);
  assert.equal(callbacks, 0);
  assert.equal(row.verdict, 'different');
  assert.equal(row.reason, 'DIFFERENT_PERSONA');
  assert.equal(row.originalAttemptId, 2);
});

test('an authenticated caller human correction still takes precedence over model disagreement', async () => {
  const journal = history([{}, { reverse: true, verdict: 'different' }]);
  const { row, result, callbacks } = await run(left, right, journal, { humanDecisions: [{
    id: 'synthetic-human-event', digest: pairDigest(right, left), decision: 'different',
    actor: 'SYNTHETIC_REVIEWER', reason: 'Separate task objects', recordedAt: '2026-10-31T12:00:00Z' }] });
  assert.equal(callbacks, 0);
  assert.equal(row.method, 'HUMAN_DECISION');
  assert.equal(row.verdict, 'different');
  assert.equal(result.duplicate, false);
});

test('explicit constraint conflicts continue to defeat cached positive proposals', async () => {
  const changed = { ...right, constraints: { processing: 'cloud' } };
  const { row, result, callbacks } = await run(changed, left, history([{}], left, changed));
  assert.equal(callbacks, 0);
  assert.equal(row.method, 'EXPLICIT_CONSTRAINTS');
  assert.equal(row.verdict, 'different');
  assert.equal(result.duplicate, false);
});

test('incomplete constraints do not become same merely because the reverse proposal says same', async () => {
  const missing = { ...right, constraints: {} };
  const { row, result, callbacks } = await run(missing, left, history([{}], left, missing));
  assert.equal(callbacks, 0);
  assert.equal(row.method, 'MODEL_PROPOSAL_REUSED');
  assert.equal(row.verdict, 'uncertain');
  assert.equal(result.duplicate, false);
  assert.equal(result.requiresReview, true);
});

test('changed source text remains a new bound request instead of reusing another pair', async () => {
  const changed = { ...right, jobToBeDone: right.jobToBeDone + ' for archive correction' };
  const { row, result, callbacks } = await run(changed, left, history([{}]));
  assert.equal(callbacks, 1);
  assert.equal(row.method, 'MODEL_PROPOSAL');
  assert.equal(result.reviewJournal.events.length, 4);
});

test('reverse reuse cannot switch reviewer revision', async () => {
  await assert.rejects(run(right, left, history([{}]), { reviewerRevision: 'other-runtime' }), /REVIEW_JOURNAL_REVISION_MISMATCH/u);
});

test('all applicable reverse quotations are validated before any new request', async () => {
  const journal = history([{}]);
  journal.events[1].response.decision.leftQuote = 'Invented statement with no source';
  let callbacks = 0;
  await assert.rejects(reviewDuplicates(right, [{ ...left, jobToBeDone: 'An unrelated queue to inspect first' }, left], {
    reviewerRevision: revision, reviewJournal: journal,
    reviewer: async r => { callbacks++; return observation(decision(r.left, r.right)); } }), /UNGROUNDED_SEMANTIC_REVIEW/u);
  assert.equal(callbacks, 0);
});

for (const type of ['FAILED', 'STARTED']) test(`reverse ${type} attempt cannot be silently retried`, async () => {
  const journal = history([{ type }]), { result, row, callbacks } = await run(right, left, journal);
  assert.equal(callbacks, 0);
  assert.equal(row.method, type === 'FAILED' ? 'REVIEW_FAILED' : 'REVIEW_INTERRUPTED');
  assert.equal(result.requiresReview, true);
  assert.deepEqual(result.reviewJournal, journal);
});

for (const alias of ['current', 'original']) test(`explicit retry accepts the ${alias} digest and appends one retained attempt`, async () => {
  const journal = history([{ type: 'FAILED' }]);
  const digest = alias === 'current' ? pairDigest(right, left) : pairDigest(left, right);
  const { result, row, callbacks } = await run(right, left, journal, { retryFailedPairs: [digest] });
  assert.equal(callbacks, 1);
  assert.equal(row.method, 'MODEL_PROPOSAL');
  assert.deepEqual(result.reviewJournal.events.slice(0, 2), journal.events);
  assert.equal(result.reviewJournal.events[2].attemptId, 2);
  assert.equal(result.reviewJournal.events[2].pairDigest, pairDigest(right, left));
});

test('three attempts across both orientations share one retry ceiling', async () => {
  const journal = history([{ type: 'FAILED' }, { type: 'FAILED', reverse: true }, { type: 'STARTED' }]);
  const { row, callbacks, result } = await run(right, left, journal, { retryFailedPairs: [pairDigest(right, left)] });
  assert.equal(callbacks, 0);
  assert.equal(row.method, 'REVIEW_RETRY_LIMIT');
  assert.deepEqual(result.reviewJournal, journal);
});

test('legacy journals with six cross-direction failures remain readable but allow no seventh call', async () => {
  const journal = history(Array.from({ length: 6 }, (_, index) => ({ type: 'FAILED', reverse: index % 2 === 1 })));
  const { row, callbacks, result } = await run(left, right, journal, { retryFailedPairs: [pairDigest(left, right)] });
  assert.equal(callbacks, 0);
  assert.equal(row.method, 'REVIEW_RETRY_LIMIT');
  assert.deepEqual(result.reviewJournal, journal);
});

test('a newer incomplete opposite attempt cannot be hidden behind an older positive result', async () => {
  const journal = history([{}, { type: 'STARTED', reverse: true }]);
  for (const [a, b] of [[left, right], [right, left]]) {
    const { row, callbacks, result } = await run(a, b, journal);
    assert.equal(callbacks, 0);
    assert.equal(row.method, 'REVIEW_INTERRUPTED');
    assert.equal(result.duplicate, false);
  }
});

test('a newer saved result can resolve an older failed opposite request without another call', async () => {
  const journal = history([{ type: 'FAILED' }, { reverse: true, verdict: 'different' }]);
  const { row, callbacks } = await run(left, right, journal);
  assert.equal(callbacks, 0);
  assert.equal(row.method, 'MODEL_PROPOSAL_REUSED');
  assert.equal(row.verdict, 'different');
  assert.equal(row.originalAttemptId, 2);
});

test('equal digests count each attempt once rather than doubling the retry ceiling', async () => {
  const incomplete = { ...left, persona: '' };
  const journal = history([{ type: 'FAILED' }, { type: 'FAILED' }], incomplete, incomplete);
  const { result, callbacks } = await run(incomplete, incomplete, journal, { retryFailedPairs: [pairDigest(incomplete, incomplete)] });
  assert.equal(callbacks, 1);
  assert.equal(result.reviewJournal.events.filter(x => x.type === 'STARTED').length, 3);
  assert.equal(result.duplicate, false);
});

test('cancelling an explicitly requested reverse retry records no new attempt', async () => {
  const control = new AbortController(); control.abort();
  const journal = history([{ type: 'FAILED' }]);
  const { result, callbacks, row } = await run(right, left, journal,
    { signal: control.signal, retryFailedPairs: [pairDigest(left, right)] });
  assert.equal(callbacks, 0);
  assert.equal(row.method, 'REVIEW_CANCELLED');
  assert.deepEqual(result.reviewJournal, journal);
});

test('a stale caller revision cannot publish an otherwise reusable reverse proposal', async () => {
  const { result, callbacks } = await run(right, left, history([{}]), { isInputCurrent: () => false });
  assert.equal(callbacks, 0);
  assert.equal(result.inputChanged, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.requiresReview, true);
});

test('returned reverse quotations and metadata cannot edit the trusted saved observation', async () => {
  const journal = history([{}]), before = structuredClone(journal);
  const { row, result, callbacks } = await run(right, left, journal);
  assert.equal(callbacks, 0);
  row.leftQuote = 'Edited preview'; row.usage.input_tokens = 999;
  assert.deepEqual(journal, before);
  assert.deepEqual(result.reviewJournal, before);
});

test('separate Node processes share a persisted pair when the second request is reversed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'needradar-symmetry-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journalPath = join(directory, 'review.json');
  const counts = [];
  for (const [a, b] of [[left, right], [right, left]]) {
    const code = `import { reviewDuplicatesWithJournalFile } from ${JSON.stringify(new URL('../src/review-journal-file.mjs', import.meta.url).href)};
      const result = await reviewDuplicatesWithJournalFile(${JSON.stringify(a)}, [${JSON.stringify(b)}], {
        journalPath: process.argv[1], reviewerRevision: ${JSON.stringify(revision)},
        reviewer: async request => ({ decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
          leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'SYNTHETIC_CHILD_STUB' }) });
      console.log(JSON.stringify({calls: result.modelCalls, method: result.reviews[0].method}));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, journalPath], { windowsHide: true });
    let output = '', errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors += bytes; });
    const [status] = await once(child, 'close');
    assert.equal(status, 0, errors);
    counts.push(JSON.parse(output).calls);
  }
  assert.deepEqual(counts, [1, 0]);
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  assert.equal(validateReviewJournal(journal, revision).attempts, 1);
  assert.equal(journal.events.length, 2);
});
