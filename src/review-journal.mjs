import { timestamp } from './timestamps.mjs';
import { REVIEW_VERSION, reviewSchema } from './review-contract.mjs';

export const MAX_JOURNAL_EVENTS = 512;
export const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
export const MAX_PAIR_ATTEMPTS = 3;
const digestPattern = /^[a-f0-9]{64}$/u;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exactKeys = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const usageKeys = ['input_tokens', 'output_tokens', 'total_tokens', 'cached_input_tokens'];

export function journalResponse(response) {
  const usage = record(response.usage) ? Object.fromEntries(usageKeys.filter(key => Number.isSafeInteger(response.usage[key]) && response.usage[key] >= 0)
    .map(key => [key, response.usage[key]])) : {};
  return { decision: structuredClone(response.decision),
    model: typeof response.model === 'string' && response.model.length <= 200 ? response.model : null,
    elapsedMs: numberOrNull(response.elapsedMs), costUsd: numberOrNull(response.costUsd),
    usage: Object.keys(usage).length ? usage : null };
}

function validResponse(value) {
  if (!exactKeys(value, ['decision', 'model', 'elapsedMs', 'costUsd', 'usage'])) return false;
  if (value.model !== null && (typeof value.model !== 'string' || value.model.length > 200)) return false;
  if (['elapsedMs', 'costUsd'].some(key => value[key] !== null && numberOrNull(value[key]) !== value[key])) return false;
  if (value.usage !== null && (!record(value.usage) || !Object.keys(value.usage).length
      || Object.entries(value.usage).some(([key, count]) => !usageKeys.includes(key) || !Number.isSafeInteger(count) || count < 0))) return false;
  const decision = value.decision;
  return exactKeys(decision, ['verdict', 'reason', 'leftQuote', 'rightQuote'])
    && reviewSchema.properties.verdict.enum.includes(decision.verdict)
    && reviewSchema.properties.reason.enum.includes(decision.reason)
    && [decision.leftQuote, decision.rightQuote].every(quote => typeof quote === 'string' && quote.length >= 4 && quote.length <= 800)
    && ((decision.verdict === 'same') === (decision.reason === 'SAME_TASK_AND_CONSTRAINTS'))
    && ((decision.verdict === 'uncertain') === (decision.reason === 'INSUFFICIENT_INFORMATION'));
}

export function validateReviewJournal(value, reviewerRevision) {
  if (typeof reviewerRevision !== 'string' || !reviewerRevision.trim() || reviewerRevision.length > 200) throw new TypeError('REVIEW_JOURNAL_REVISION_REQUIRED');
  if (!exactKeys(value, ['version', 'reviewProtocol', 'reviewerRevision', 'events'])
      || value.version !== 1 || value.reviewProtocol !== REVIEW_VERSION || !Array.isArray(value.events)
      || value.events.length > MAX_JOURNAL_EVENTS) throw new TypeError('INVALID_REVIEW_JOURNAL');
  if (value.reviewerRevision !== reviewerRevision) throw new TypeError('REVIEW_JOURNAL_REVISION_MISMATCH');
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_JOURNAL_BYTES) throw new TypeError('REVIEW_JOURNAL_SIZE_LIMIT');
  const attempts = new Map(), latest = new Map(), counts = new Map();
  let previousAt = -Infinity;
  for (const event of value.events) {
    const keys = ['type', 'attemptId', 'pairDigest', 'recordedAt', ...(event?.type === 'RESULT' ? ['response'] : [])];
    if (!exactKeys(event, keys) || !['STARTED', 'RESULT', 'FAILED'].includes(event.type)
        || !Number.isSafeInteger(event.attemptId) || event.attemptId < 1 || typeof event.pairDigest !== 'string'
        || !digestPattern.test(event.pairDigest)) throw new TypeError('INVALID_REVIEW_JOURNAL_EVENT');
    const at = Date.parse(timestamp(event.recordedAt));
    if (at < previousAt) throw new TypeError('REVIEW_JOURNAL_TIME_ORDER');
    previousAt = at;
    if (event.type === 'STARTED') {
      if (event.attemptId !== attempts.size + 1) throw new TypeError('REVIEW_JOURNAL_ATTEMPT_ORDER');
      const count = (counts.get(event.pairDigest) ?? 0) + 1;
      if (count > MAX_PAIR_ATTEMPTS) throw new TypeError('REVIEW_JOURNAL_RETRY_LIMIT');
      counts.set(event.pairDigest, count);
      attempts.set(event.attemptId, event);
    } else {
      const started = attempts.get(event.attemptId);
      if (!started || started.type !== 'STARTED' || started.pairDigest !== event.pairDigest
          || latest.get(event.pairDigest)?.attemptId !== event.attemptId
          || (event.type === 'RESULT' && !validResponse(event.response))) throw new TypeError('INVALID_REVIEW_JOURNAL_RESULT');
      attempts.set(event.attemptId, event);
    }
    latest.set(event.pairDigest, event);
  }
  return { latest, counts, attempts: attempts.size };
}

export function createReviewContinuation({ reviewerRevision, reviewJournal, onCheckpoint, retryFailedPairs = [] }) {
  if (onCheckpoint !== undefined && typeof onCheckpoint !== 'function') throw new TypeError('REVIEW_CHECKPOINT_FUNCTION_REQUIRED');
  if (!Array.isArray(retryFailedPairs) || retryFailedPairs.length > 64 || retryFailedPairs.some(digest => typeof digest !== 'string' || !digestPattern.test(digest))) {
    throw new TypeError('INVALID_REVIEW_RETRY_PAIRS');
  }
  const input = reviewJournal ?? { version: 1, reviewProtocol: REVIEW_VERSION, reviewerRevision, events: [] };
  validateReviewJournal(input, reviewerRevision);
  const journal = structuredClone(input);
  let state = validateReviewJournal(journal, reviewerRevision);
  const snapshot = () => structuredClone(journal);
  const append = async event => {
    journal.events.push(event);
    state = validateReviewJournal(journal, reviewerRevision);
    if (onCheckpoint) await onCheckpoint(snapshot());
  };
  return {
    snapshot,
    latest: digest => state.latest.get(digest),
    attempts: digest => state.counts.get(digest) ?? 0,
    retryRequested: digest => retryFailedPairs.includes(digest),
    async start(digest) {
      // Reserve room for the terminal event before a potentially billable call.
      if (journal.events.length + 2 > MAX_JOURNAL_EVENTS) throw new Error('REVIEW_JOURNAL_SIZE_LIMIT');
      const event = { type: 'STARTED', attemptId: state.attempts + 1, pairDigest: digest, recordedAt: new Date().toISOString() };
      await append(event);
      return event;
    },
    async finish(started, response) {
      await append({ type: response ? 'RESULT' : 'FAILED', attemptId: started.attemptId, pairDigest: started.pairDigest,
        recordedAt: new Date().toISOString(), ...(response ? { response: journalResponse(response) } : {}) });
    },
  };
}
