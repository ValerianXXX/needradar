import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pairDigest, reviewDuplicates } from '../src/semantic-review.mjs';
import { reviewDuplicatesWithJournalFile } from '../src/review-journal-file.mjs';
import { validateReviewJournal } from '../src/review-journal.mjs';

const candidate = { title: 'Invoice review', persona: 'Review operators', jobToBeDone: 'Review uncertain invoice fields',
  desiredOutcome: 'Verified fields', constraints: { processing: 'offline' } };
const corpus = Array.from({ length: 20 }, (_, index) => ({ ...candidate, id: `record-${index}`,
  jobToBeDone: `Reconcile invoice queue ${index} before publication` }));
const revision = 'contract-stub-prompt-1';
const reviewer = async request => ({ decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
  leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'CONTRACT_STUB' });
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'needradar-journal-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, journalPath: join(directory, 'review.json'), reviewerRevision: revision, reviewer };
}

test('real file resumes across new Node processes and retains twenty attempts', async t => {
  const options = await setup(t);
  const code = `import { reviewDuplicatesWithJournalFile } from ${JSON.stringify(new URL('../src/review-journal-file.mjs', import.meta.url).href)};
    const result = await reviewDuplicatesWithJournalFile(${JSON.stringify(candidate)}, ${JSON.stringify(corpus)}, {
      journalPath: process.argv[1], reviewerRevision: ${JSON.stringify(revision)}, reviewer: ${reviewer.toString()}
    }); console.log(JSON.stringify({modelCalls: result.modelCalls, progress: result.reviewProgress}));`;
  const counts = [];
  for (let round = 0; round < 3; round++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, options.journalPath], { windowsHide: true });
    let output = '', error = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { error += bytes; });
    const [status] = await once(child, 'close');
    assert.equal(status, 0, error);
    counts.push(JSON.parse(output).modelCalls);
  }
  assert.deepEqual(counts, [8, 8, 4]);
  const journal = JSON.parse(await readFile(options.journalPath, 'utf8'));
  assert.equal(validateReviewJournal(journal, revision).attempts, 20);
  assert.deepEqual(await readdir(options.directory), ['review.json']);
});

test('a concurrent writer is rejected without a second provider call', async t => {
  const options = await setup(t);
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const first = reviewDuplicatesWithJournalFile(candidate, corpus.slice(0, 1), { ...options,
    reviewer: async request => { entered(); await wait; return reviewer(request); } });
  await ready;
  try { await assert.rejects(reviewDuplicatesWithJournalFile(candidate, corpus, options), /REVIEW_JOURNAL_LOCKED/u); }
  finally { release(); }
  assert.equal((await first).modelCalls, 1);
});

test('an external journal edit is retained and prevents subsequent provider calls', async t => {
  const options = await setup(t);
  let calls = 0;
  await assert.rejects(reviewDuplicatesWithJournalFile(candidate, corpus, { ...options,
    reviewer: async request => { calls++; await writeFile(options.journalPath, 'EXTERNAL_EDIT'); return reviewer(request); }
  }), /REVIEW_JOURNAL_FILE_CHANGED/u);
  assert.equal(calls, 1);
  assert.equal(await readFile(options.journalPath, 'utf8'), 'EXTERNAL_EDIT');
  assert.deepEqual(await readdir(options.directory), ['review.json']);
});

