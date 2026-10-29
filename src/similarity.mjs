import { createHash } from 'node:crypto';

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'with']);
const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
const normalize = (value = '') => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() : '';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const indexes = new WeakMap();
const overlap = (a, b) => a.size && b.size ? [...a].filter(token => b.has(token)).length / new Set([...a, ...b]).size : 0;

export function tokenize(value = '') {
  const normalized = normalize(value);
  const words = [...segmenter.segment(normalized)]
    .filter((part) => part.isWordLike).map((part) => part.segment)
    .filter((part) => !STOP_WORDS.has(part));
  // Han bigrams tolerate segmentation differences without discarding Chinese.
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    for (let index = 0; index < chars.length - 1; index++) words.push(chars.slice(index, index + 2).join(''));
  }
  return [...new Set(words)];
}

export function jaccard(left, right) {
  return overlap(new Set(tokenize(left)), new Set(tokenize(right)));
}

export function compareConstraints(left, right) {
  const a = left.constraints === undefined ? {} : left.constraints, b = right.constraints === undefined ? {} : right.constraints;
  if (!isRecord(a) || !isRecord(b)) {
    return { conflicts: [], missing: ['INVALID_CONSTRAINTS'], compatible: false };
  }
  const conflicts = [], missing = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key) || a[key] == null || b[key] == null) missing.push(key);
    else if (![a[key], b[key]].every(value => (typeof value === 'string' && normalize(value))
      || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))) missing.push(key);
    else if (normalize(String(a[key])) !== normalize(String(b[key]))) conflicts.push(key);
  }
  return { conflicts: conflicts.sort(), missing: missing.sort(), compatible: !conflicts.length && !missing.length };
}

function identityProblems(draft) {
  const invalidIdentityFields = ['persona', 'jobToBeDone'].filter(field => !normalize(draft[field]));
  if (draft.desiredOutcome != null && typeof draft.desiredOutcome !== 'string') invalidIdentityFields.push('desiredOutcome');
  return invalidIdentityFields;
}

function prepare(draft) {
  if (!isRecord(draft)) throw new TypeError('INVALID_OPPORTUNITY');
  return { draft, invalidIdentityFields: identityProblems(draft),
    title: new Set(tokenize(draft.title)), job: new Set(tokenize(draft.jobToBeDone)), persona: new Set(tokenize(draft.persona)),
    evidence: new Set(Array.isArray(draft.evidenceKeys) ? draft.evidenceKeys.filter(key => typeof key === 'string') : []),
    normalizedJob: normalize(draft.jobToBeDone), normalizedPersona: normalize(draft.persona), outcome: normalize(draft.desiredOutcome) };
}

function comparePrepared(left, right) {
  const components = {
    title: overlap(left.title, right.title), job: overlap(left.job, right.job),
    persona: overlap(left.persona, right.persona), evidence: overlap(left.evidence, right.evidence),
  };
  const constraints = compareConstraints(left.draft, right.draft);
  const invalidIdentityFields = [...new Set([...left.invalidIdentityFields, ...right.invalidIdentityFields])];
  // Opportunity identity is independent of corroboration. Evidence has no score weight.
  const score = components.title * 0.25 + components.job * 0.60 + components.persona * 0.15;
  const exactTask = Boolean(left.normalizedJob) && left.normalizedJob === right.normalizedJob;
  const exactPersona = Boolean(left.normalizedPersona) && left.normalizedPersona === right.normalizedPersona;
  // Similar words can hide negation, different objects or operating constraints.
  // Only an exact task/persona with compatible explicit constraints auto-suppresses.
  const exactOutcome = left.outcome === right.outcome;
  const autoDuplicate = !invalidIdentityFields.length && exactTask && exactPersona && exactOutcome && constraints.compatible;
  return { score: Number(score.toFixed(4)), components, constraints, invalidIdentityFields, autoDuplicate,
    reasons: constraints.conflicts.length ? ['CONSTRAINT_CONFLICT']
      : autoDuplicate ? ['SAME_TASK_AND_PERSONA', 'EVIDENCE_SCORED_SEPARATELY'] : ['SEMANTIC_REVIEW_REQUIRED'] };
}

export function opportunitySimilarity(candidate, existing) { return comparePrepared(prepare(candidate), prepare(existing)); }

