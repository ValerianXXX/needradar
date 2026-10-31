import { retrieveCandidates } from './similarity.mjs';
import { timestamp } from './timestamps.mjs';
import { isSemanticCandidateIndex, retrieveSemanticCandidates } from './semantic-retrieval.mjs';
import { REVIEW_VERSION, publicDraft, pairDigest, reviewSchema, validateReview } from './review-contract.mjs';
import { createReviewContinuation, journalResponse, MAX_PAIR_ATTEMPTS } from './review-journal.mjs';
import { captureInput } from './input-snapshot.mjs';
export { REVIEW_VERSION, pairDigest, reviewSchema, validateReview } from './review-contract.mjs';

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

export async function reviewDuplicates(candidate, existing, { reviewer, humanDecisions = [], maxModelCalls = 8,
  reviewerRevision, reviewJournal, onCheckpoint, retryFailedPairs, signal, isInputCurrent, ...retrievalOptions } = {}) {
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > 64) throw new TypeError('INVALID_REVIEW_BUDGET');
  if (reviewerRevision === undefined && [reviewJournal, onCheckpoint, retryFailedPairs].some(value => value !== undefined)) throw new TypeError('REVIEW_JOURNAL_REVISION_REQUIRED');
  const submittedCandidate = candidate, submittedExisting = existing, submittedHumanDecisions = humanDecisions;
  const input = captureInput(() => ({ candidate: submittedCandidate,
    existing: Array.isArray(submittedExisting) ? submittedExisting : null, humanDecisions: submittedHumanDecisions }), isInputCurrent);
  candidate = input.snapshot.candidate;
  existing = input.snapshot.existing ?? existing;
  humanDecisions = input.snapshot.humanDecisions;
  const continuation = reviewerRevision === undefined ? null : createReviewContinuation({ reviewerRevision, reviewJournal, onCheckpoint, retryFailedPairs });
  const retrieval = isSemanticCandidateIndex(existing)
    ? retrieveSemanticCandidates(candidate, existing, retrievalOptions) : retrieveCandidates(candidate, existing, retrievalOptions);
  // Validate every applicable saved proposal before starting any new provider call.
  for (const row of retrieval.rows) {
    const cached = continuation?.latest(pairDigest(candidate, row.existing));
    if (cached?.type === 'RESULT') validateReview(cached.response.decision, candidate, row.existing);
  }
  const reviews = [];
  let modelCalls = 0, invalidated = input.changed();
  for (const row of retrieval.rows) {
    const common = { index: row.index, pairDigest: pairDigest(candidate, row.existing), lexicalScore: row.score,
      ...(row.retrievalEvidence ? { retrievalEvidence: row.retrievalEvidence } : {}) };
    const unresolved = method => reviews.push({ ...common, verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION', method });
    if (invalidated) { unresolved('REVIEW_INPUT_CHANGED'); continue; }
    // Caller-owned review records must come from authenticated human actions, never model output.
    const human = resolveHumanDecision(candidate, row.existing, humanDecisions);
    if (human?.decision === 'same' && (row.constraints.conflicts.length || row.constraints.missing.length || row.invalidIdentityFields.length)) {
      reviews.push({ ...common, verdict: row.constraints.conflicts.length ? 'different' : 'uncertain',
        reason: row.constraints.conflicts.length ? 'CONSTRAINT_CONFLICT' : 'INSUFFICIENT_INFORMATION',
        method: 'HUMAN_DECISION_BLOCKED', reviewId: human.reviewId, reviewIds: human.reviewIds, originalHumanReason: human.reason });
    } else if (human) reviews.push({ ...common, verdict: human.decision, reason: human.reason, method: human.method, reviewId: human.reviewId, reviewIds: human.reviewIds });
    else if (row.constraints.conflicts.length) reviews.push({ ...common, verdict: 'different', reason: 'CONSTRAINT_CONFLICT', method: 'EXPLICIT_CONSTRAINTS' });
    else if (row.autoDuplicate) reviews.push({ ...common, verdict: 'same', reason: 'SAME_TASK_AND_CONSTRAINTS', method: 'EXACT_TASK' });
    else {
      const previous = continuation?.latest(common.pairDigest);
      const constrained = result => (row.constraints.missing.length || row.invalidIdentityFields.length) && result.verdict === 'same'
        ? { ...result, verdict: 'uncertain', reason: 'INSUFFICIENT_INFORMATION' } : result;
      if (previous?.type === 'RESULT') {
        const { decision, ...observation } = previous.response;
        reviews.push({ ...common, ...constrained(decision), ...observation, method: 'MODEL_PROPOSAL_REUSED', originalAttemptId: previous.attemptId });
        continue;
      }
      if (previous && !continuation.retryRequested(common.pairDigest)) {
        unresolved(previous.type === 'FAILED' ? 'REVIEW_FAILED' : 'REVIEW_INTERRUPTED');
        continue;
      }
      if (continuation && continuation.attempts(common.pairDigest) >= MAX_PAIR_ATTEMPTS) { unresolved('REVIEW_RETRY_LIMIT'); continue; }
      if (signal?.aborted) { unresolved('REVIEW_CANCELLED'); continue; }
      if (!reviewer || modelCalls >= maxModelCalls) { unresolved('HUMAN_REVIEW_REQUIRED'); continue; }
      const started = continuation ? await continuation.start(common.pairDigest) : null;
      if (continuation) invalidated = input.changed();
      if (invalidated || signal?.aborted) {
        if (continuation) await continuation.finish(started, null);
        invalidated = input.changed();
        unresolved(invalidated ? 'REVIEW_INPUT_CHANGED' : 'REVIEW_CANCELLED');
        continue;
      }
      modelCalls++;
      let response = null, result;
      try {
        response = await reviewer(structuredClone({ protocol: REVIEW_VERSION, left: publicDraft(candidate),
          right: publicDraft(row.existing), schema: reviewSchema }), { signal });
        validateReview(response.decision, candidate, row.existing);
        response = journalResponse(response);
        result = response.decision;
      } catch {
        response = null;
      }
      invalidated = input.changed();
      // Persistence errors propagate; they must never look like a completed review.
      if (continuation) {
        await continuation.finish(started, response);
        invalidated = input.changed();
      }
      if (response) reviews.push({ ...common, ...constrained(result), method: 'MODEL_PROPOSAL', model: response.model ?? null,
        elapsedMs: response.elapsedMs ?? null, usage: response.usage ?? null, costUsd: response.costUsd ?? null });
      else unresolved('REVIEW_FAILED');
    }
  }
  const inputChanged = input.changed();
  return { protocol: REVIEW_VERSION, reviews, modelCalls, retrievalComplete: retrieval.complete, inputChanged,
    duplicate: !inputChanged && reviews.some((item) => item.verdict === 'same'),
    requiresReview: inputChanged || !retrieval.complete || reviews.some((item) => item.verdict === 'uncertain'),
    ...(continuation ? { reviewJournal: continuation.snapshot(), reviewProgress: {
      retrievedPairs: reviews.length, cachedProposals: reviews.filter(row => row.method === 'MODEL_PROPOSAL_REUSED').length,
      pendingPairs: reviews.filter(row => row.method === 'HUMAN_REVIEW_REQUIRED').length,
      failedPairs: reviews.filter(row => ['REVIEW_FAILED', 'REVIEW_RETRY_LIMIT'].includes(row.method)).length,
      interruptedPairs: reviews.filter(row => row.method === 'REVIEW_INTERRUPTED').length,
      cancelledPairs: reviews.filter(row => row.method === 'REVIEW_CANCELLED').length,
      invalidatedPairs: reviews.filter(row => row.method === 'REVIEW_INPUT_CHANGED').length,
      uncertainPairs: reviews.filter(row => row.verdict === 'uncertain').length,
    } } : {}),
    automaticMerge: false };
}