test('killed process leaves an owned lock and an incomplete attempt; recovery needs explicit intervention', { timeout: 10000 }, async t => {
  const options = await setup(t);
  const code = `import { reviewDuplicatesWithJournalFile } from ${JSON.stringify(new URL('../src/review-journal-file.mjs', import.meta.url).href)};
    await reviewDuplicatesWithJournalFile(${JSON.stringify(candidate)}, ${JSON.stringify(corpus.slice(0, 1))}, {
      journalPath: process.argv[1], reviewerRevision: ${JSON.stringify(revision)},
      reviewer: async () => { console.log('PROVIDER_STARTED'); await new Promise(resolve => setTimeout(resolve, 30000)); }
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, options.journalPath], { windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const closed = once(child, 'close');
  const started = await new Promise((resolve, reject) => {
    child.stdout.once('data', bytes => resolve(String(bytes)));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('CHILD_EXITED_BEFORE_START')));
  });
  assert.match(started, /PROVIDER_STARTED/u);
  child.kill();
  await closed;
  await assert.rejects(reviewDuplicatesWithJournalFile(candidate, corpus, options), /REVIEW_JOURNAL_LOCKED/u);
  const journal = JSON.parse(await readFile(options.journalPath, 'utf8'));
  assert.equal(journal.events.length, 1);
  // Explicit simulated operator intervention, only after this owned child exits.
  await unlink(options.journalPath + '.lock');
  const result = await reviewDuplicatesWithJournalFile(candidate, corpus.slice(0, 1), options);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.reviews[0].method, 'REVIEW_INTERRUPTED');
});

test('corrupt, oversized and wrong-version files block before invoking a reviewer', async t => {
  const options = await setup(t);
  for (const value of ['broken JSON', 'x'.repeat(2 * 1024 * 1024 + 1), JSON.stringify({ version: 99 })]) {
    await writeFile(options.journalPath, value);
    let calls = 0;
    await assert.rejects(reviewDuplicatesWithJournalFile(candidate, corpus, { ...options,
      reviewer: async request => { calls++; return reviewer(request); } }));
    assert.equal(calls, 0);
    assert.equal(await readFile(options.journalPath, 'utf8'), value);
  }
});

test('retry ceiling counts failed and uncertainly completed starts, never removing history', async () => {
  let reviewJournal;
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision, reviewJournal,
      retryFailedPairs: [pairDigest(candidate, corpus[0])], reviewer: async () => { throw new Error('FAIL'); } });
    reviewJournal = result.reviewJournal;
    assert.equal(result.modelCalls, attempt < 3 ? 1 : 0);
    if (attempt === 3) assert.equal(result.reviews[0].method, 'REVIEW_RETRY_LIMIT');
  }
  assert.equal(reviewJournal.events.filter(event => event.type === 'FAILED').length, 3);
});

test('cancellation during checkpoint never starts the subsequent provider call', async () => {
  const control = new AbortController();
  const result = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision, signal: control.signal,
    onCheckpoint: async () => control.abort(), reviewer });
  assert.equal(result.modelCalls, 0);
  assert.equal(result.reviews[0].method, 'REVIEW_CANCELLED');
});

test('only allowlisted usage metadata persists and unknown cost stays unknown', async () => {
  const first = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision,
    reviewer: async request => ({ ...(await reviewer(request)), elapsedMs: -1, costUsd: undefined,
      usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2, secret: 'not-retained' } }) });
  const saved = JSON.parse(JSON.stringify(first.reviewJournal));
  const result = await reviewDuplicates(candidate, corpus.slice(0, 1), { reviewerRevision: revision, reviewJournal: saved });
  assert.equal(result.reviews[0].costUsd, null);
  assert.equal(result.reviews[0].elapsedMs, null);
  assert.equal(JSON.stringify(saved).includes('not-retained'), false);
  assert.equal(result.reviews[0].usage.total_tokens, 10);
});

test('caller edits during an awaited model response do not change the active snapshot', async () => {
  const query = structuredClone(candidate), peers = structuredClone(corpus.slice(0, 2));
  const result = await reviewDuplicates(query, peers, { reviewerRevision: revision, reviewer: async request => {
    query.constraints.processing = 'cloud';
    peers[1].jobToBeDone = 'Changed while awaiting';
    return reviewer(request);
  } });
  assert.equal(result.reviews[1].pairDigest, pairDigest(candidate, corpus[1]));
  assert.equal(result.reviews[1].method, 'MODEL_PROPOSAL');
});
