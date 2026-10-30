// Explicit, bounded follow-up of exposed synthetic pairs; never a production worker.
import { open, readFile, mkdir, readdir, unlink, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createCommandReviewer } from '../src/command-reviewer.mjs';
import { reviewDuplicates, validateReview } from '../src/semantic-review.mjs';
import { reviewDuplicatesWithJournalFile } from '../src/review-journal-file.mjs';
import { validateReviewJournal } from '../src/review-journal.mjs';
import { fixtureHash, loadFixtures } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = text => createHash('sha256').update(text).digest('hex');
const readLF = async path => (await readFile(path, 'utf8')).replaceAll('\r\n', '\n');
const safeJSON = value => asciiJSON(value).replace(/\n\s*/gu, '') + '\n';

export function summarize(rows, field) {
  return {
    pairs: rows.length,
    falseMergeProposals: rows.filter(r => r.expected === 'different' && r[field].verdict === 'same').length,
    falseDistinctProposals: rows.filter(r => r.expected === 'same' && r[field].verdict === 'different').length,
    unresolvedDuplicatePairs: rows.filter(r => r.expected === 'same' && r[field].verdict === 'uncertain').length,
    unresolvedPairs: rows.filter(r => r[field].verdict === 'uncertain').length,
    sameProposals: rows.filter(r => r[field].verdict === 'same').length,
    differentProposals: rows.filter(r => r[field].verdict === 'different').length,
  };
}

export async function loadProtocol() {
  const text = await readLF(join(root, 'eval/targeted-followup-v1/plan.json'));
  const plan = JSON.parse(text), fixtures = await loadFixtures();
  const observation = await readLF(join(root, 'eval/results/2026-10-29-local-retrieval-pairs.json'));
  if (plan.protocol !== 'TARGETED_SEMANTIC_FOLLOWUP_V1' || plan.fixtureHash !== fixtureHash
      || plan.maxAdapterAttempts !== 14 || plan.maxNewCallsPerInvocation !== 7 || plan.stopAfterFailures !== 2
      || hash(observation) !== plan.retrievalObservationLFHash) throw new Error('FOLLOWUP_PROTOCOL_INVALID');
  const targets = JSON.parse(observation).observations.filter(r => r.expected === 'same' && !r.withinDefaultReviewBudget);
  const ids = targets.flatMap(r => [r.id, r.id.split('--')[0] + '--nearby_distinct']);
  if (ids.length !== 14 || new Set(ids).size !== 14 || JSON.stringify(ids) !== JSON.stringify(plan.selectedIds)) throw new Error('FOLLOWUP_SELECTION_CHANGED');
  const cases = ids.map(id => fixtures.cases.find(r => r.id === id));
  if (cases.some(r => !r) || cases.filter(r => r.expected === 'same').length !== 7) throw new Error('FOLLOWUP_FIXTURE_MISSING');
  for (const [path, expected] of Object.entries(plan.productLFHashes)) {
    if (hash(await readLF(join(root, path))) !== expected) throw new Error('FOLLOWUP_PRODUCT_CHANGED');
  }
  return { plan, cases, protocolHash: hash(text), runnerHash: hash(await readLF(fileURLToPath(import.meta.url))) };
}