function rank(candidate, existing) {
  const left = prepare(candidate);
  const prepared = indexes.get(existing) ?? (Array.isArray(existing) ? existing.map(prepare) : null);
  if (!prepared) throw new TypeError('OPPORTUNITY_LIST_OR_INDEX_REQUIRED');
  return prepared.map((right, index) => ({ existing: right.draft, index, ...comparePrepared(left, right) }))
    .sort((a, b) => b.score - a.score || (typeof a.existing.id === 'string' && typeof b.existing.id === 'string'
      ? (a.existing.id < b.existing.id ? -1 : a.existing.id > b.existing.id ? 1 : 0) : 0) || a.index - b.index);
}

// An explicit immutable snapshot, not a persistent database or a hidden global
// cache. Rebuild when the source changes; only public retrieval fields are held.
export function createCandidateIndex(existing) {
  if (!Array.isArray(existing) || existing.length > 10000) throw new TypeError('INDEX_SIZE_LIMIT');
  const ids = new Set();
  const snapshots = existing.map(draft => {
    if (!isRecord(draft) || typeof draft.id !== 'string' || !draft.id.trim() || draft.id.length > 200 || ids.has(draft.id)) {
      throw new TypeError('UNIQUE_INDEX_IDS_REQUIRED');
    }
    ids.add(draft.id);
    const snapshot = Object.fromEntries(['id', 'title', 'persona', 'jobToBeDone', 'desiredOutcome', 'constraints', 'evidenceKeys']
      .filter(field => Object.hasOwn(draft, field)).map(field => [field, structuredClone(draft[field])]));
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 30000 || identityProblems(snapshot).length
      || (snapshot.title != null && typeof snapshot.title !== 'string') || compareConstraints(snapshot, snapshot).missing.length
      || (snapshot.evidenceKeys !== undefined && (!Array.isArray(snapshot.evidenceKeys) || snapshot.evidenceKeys.some(key => typeof key !== 'string')))) {
      throw new TypeError('INVALID_INDEX_RECORD');
    }
    if (isRecord(snapshot.constraints)) Object.freeze(snapshot.constraints);
    if (Array.isArray(snapshot.evidenceKeys)) Object.freeze(snapshot.evidenceKeys);
    return Object.freeze(snapshot);
  });
  const index = Object.freeze({ kind: 'NEEDRADAR_CANDIDATE_INDEX_V1', size: snapshots.length,
    snapshotDigest: createHash('sha256').update(JSON.stringify(snapshots)).digest('hex') });
  indexes.set(index, snapshots.map(prepare));
  return index;
}

export function findLikelyDuplicate(candidate, existingOpportunities, threshold = 0.78) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new TypeError('INVALID_THRESHOLD');
  const ranked = rank(candidate, existingOpportunities).map(row => ({ ...row, aboveLexicalThreshold: row.score >= threshold }));
  // Exact identity is stronger than a title-weighted lexical threshold. The
  // threshold remains a shortlist diagnostic, never evidence of distinctness.
  const match = ranked.find(row => row.autoDuplicate);
  return { duplicate: Boolean(match), threshold, best: match ?? ranked[0] ?? null, ranked,
    requiresReview: !match && ranked.some((row) => !row.constraints.conflicts.length) };
}

export function retrieveCandidates(candidate, existing, { limit = 32, exhaustiveLimit = 64 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64 || !Number.isInteger(exhaustiveLimit)
      || exhaustiveLimit < 1 || exhaustiveLimit > 64) throw new TypeError('INVALID_RETRIEVAL_LIMIT');
  const ranked = findLikelyDuplicate(candidate, existing).ranked;
  const total = ranked.length;
  const exhaustive = total <= exhaustiveLimit;
  // A title-weighted shortlist must not hide an already established exact
  // identity. Semantic-only duplicates can still fall outside the shortlist.
  const rows = exhaustive ? ranked : [...ranked.filter(row => row.autoDuplicate), ...ranked.filter(row => !row.autoDuplicate)].slice(0, limit);
  return { strategy: exhaustive ? 'BOUNDED_EXHAUSTIVE' : 'UNICODE_LEXICAL', rows,
    total, complete: rows.length === total, snapshotDigest: indexes.has(existing) ? existing.snapshotDigest : null };
}
