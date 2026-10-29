import { createHash } from 'node:crypto';
import { createCandidateIndex, findLikelyDuplicate } from './similarity.mjs';
import { encoderId, encoderSpec, verifyEmbedding } from './embedding-contract.mjs';

const indexes = new WeakMap();
export const isSemanticCandidateIndex = value => indexes.has(value);
export const lexicalCandidateIndex = value => indexes.get(value)?.lexical ?? value;

export function createSemanticCandidateIndex(drafts, packet) {
  const lexical = createCandidateIndex(drafts);
  if (!packet || packet.encoderId !== encoderId || !Array.isArray(packet.rows) || packet.rows.length !== drafts.length) throw new TypeError('COMPLETE_EMBEDDING_SNAPSHOT_REQUIRED');
  const vectors = drafts.map((draft, index) => verifyEmbedding(draft, packet.rows[index]));
  const hash = createHash('sha256').update(lexical.snapshotDigest).update(encoderId);
  vectors.forEach(vector => hash.update(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)));
  const index = Object.freeze({ kind: 'NEEDRADAR_SEMANTIC_CANDIDATE_INDEX_V1', size: drafts.length,
    dimensions: encoderSpec.dimensions, encoderId, snapshotDigest: hash.digest('hex') });
  indexes.set(index, { lexical, vectors });
  return index;
}

export function retrieveSemanticCandidates(candidate, index, { queryEmbedding, limit = 32, exhaustiveLimit = 64 } = {}) {
  const state = indexes.get(index);
  if (!state) throw new TypeError('SEMANTIC_INDEX_REQUIRED');
  if (!Number.isInteger(limit) || limit < 1 || limit > 64 || !Number.isInteger(exhaustiveLimit)
    || exhaustiveLimit < 1 || exhaustiveLimit > 64) throw new TypeError('INVALID_RETRIEVAL_LIMIT');
  const query = verifyEmbedding(candidate, queryEmbedding);
  const lexical = findLikelyDuplicate(candidate, state.lexical).ranked;
  const dense = lexical.map(row => {
    const vector = state.vectors[row.index];
    let similarity = 0;
    for (let axis = 0; axis < query.length; axis++) similarity += query[axis] * vector[axis];
    return { row, similarity: Math.max(-1, Math.min(1, similarity)) };
  }).sort((a, b) => b.similarity - a.similarity || (a.row.existing.id < b.row.existing.id ? -1 : a.row.existing.id > b.row.existing.id ? 1 : 0));
  const evidence = new Map(dense.map((item, rank) => [item.row.index, { denseRank: rank + 1, denseSimilarity: item.similarity }]));
  lexical.forEach((row, rank) => { evidence.get(row.index).lexicalRank = rank + 1; });
  const total = lexical.length, exhaustive = total <= exhaustiveLimit;
  const selected = [], seen = new Set();
  const add = row => { if (row && !seen.has(row.index) && selected.length < limit) { selected.push(row); seen.add(row.index); } };
  if (exhaustive) selected.push(...lexical);
  else {
    lexical.filter(row => row.autoDuplicate).forEach(add);
    for (let rank = 0; rank < total && selected.length < limit; rank++) { add(dense[rank].row); add(lexical[rank]); }
  }
  return { strategy: exhaustive ? 'BOUNDED_EXHAUSTIVE' : 'LOCAL_DENSE_LEXICAL_UNION',
    rows: selected.map(row => ({ ...row, retrievalEvidence: { ...evidence.get(row.index), encoderId } })),
    total, complete: selected.length === total, snapshotDigest: index.snapshotDigest,
    automaticMerge: false, scoreMeaning: 'Relative candidate rank only, not identity probability or evidence independence.' };
}
