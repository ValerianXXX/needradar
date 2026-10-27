const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'with']);
const segmenter = new Intl.Segmenter('und', { granularity: 'word' });
const normalize = (value = '') => String(value).normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

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
  const a = new Set(tokenize(left)), b = new Set(tokenize(right));
  if (!a.size || !b.size) return 0;
  return [...a].filter((token) => b.has(token)).length / new Set([...a, ...b]).size;
}

function evidenceOverlap(left, right) {
  const a = new Set(left.evidenceKeys ?? []), b = new Set(right.evidenceKeys ?? []);
  if (!a.size || !b.size) return 0;
  return [...a].filter((key) => b.has(key)).length / new Set([...a, ...b]).size;
}

export function compareConstraints(left, right) {
  const a = left.constraints ?? {}, b = right.constraints ?? {};
  if (!a || !b || Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object') {
    return { conflicts: [], missing: ['INVALID_CONSTRAINTS'], compatible: false };
  }
  const conflicts = [], missing = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key) || a[key] == null || b[key] == null) missing.push(key);
    else if (typeof a[key] === 'object' || typeof b[key] === 'object') missing.push(key);
    else if (normalize(a[key]) !== normalize(b[key])) conflicts.push(key);
  }
  return { conflicts: conflicts.sort(), missing: missing.sort(), compatible: !conflicts.length && !missing.length };
}

export function opportunitySimilarity(candidate, existing) {
  const components = {
    title: jaccard(candidate.title, existing.title),
    job: jaccard(candidate.jobToBeDone, existing.jobToBeDone),
    persona: jaccard(candidate.persona, existing.persona),
    evidence: evidenceOverlap(candidate, existing),
  };
  const constraints = compareConstraints(candidate, existing);
  // Opportunity identity is independent of corroboration. Evidence has no score weight.
  const score = components.title * 0.25 + components.job * 0.60 + components.persona * 0.15;
  const exactTask = Boolean(normalize(candidate.jobToBeDone))
    && normalize(candidate.jobToBeDone) === normalize(existing.jobToBeDone);
  const exactPersona = Boolean(normalize(candidate.persona))
    && normalize(candidate.persona) === normalize(existing.persona);
  // Similar words can hide negation, different objects or operating constraints.
  // Only an exact task/persona with compatible explicit constraints auto-suppresses.
  const exactOutcome = normalize(candidate.desiredOutcome) === normalize(existing.desiredOutcome);
  const autoDuplicate = exactTask && exactPersona && exactOutcome && constraints.compatible;
  return { score: Number(score.toFixed(4)), components, constraints, autoDuplicate,
    reasons: constraints.conflicts.length ? ['CONSTRAINT_CONFLICT']
      : autoDuplicate ? ['SAME_TASK_AND_PERSONA', 'EVIDENCE_SCORED_SEPARATELY'] : ['SEMANTIC_REVIEW_REQUIRED'] };
}

export function findLikelyDuplicate(candidate, existingOpportunities, threshold = 0.78) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new TypeError('INVALID_THRESHOLD');
  const ranked = existingOpportunities.map((existing, index) => ({ existing, index, ...opportunitySimilarity(candidate, existing) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const match = ranked.find((row) => row.autoDuplicate && row.score >= threshold);
  return { duplicate: Boolean(match), threshold, best: match ?? ranked[0] ?? null, ranked,
    requiresReview: !match && ranked.some((row) => !row.constraints.conflicts.length) };
}

export function retrieveCandidates(candidate, existing, { limit = 32, exhaustiveLimit = 64 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64 || !Number.isInteger(exhaustiveLimit)
      || exhaustiveLimit < 1 || exhaustiveLimit > 64) throw new TypeError('INVALID_RETRIEVAL_LIMIT');
  const ranked = findLikelyDuplicate(candidate, existing).ranked;
  const exhaustive = existing.length <= exhaustiveLimit;
  const rows = exhaustive ? ranked : ranked.slice(0, limit);
  return { strategy: exhaustive ? 'BOUNDED_EXHAUSTIVE' : 'UNICODE_LEXICAL', rows,
    total: existing.length, complete: rows.length === existing.length };
}
