import { createHash } from 'node:crypto';
import { retrieveCandidates } from './similarity.mjs';
import { timestamp } from './timestamps.mjs';

export const REVIEW_VERSION = 'OPPORTUNITY_PAIR_REVIEW_V1';
const fields = ['title', 'persona', 'jobToBeDone', 'desiredOutcome', 'constraints'];
const publicDraft = (draft) => Object.fromEntries(fields.map((key) => [key, draft[key] ?? (key === 'constraints' ? {} : '')]));
export const pairDigest = (left, right) => createHash('sha256').update(JSON.stringify([publicDraft(left), publicDraft(right)])).digest('hex');

// Existing V1 digests stay valid. A same/different relationship is symmetric;
// matching either exact orientation does not approve changed source content.
export function resolveHumanDecision(left, right, events = []) {
  if (!Array.isArray(events) || events.length > 20000) throw new TypeError('HUMAN_REVIEW_JOURNAL_LIMIT');
  const digests = new Set([pairDigest(left, right), pairDigest(right, left)]);
  const current = events.filter(event => event && typeof event === 'object' && digests.has(event.digest)
    && ['same', 'different', 'uncertain'].includes(event.decision)
    && typeof event.actor === 'string' && event.actor.trim()
    && typeof event.reason === 'string' && event.reason.trim()
    && (() => { try { timestamp(event.recordedAt); return true; } catch { return false; } })());
  if (!current.length) return null;
  const latestTime = current.reduce((latest, event) => Math.max(latest, Date.parse(event.recordedAt)), -Infinity);
  const latest = current.filter(event => Date.parse(event.recordedAt) === latestTime);
  const decisions = new Set(latest.map(event => event.decision));
  const reviewIds = [...new Set(latest.map(event => event.id).filter(id => typeof id === 'string'))].sort();
  if (decisions.size !== 1) return { decision: 'uncertain', reason: 'CONFLICTING_HUMAN_DECISIONS', method: 'HUMAN_DECISION_CONFLICT', reviewIds };
  const representative = [...latest].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)[0];
  return { decision: representative.decision, reason: representative.reason, method: 'HUMAN_DECISION', reviewId: representative.id, reviewIds };
}

export const reviewSchema = {
  type: 'object', additionalProperties: false, required: ['verdict', 'reason', 'leftQuote', 'rightQuote'],
  properties: {
    verdict: { type: 'string', enum: ['same', 'different', 'uncertain'] },
    reason: { type: 'string', enum: ['SAME_TASK_AND_CONSTRAINTS', 'DIFFERENT_TASK', 'DIFFERENT_PERSONA', 'CONSTRAINT_CONFLICT', 'INSUFFICIENT_INFORMATION'] },
    leftQuote: { type: 'string' }, rightQuote: { type: 'string' },
  },
};

export function validateReview(value, left, right) {
  if (!value || Object.keys(value).sort().join(',') !== 'leftQuote,reason,rightQuote,verdict'
      || !reviewSchema.properties.verdict.enum.includes(value.verdict)
      || !reviewSchema.properties.reason.enum.includes(value.reason)) throw new Error('INVALID_SEMANTIC_REVIEW');
  for (const [quote, draft] of [[value.leftQuote, left], [value.rightQuote, right]]) {
    if (typeof quote !== 'string' || quote.length < 4 || quote.length > 800
        || !fields.some((field) => typeof draft[field] === 'string' && draft[field].includes(quote))) {
      throw new Error('UNGROUNDED_SEMANTIC_REVIEW');
    }
  }
  if ((value.verdict === 'same') !== (value.reason === 'SAME_TASK_AND_CONSTRAINTS')
      || (value.verdict === 'uncertain') !== (value.reason === 'INSUFFICIENT_INFORMATION')) throw new Error('CONTRADICTORY_SEMANTIC_REVIEW');
  return value;
}

export async function reviewDuplicates(candidate, existing, { reviewer, humanDecisions = [], maxModelCalls = 8, ...retrievalOptions } = {}) {
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > 64) throw new TypeError('INVALID_REVIEW_BUDGET');
  const retrieval = retrieveCandidates(candidate, existing, retrievalOptions);
  const reviews = [];
  let modelCalls = 0;
  for (const row of retrieval.rows) {
    const common = { index: row.index, pairDigest: pairDigest(candidate, row.existing), lexicalScore: row.score };
    // Caller-owned review records must come from authenticated human actions, never model output.
    const human = resolveHumanDecision(candidate, row.existing, humanDecisions);
    if (human?.decision === 'same' && (row.constraints.conflicts.length || row.constraints.missing.length || row.invalidIdentityFields.length)) {
      reviews.push({ ...common, verdict: row.constraints.conflicts.length ? 'different' : 'uncertain',
        reason: row.constraints.conflicts.length ? 'CONSTRAINT_CONFLICT' : 'INSUFFICIENT_INFORMATION',
        method: 'HUMAN_DECISION_BLOCKED', reviewId: human.reviewId, reviewIds: human.reviewIds, originalHumanReason: human.reason });
    } else if (human) reviews.push({ ...common, verdict: human.decision, reason: human.reason, method: human.method, reviewId: human.reviewId, reviewIds: human.reviewIds });
    else if (row.constraints.conflicts.length) reviews.push({ ...common, verdict: 'different', reason: 'CONSTRAINT_CONFLICT', method: 'EXPLICIT_CONSTRAINTS' });
    else if (row.autoDuplicate) reviews.push({ ...common, verdict: 'same', reason: 'SAME_TASK_AND_CONSTRAINTS', method: 'EXACT_TASK' });
    else if (!reviewer || modelCalls >= maxModelCalls) reviews.push({ ...common, verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION', method: 'HUMAN_REVIEW_REQUIRED' });
    else {
      modelCalls++;
      try {
        const response = await reviewer({ protocol: REVIEW_VERSION, left: publicDraft(candidate), right: publicDraft(row.existing), schema: reviewSchema });
        const result = validateReview(response.decision, candidate, row.existing);
        const decision = (row.constraints.missing.length || row.invalidIdentityFields.length) && result.verdict === 'same'
          ? { ...result, verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION' } : result;
        reviews.push({ ...common, ...decision, method: 'MODEL_PROPOSAL', model: response.model ?? null,
          elapsedMs: response.elapsedMs ?? null, usage: response.usage ?? null, costUsd: response.costUsd ?? null });
      } catch {
        reviews.push({ ...common, verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION', method: 'REVIEW_FAILED' });
      }
    }
  }
  return { protocol: REVIEW_VERSION, reviews, modelCalls, retrievalComplete: retrieval.complete,
    duplicate: reviews.some((item) => item.verdict === 'same'),
    requiresReview: !retrieval.complete || reviews.some((item) => item.verdict === 'uncertain'),
    automaticMerge: false };
}