export async function runFollowup({ directory, mode, runtime, reviewer, observationMode = 'CONTRACT_ONLY' }) {
  if (!['start', 'continue', 'replay'].includes(mode) || typeof directory !== 'string'
      || !['CONTRACT_ONLY', 'REAL_CONFIGURED_HERMES'].includes(observationMode)) throw new Error('FOLLOWUP_EXPLICIT_MODE_REQUIRED');
  const { plan, cases, protocolHash, runnerHash } = await loadProtocol();
  const requested = resolve(directory), parent = await realpath(dirname(requested));
  directory = join(parent, requested.split(sep).at(-1));
  if (directory === root || directory.startsWith(root + sep)) throw new Error('FOLLOWUP_DIRECTORY_MUST_BE_OUTSIDE_CHECKOUT');
  if (mode !== 'replay') {
    if (typeof reviewer !== 'function' || !runtime || Object.entries(plan.runtime).some(([key, value]) => runtime[key] !== value)) throw new Error('FOLLOWUP_RUNTIME_MISMATCH');
  }
  if (mode === 'start') await mkdir(directory); // Exclusive, including across repeated commands.
  const lockPath = join(directory, 'run.lock'), owner = randomUUID();
  const lock = await open(lockPath, 'wx');
  let audit;
  try {
    await lock.writeFile(owner); await lock.sync();
    const identityPath = join(directory, 'run.json');
    let identity;
    if (mode === 'start') {
      identity = { protocol: plan.protocol, protocolHash, runnerHash, observationMode,
        runtime: Object.fromEntries(Object.keys(plan.runtime).map(key => [key, runtime[key]])),
        startedAt: new Date().toISOString(), syntheticOnly: true, node: process.version,
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim() };
      const file = await open(identityPath, 'wx');
      try { await file.writeFile(asciiJSON(identity)); await file.sync(); } finally { await file.close(); }
    } else {
      identity = JSON.parse(await readFile(identityPath, 'utf8'));
      if (identity.protocolHash !== protocolHash || identity.runnerHash !== runnerHash
          || identity.observationMode !== observationMode
          || JSON.stringify(identity.runtime) !== JSON.stringify(plan.runtime)) throw new Error('FOLLOWUP_RUN_IDENTITY_CHANGED');
    }
    const reviewerRevision = hash(JSON.stringify([plan.runtime, plan.productLFHashes, protocolHash]));
    const journalPath = join(directory, 'proposals.json');
    let journal = { version: 1, reviewProtocol: 'OPPORTUNITY_PAIR_REVIEW_V1', reviewerRevision, events: [] };
    try { journal = JSON.parse(await readFile(journalPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    validateReviewJournal(journal, reviewerRevision);
    audit = await open(join(directory, 'requests.jsonl'), 'a');
    const append = async value => { await audit.write(safeJSON(value)); await audit.sync(); };
    const atStart = journal.events.filter(r => r.type === 'STARTED').length;
    let calls = 0;
    const wrapped = async request => {
      if (mode === 'replay' || calls >= plan.maxNewCallsPerInvocation || atStart + calls >= plan.maxAdapterAttempts) throw new Error('FOLLOWUP_BUDGET_EXHAUSTED');
      calls++;
      await append({ type: 'REQUEST_STARTED', at: new Date().toISOString(), ordinal: atStart + calls, request });
      try {
        const response = await reviewer(request);
        if (response.model !== plan.runtime.configuredModel || response.toolCalls !== 0) throw new Error('FOLLOWUP_RESPONSE_RUNTIME_MISMATCH');
        validateReview(response.decision, request.left, request.right);
        await append({ type: 'RESPONSE', at: new Date().toISOString(), ordinal: atStart + calls, response });
        return response;
      } catch {
        await append({ type: 'REQUEST_FAILED', at: new Date().toISOString(), ordinal: atStart + calls, reason: 'ADAPTER_OR_GROUNDED_RESPONSE_FAILED' });
        throw new Error('FOLLOWUP_REVIEW_FAILED');
      }
    };
    const started = performance.now(), rows = [];
    for (const item of cases) {
      const reserved = journal.events.filter(r => r.type === 'STARTED').length;
      const failures = journal.events.filter(r => r.type === 'FAILED').length;
      const before = await reviewDuplicates(item.left, [item.right], { maxModelCalls: 0 });
      const canCall = mode !== 'replay' && calls < plan.maxNewCallsPerInvocation
        && reserved < plan.maxAdapterAttempts && failures < plan.stopAfterFailures;
      const after = await reviewDuplicatesWithJournalFile(item.left, [item.right], {
        journalPath, reviewerRevision, reviewer: wrapped, maxModelCalls: canCall ? 1 : 0,
      });
      journal = after.reviewJournal;
      rows.push({ id: item.id, category: item.category, originalSplit: item.split, expected: item.expected,
        before: before.reviews[0], after: after.reviews[0], modelCalls: after.modelCalls,
        automaticMerge: after.automaticMerge, scope: 'SINGLE_PRESELECTED_PAIR_NOT_FULL_RETRIEVAL_QUEUE' });
    }
    const totalReserved = journal.events.filter(r => r.type === 'STARTED').length;
    const failed = journal.events.filter(r => r.type === 'FAILED').length;
    const unresolved = rows.filter(r => r.after.verdict === 'uncertain').length;
    const result = { observedAt: new Date().toISOString(), protocolHash, runnerHash, mode, identity,
      status: failed >= plan.stopAfterFailures ? 'STOPPED_AFTER_FAILURE_LIMIT' : totalReserved >= plan.maxAdapterAttempts ? 'CALL_BUDGET_CLOSED' : 'BOUNDED_INVOCATION_COMPLETED',
      adapterAttemptsThisInvocation: calls, totalReservedAttempts: totalReserved, failedAttempts: failed,
      uncertainPairs: unresolved, elapsedMs: Number((performance.now() - started).toFixed(3)), rows,
      before: summarize(rows, 'before'), after: summarize(rows, 'after'),
      internalProviderRequests: null, billedCostUsd: null, tokenUsage: null, humanReviewSeconds: null,
      automaticMerge: false, productionActions: 0, freshIndependentHoldout: false,
      scope: 'Targeted exposed synthetic pair adjudication and saved-proposal reuse. No full-queue completion or general quality gain established.' };
    const files = await readdir(directory);
    const ordinal = files.filter(name => /^observation-\d{3}\.json$/u.test(name)).length + 1;
    const file = await open(join(directory, `observation-${String(ordinal).padStart(3, '0')}.json`), 'wx');
    try { await file.writeFile(asciiJSON(result)); await file.sync(); } finally { await file.close(); }
    return result;
  } finally {
    if (audit) await audit.close();
    await lock.close();
    if (await readFile(lockPath, 'utf8') === owner) await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2], index = process.argv.indexOf('--run-dir');
  if (index < 0 || !process.argv[index + 1]) throw new Error('EXPLICIT_RUN_DIRECTORY_REQUIRED');
  if (mode !== 'replay' && (!process.argv.includes('--command') || process.env.NEEDRADAR_ALLOW_COMMAND !== 'true')) throw new Error('EXPLICIT_COMMAND_OPT_IN_REQUIRED');
  const reviewer = mode === 'replay' ? undefined : createCommandReviewer({ executable: process.env.NEEDRADAR_REVIEW_EXECUTABLE,
    args: JSON.parse(process.env.NEEDRADAR_REVIEW_ARGS ?? '[]'), allowExecution: true });
  const result = await runFollowup({ directory: process.argv[index + 1], mode,
    runtime: JSON.parse(process.env.NEEDRADAR_REVIEW_RUNTIME ?? '{}'), reviewer, observationMode: 'REAL_CONFIGURED_HERMES' });
  console.log(JSON.stringify({ status: result.status, attempts: result.adapterAttemptsThisInvocation,
    totalReserved: result.totalReservedAttempts, before: result.before, after: result.after }));
}
