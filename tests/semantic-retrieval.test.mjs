import test from 'node:test';
import assert from 'node:assert/strict';
import { encoderId, encoderSpec, embeddingInput } from '../src/embedding-contract.mjs';
import { createLocalEncoder } from '../src/local-encoder.mjs';
import { createSemanticCandidateIndex, retrieveSemanticCandidates } from '../src/semantic-retrieval.mjs';
import { retrieveCandidates } from '../src/similarity.mjs';
import { reviewDuplicates } from '../src/semantic-review.mjs';
import { decidePublicationWithReview } from '../src/pipeline.mjs';

// Unit vectors test contracts only. They are never reported as model embeddings.
const unit = axis => Array.from({ length: 384 }, (_, index) => Number(index === axis));
const packet = (draft, axis = 0) => ({ encoderId, ...embeddingInput(draft), vector: unit(axis) });
const bundle = drafts => ({ encoderId, rows: drafts.map((draft, index) => packet(draft, index % 2)) });
const candidate = { id: 'query', title: 'Invoice review', persona: 'Reviewers',
  jobToBeDone: 'Review uncertain invoice fields', desiredOutcome: 'Verified fields', constraints: { processing: 'offline' } };

test('hybrid candidates preserve low-lexical targets without treating vectors as identity', async () => {
  const target = { ...candidate, id: 'target', title: 'Another language', persona: 'Accounting operators', jobToBeDone: 'Reconcile ambiguous billing entries' };
  const rows = Array.from({ length: 100 }, (_, index) => ({ ...candidate, id: `other-${index}`, jobToBeDone: 'Review uncertain shipment fields' }));
  rows.push(target);
  const embeddings = { encoderId, rows: rows.map(draft => packet(draft, draft.id === 'target' ? 0 : 1)) };
  const index = createSemanticCandidateIndex(rows, embeddings), queryEmbedding = packet(candidate);
  assert.equal(retrieveCandidates(candidate, rows).rows.some(row => row.existing.id === 'target'), false);
  const found = retrieveSemanticCandidates(candidate, index, { queryEmbedding });
  assert.equal(found.rows[0].existing.id, 'target');
  assert.equal(found.rows[0].retrievalEvidence.denseRank, 1);
  assert.equal(found.rows.length, 32);
  assert.equal(found.complete, false);
  const reviewed = await reviewDuplicates(candidate, index, { queryEmbedding });
  assert.equal(reviewed.reviews[0].verdict, 'uncertain');
  assert.equal(reviewed.duplicate, false);
  assert.equal(reviewed.automaticMerge, false);
  assert.equal(reviewed.requiresReview, true);
});

test('dense equality cannot bypass material constraints or publication evidence gates', async () => {
  const other = { ...candidate, id: 'other', constraints: { processing: 'cloud' } };
  const index = createSemanticCandidateIndex([other], { encoderId, rows: [packet(other)] });
  const result = await reviewDuplicates(candidate, index, { queryEmbedding: packet(candidate) });
  assert.equal(result.reviews[0].verdict, 'different');
  assert.equal(result.reviews[0].reason, 'CONSTRAINT_CONFLICT');
  assert.equal(result.duplicate, false);
  const publication = await decidePublicationWithReview({ draft: candidate, observations: [] }, index, { queryEmbedding: packet(candidate) });
  assert.equal(publication.decision, 'HOLD');
});

test('exact identity has priority even when its dense rank is deliberately poor', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ ...candidate, id: `other-${index}`, jobToBeDone: 'Different task' }));
  const target = { ...candidate, id: 'target', title: 'New title' };
  rows.push(target);
  const index = createSemanticCandidateIndex(rows, { encoderId, rows: rows.map(draft => packet(draft, draft.id === 'target' ? 1 : 0)) });
  assert.equal(retrieveSemanticCandidates(candidate, index, { queryEmbedding: packet(candidate) }).rows[0].existing.id, 'target');
});

