import { open, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { createLocalEncoder } from '../src/local-encoder.mjs';
import { createSemanticCandidateIndex } from '../src/semantic-retrieval.mjs';
import { decidePublicationWithReview } from '../src/pipeline.mjs';
import { loadFixtures, fixtureHash } from '../eval/boundaries-v2/load.mjs';
import { asciiJSON } from './build-boundary-fixtures.mjs';

const output = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : null;
if (!output || process.env.NEEDRADAR_ALLOW_LOCAL_ENCODER !== 'true') throw new Error('EXPLICIT_WORKFLOW_CHECK_REQUIRED');
const receipt = await open(output, 'wx'), fixtures = await loadFixtures();
const journalText = await readFile(new URL('../eval/results/2026-10-29-boundaries-hermes.requests.jsonl', import.meta.url), 'utf8');
const entries = journalText.trim().split(/\r?\n/u).map(line => JSON.parse(line));
const recorded = new Map();
for (let i = 0; i < entries.length; i += 2) {
  const request = entries[i], response = entries[i + 1];
  if (request.type === 'REQUEST_STARTED' && response?.type === 'RESPONSE' && response.ordinal === request.ordinal) recorded.set(JSON.stringify(request.request), response.response);
}
try {
  const pair = fixtures.cases.find(row => row.id === 'invoice--cross_language');
  const distractor = fixtures.cases.find(row => row.id === 'invoice--nearby_distinct').right;
  const corpus = Array.from({ length: 99 }, (_, index) => ({ ...distractor, id: `other-${index}`,
    jobToBeDone: `${distractor.jobToBeDone} Reference queue ${index}.` }));
  corpus.push({ ...pair.right, id: 'target' });
  const encode = createLocalEncoder({ pythonExecutable: process.env.NEEDRADAR_ENCODER_PYTHON,
    modelDirectory: process.env.NEEDRADAR_ENCODER_MODEL_DIR, allowExecution: true, threads: 2 });
  const encoded = await encode(corpus), query = await encode([pair.left]);
  const index = createSemanticCandidateIndex(corpus, encoded);
  let recordedResponses = 0, explicitUncertainStubs = 0;
  const reviewer = async request => {
    if (recorded.has(JSON.stringify(request))) { recordedResponses++; return recorded.get(JSON.stringify(request)); }
    explicitUncertainStubs++;
    return { decision: { verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION',
      leftQuote: request.left.jobToBeDone, rightQuote: request.right.jobToBeDone }, model: 'EXPLICIT_UNCERTAIN_CONTRACT_STUB' };
  };
  const cluster = { draft: { ...pair.left, currentWorkflow: 'Manual source review', aiPath: ['Prepare fields'],
    humanGates: ['Confirm source interpretation'], counterEvidence: ['Manual review may be sufficient'], unknowns: ['Measured time saved'] },
    observations: [0, 1, 2].map(index => ({ evidenceKey: `synthetic-${index}`, authorGroup: `synthetic-author-${index}`,
      sourcePolicy: `synthetic-policy-${index}`, sourceAccessible: true, rightsApproved: true, containsPersonalData: false })) };
  const result = await decidePublicationWithReview(cluster, index, { queryEmbedding: query.rows[0], reviewer, maxModelCalls: 8 });
  assert.equal(recordedResponses, 1);
  assert.equal(result.decision, 'SUPPRESS_DUPLICATE');
  assert.equal(result.automaticMerge, false);
  assert.equal(result.semantic.requiresReview, true); // Other pairs/search coverage remain unresolved.
  assert.ok(result.semantic.reviews.some(row => row.verdict === 'same' && row.retrievalEvidence?.denseRank));
  assert.equal(corpus.length, 100);
  const files = ['src/pipeline.mjs', 'src/semantic-review.mjs', 'src/semantic-retrieval.mjs', 'src/local-encoder.mjs', 'scripts/local-embed.py', 'scripts/check-retrieval-review-workflow.mjs'];
  const hashes = Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash('sha256').update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n')).digest('hex')])));
  await receipt.writeFile(asciiJSON({ observedAt: new Date().toISOString(), status: 'PASS', syntheticOnly: true,
    mode: 'ACTUAL_LOCAL_RETRIEVAL_WITH_RECORDED_REAL_PAIR_RESPONSE_AND_UNCERTAIN_CONTRACT_STUBS', fixtureHash,
    sourceLFHashes: hashes, journalLFHash: createHash('sha256').update(journalText.replaceAll('\r\n', '\n')).digest('hex'),
    recordedResponses, explicitUncertainStubs, liveLlmRequests: 0, sourceRecordsRemoved: 0,
    encoding: { corpus: encoded.observation, query: query.observation }, result,
    limitation: 'Current integration replay, not a new live Hermes test, authenticated human merge or production publication.' }));
  console.log(JSON.stringify({ status: 'PASS', recordedResponses, explicitUncertainStubs, decision: result.decision }));
} finally { await receipt.close(); }
