import { createHash } from 'node:crypto';
import { pairDigest } from './review-contract.mjs';
import { timestamp } from './timestamps.mjs';

const SCOPE_PROTOCOL = 'OPPORTUNITY_RECORD_PAIR_V1';
const token = value => typeof value === 'string' && value.trim();

function recordId(draft) {
  if (!Object.hasOwn(draft, 'id')) return null;
  if (!token(draft.id) || draft.id.length > 200) throw new TypeError('HUMAN_REVIEW_RECORD_ID_REQUIRED');
  return draft.id;
}

// Scope identifies the reviewed records, while the existing content digest
// expires the decision on a task/constraint change. Neither is authentication.
export function recordPairDecision(left, right, { digest, decision, actor, reason, recordedAt } = {}) {
  const originals = structuredClone([left, right]);
  const ids = originals.map(recordId);
  if (digest !== pairDigest(...originals) || !['same', 'different', 'uncertain'].includes(decision)
      || !token(actor) || !token(reason)) throw new Error('CURRENT_HUMAN_REVIEW_REQUIRED');
  const event = { digest, decision, actor, reason, recordedAt: timestamp(recordedAt),
    recordScope: { protocol: SCOPE_PROTOCOL, ids } };
  return { ...event, id: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
    reversible: true, originals };
}

function scopeOf(event, left, right, directDigest, reverseDigest) {
  // Retain the documented legacy caller-built content-only API, but expose its
  // scope. A malformed/new scoped event must never downgrade to that behavior.
  if (!Object.hasOwn(event, 'originals') && !Object.hasOwn(event, 'recordScope')) return 'LEGACY_CONTENT_ONLY';
  try {
    if (!Array.isArray(event.originals) || event.originals.length !== 2
        || pairDigest(...event.originals) !== event.digest) return null;
    const ids = event.originals.map(recordId);
    if (Object.hasOwn(event, 'recordScope')) {
      const scope = event.recordScope;
      if (!scope || Object.keys(scope).sort().join(',') !== 'ids,protocol' || scope.protocol !== SCOPE_PROTOCOL
          || !Array.isArray(scope.ids) || scope.ids.length !== 2 || Object.keys(scope.ids).join(',') !== '0,1'
          || scope.ids.some((id, index) => id !== ids[index])) return null;
    }
    const leftId = recordId(left), rightId = recordId(right);
    return (event.digest === directDigest && ids[0] === leftId && ids[1] === rightId
      || event.digest === reverseDigest && ids[0] === rightId && ids[1] === leftId) ? 'RECORD_PAIR' : null;
  } catch { return null; }
}

// Legacy V1 snapshots gain record binding without rewriting their event bytes.
// Model suggestions deliberately use a different, reusable content-only cache.
export function resolveHumanDecision(left, right, events = []) {
  if (!Array.isArray(events) || events.length > 20000) throw new TypeError('HUMAN_REVIEW_JOURNAL_LIMIT');
  const directDigest = pairDigest(left, right), reverseDigest = pairDigest(right, left);
  const current = [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || ![directDigest, reverseDigest].includes(event.digest)
        || !['same', 'different', 'uncertain'].includes(event.decision) || !token(event.actor) || !token(event.reason)) continue;
    try { timestamp(event.recordedAt); } catch { continue; }
    const scope = scopeOf(event, left, right, directDigest, reverseDigest);
    if (scope) current.push({ event, scope });
  }
  if (!current.length) return null;
  const latestTime = current.reduce((latest, { event }) => Math.max(latest, Date.parse(event.recordedAt)), -Infinity);
  const latest = current.filter(({ event }) => Date.parse(event.recordedAt) === latestTime);
  const decisions = new Set(latest.map(({ event }) => event.decision));
  const reviewIds = [...new Set(latest.map(({ event }) => event.id).filter(id => typeof id === 'string'))].sort();
  const scopes = new Set(latest.map(row => row.scope));
  const humanScope = scopes.size === 1 ? latest[0].scope : 'MIXED_RECORD_AND_LEGACY';
  if (decisions.size !== 1) return { decision: 'uncertain', reason: 'CONFLICTING_HUMAN_DECISIONS',
    method: 'HUMAN_DECISION_CONFLICT', reviewIds, humanScope };
  const representative = [...latest].sort((a, b) => JSON.stringify(a.event) < JSON.stringify(b.event)
    ? -1 : JSON.stringify(a.event) > JSON.stringify(b.event) ? 1 : 0)[0].event;
  return { decision: representative.decision, reason: representative.reason, method: 'HUMAN_DECISION',
    reviewId: representative.id, reviewIds, humanScope };
}