test('snapshots bind every embedding to source content, model and dimensions', () => {
  const drafts = [candidate, { ...candidate, id: 'b', persona: 'Auditors' }], good = bundle(drafts);
  assert.throws(() => createSemanticCandidateIndex(drafts, { ...good, encoderId: 'wrong' }), /COMPLETE_EMBEDDING/u);
  assert.throws(() => createSemanticCandidateIndex(drafts, { ...good, rows: [...good.rows].reverse() }), /STALE_OR_INCOMPATIBLE/u);
  assert.throws(() => createSemanticCandidateIndex([{ ...candidate, jobToBeDone: 'Changed' }, drafts[1]], good), /STALE_OR_INCOMPATIBLE/u);
  for (const vector of [[], Array(384).fill(0), Array(384).fill(Infinity), Array(384).fill('1')]) {
    assert.throws(() => createSemanticCandidateIndex([candidate], { encoderId, rows: [{ ...packet(candidate), vector }] }), /INVALID_EMBEDDING/u);
  }
  const index = createSemanticCandidateIndex(drafts, good);
  assert.throws(() => retrieveSemanticCandidates(candidate, index, { queryEmbedding: packet({ ...candidate, persona: 'Changed' }) }), /STALE_OR_INCOMPATIBLE/u);
  assert.throws(() => retrieveSemanticCandidates(candidate, index, { queryEmbedding: packet(candidate), limit: 100 }), /INVALID_RETRIEVAL/u);
  assert.throws(() => createSemanticCandidateIndex([candidate, candidate], good), /UNIQUE_INDEX_IDS/u);
});

test('source and vector mutation cannot change a built index; equal ranks use stable IDs', () => {
  const drafts = Array.from({ length: 70 }, (_, index) => ({ ...candidate, id: `item-${String(index).padStart(2, '0')}`, jobToBeDone: 'Another task' }));
  const good = { encoderId, rows: drafts.map(draft => packet(draft)) };
  const index = createSemanticCandidateIndex(drafts, good), queryEmbedding = packet(candidate);
  const initial = retrieveSemanticCandidates(candidate, index, { queryEmbedding });
  good.rows[0].vector[0] = 0;
  drafts[0].jobToBeDone = 'Mutated';
  assert.deepEqual(retrieveSemanticCandidates(candidate, index, { queryEmbedding }), initial);
  const originals = initial.rows.map(row => row.existing); // Already snapshotted, not mutated drafts.
  const reverse = createSemanticCandidateIndex([...originals].reverse(), { encoderId, rows: [...originals].reverse().map(draft => packet(draft)) });
  assert.equal(retrieveSemanticCandidates(candidate, reverse, { queryEmbedding }).rows[0].existing.id, 'item-00');
});

test('embedding inputs exclude raw evidence and executable configuration', () => {
  const source = { ...candidate, observations: [{ text: 'private-source-marker' }], apiKey: 'secret-marker', command: 'not-executable' };
  assert.equal(embeddingInput(source).text, embeddingInput(candidate).text);
  assert.equal(embeddingInput({ ...candidate, title: 'Retitled', constraints: { processing: 'cloud' } }).inputDigest, embeddingInput(candidate).inputDigest);
  assert.throws(() => embeddingInput({ ...candidate, persona: {} }), /EMBEDDING_IDENTITY/u);
  assert.throws(() => embeddingInput({ ...candidate, jobToBeDone: 'x'.repeat(17000) }), /EMBEDDING_TEXT_LIMIT/u);
  assert.throws(() => createLocalEncoder(), /EXPLICIT_LOCAL_ENCODER/u);
  assert.throws(() => createLocalEncoder({ allowExecution: true, pythonExecutable: 'from-draft', modelDirectory: 'from-draft' }), /EXPLICIT_LOCAL_ENCODER/u);
  assert.throws(() => { encoderSpec.files['tokenizer.json'].sha256 = 'wrong'; }, TypeError);
});
