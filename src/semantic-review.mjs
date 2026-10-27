import { createHash } from 'node:crypto';
import { retrieveCandidates } from './similarity.mjs';

export const REVIEW_VERSION = 'OPPORTUNITY_PAIR_REVIEW_V1';
const fields = ['title', 'persona', 'jobToBeDone', 'desiredOutcome', 'constraints'];
const publicDraft = (draft) => Object.fromEntries(fields.map((key) => [key, draft[key] ?? (key === 'constraints' ? {} : '')]));
export const pairDigest = (left, right) => createHash('sha256').update(JSON.stringify([publicDraft(left), publicDraft(right)])).digest('hex');

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
    const human = humanDecisions.filter((event) => event.digest === common.pairDigest
      && ['same', 'different', 'uncertain'].includes(event.decision)
      && typeof event.actor === 'string' && event.actor.trim()
      && typeof event.reason === 'string' && event.reason.trim()
      && Number.isFinite(Date.parse(event.recordedAt)))
      .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
    if (human) reviews.push({ ...common, verdict: human.decision, reason: human.reason, method: 'HUMAN_DECISION', reviewId: human.id });
    else if (row.constraints.conflicts.length) reviews.push({ ...common, verdict: 'different', reason: 'CONSTRAINT_CONFLICT', method: 'EXPLICIT_CONSTRAINTS' });
    else if (row.autoDuplicate) reviews.push({ ...common, verdict: 'same', reason: 'SAME_TASK_AND_CONSTRAINTS', method: 'EXACT_TASK' });
    else if (!reviewer || modelCalls >= maxModelCalls) reviews.push({ ...common, verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION', method: 'HUMAN_REVIEW_REQUIRED' });
    else {
      modelCalls++;
      try {
        const response = await reviewer({ protocol: REVIEW_VERSION, left: publicDraft(candidate), right: publicDraft(row.existing), schema: reviewSchema });
        const result = validateReview(response.decision, candidate, row.existing);
        const decision = row.constraints.missing.length && result.verdict === 'same'
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
