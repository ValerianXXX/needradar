import { createHash } from 'node:crypto';

export const REVIEW_VERSION = 'OPPORTUNITY_PAIR_REVIEW_V1';
const fields = ['title', 'persona', 'jobToBeDone', 'desiredOutcome', 'constraints'];
export const publicDraft = draft => Object.fromEntries(fields.map(key => [key, draft[key] ?? (key === 'constraints' ? {} : '')]));
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
        || !fields.some(field => typeof draft[field] === 'string' && draft[field].includes(quote))) {
      throw new Error('UNGROUNDED_SEMANTIC_REVIEW');
    }
  }
  if ((value.verdict === 'same') !== (value.reason === 'SAME_TASK_AND_CONSTRAINTS')
      || (value.verdict === 'uncertain') !== (value.reason === 'INSUFFICIENT_INFORMATION')) throw new Error('CONTRADICTORY_SEMANTIC_REVIEW');
  return value;
}
