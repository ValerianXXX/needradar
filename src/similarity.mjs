const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'it', 'of', 'on', 'or', 'that', 'the', 'their', 'this', 'to', 'with',
]);

export function tokenize(value = '') {
  return String(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function jaccard(left, right) {
  const a = new Set(tokenize(left));
  const b = new Set(tokenize(right));
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

function evidenceKeySet(candidate) {
  return new Set((candidate.evidenceKeys ?? []).map((value) => String(value).trim()).filter(Boolean));
}

function setOverlap(left, right) {
  const a = evidenceKeySet(left);
  const b = evidenceKeySet(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / new Set([...a, ...b]).size;
}

export function opportunitySimilarity(candidate, existing) {
  const components = {
    title: jaccard(candidate.title, existing.title),
    job: jaccard(candidate.jobToBeDone, existing.jobToBeDone),
    persona: jaccard(candidate.persona, existing.persona),
    evidence: setOverlap(candidate, existing),
  };
  const score =
    components.title * 0.20 +
    components.job * 0.45 +
    components.persona * 0.10 +
    components.evidence * 0.25;
  return { score: Number(score.toFixed(4)), components };
}

export function findLikelyDuplicate(candidate, existingOpportunities, threshold = 0.78) {
  const ranked = existingOpportunities
    .map((existing) => ({ existing, ...opportunitySimilarity(candidate, existing) }))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0] ?? null;
  return {
    duplicate: Boolean(best && best.score >= threshold),
    threshold,
    best,
    ranked,
  };
}

