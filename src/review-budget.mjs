import { pairDigest } from './review-contract.mjs';
import { timestamp } from './timestamps.mjs';
import { withLockedReviewFile } from './review-state-file.mjs';

const MAX_BYTES = 2 * 1024 * 1024, MAX_CALLS = 4096;
const DIGEST = /^[a-f0-9]{64}$/u;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const cost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function validate(value, policy) {
  if (!exact(value, ['version', 'kind', 'scopeDigest', 'reviewerRevision', 'maxModelCalls', 'events'])
      || value.version !== 1 || value.kind !== 'NEEDRADAR_REVIEW_BUDGET_V1'
      || !Array.isArray(value.events) || value.events.length > MAX_CALLS * 2) throw new TypeError('REVIEW_BUDGET_INVALID');
  if (['scopeDigest', 'reviewerRevision', 'maxModelCalls'].some(key => value[key] !== policy[key])) throw new TypeError('REVIEW_BUDGET_POLICY_MISMATCH');
  const started = new Map(), completed = new Map(); let previous = -Infinity;
  for (const event of value.events) {
    if (!exact(event, ['type', 'attemptId', 'pairDigest', 'recordedAt', ...(event?.type === 'STARTED' ? [] : ['costUsd'])])
      || !['STARTED', 'RETURNED', 'FAILED'].includes(event.type) || !Number.isSafeInteger(event.attemptId)
      || typeof event.pairDigest !== 'string' || !DIGEST.test(event.pairDigest)) throw new TypeError('REVIEW_BUDGET_EVENT_INVALID');
    const at = Date.parse(timestamp(event.recordedAt));
    if (at < previous) throw new TypeError('REVIEW_BUDGET_TIME_ORDER');
    previous = at;
    if (event.type === 'STARTED') {
      if (event.attemptId !== started.size + 1 || started.size >= policy.maxModelCalls) throw new TypeError('REVIEW_BUDGET_RESERVATION_INVALID');
      started.set(event.attemptId, event);
    } else {
      if (!started.has(event.attemptId) || completed.has(event.attemptId)
        || started.get(event.attemptId).pairDigest !== event.pairDigest
        || (event.costUsd !== null && cost(event.costUsd) !== event.costUsd)
        || (event.type === 'FAILED' && event.costUsd !== null)) throw new TypeError('REVIEW_BUDGET_COMPLETION_INVALID');
      completed.set(event.attemptId, event);
    }
  }
  const known = [...completed.values()].filter(event => event.costUsd !== null);
  const knownCostUsd = known.reduce((sum, event) => sum + event.costUsd, 0);
  if (!Number.isFinite(knownCostUsd)) throw new TypeError('REVIEW_BUDGET_COST_INVALID');
  const unknownCostCalls = started.size - known.length;
  return { maxModelCalls: policy.maxModelCalls, reservedCalls: started.size, remainingCalls: policy.maxModelCalls - started.size,
    returnedCalls: [...completed.values()].filter(event => event.type === 'RETURNED').length,
    failedCalls: [...completed.values()].filter(event => event.type === 'FAILED').length,
    unfinishedReservations: started.size - completed.size,
    knownCostUsd, unknownCostCalls, totalCostUsd: unknownCostCalls ? null : knownCostUsd };
}

export async function withCampaignBudget(config, reviewerRevision, options, invoke) {
  if (!exact(config, ['path', 'scopeDigest', 'maxModelCalls']) || typeof config.path !== 'string' || !config.path
    || typeof config.scopeDigest !== 'string' || !DIGEST.test(config.scopeDigest)
    || !Number.isSafeInteger(config.maxModelCalls) || config.maxModelCalls < 0 || config.maxModelCalls > MAX_CALLS
    || typeof reviewerRevision !== 'string' || !reviewerRevision.trim() || reviewerRevision.length > 200) throw new TypeError('REVIEW_BUDGET_POLICY_INVALID');
  const perInvocation = options.maxModelCalls ?? 8;
  if (!Number.isInteger(perInvocation) || perInvocation < 0 || perInvocation > 64) throw new TypeError('INVALID_REVIEW_BUDGET');
  if (options.reviewer !== undefined && typeof options.reviewer !== 'function') throw new TypeError('REVIEW_BUDGET_REVIEWER_INVALID');
  const policy = { scopeDigest: config.scopeDigest, reviewerRevision, maxModelCalls: config.maxModelCalls };
  return withLockedReviewFile({ path: config.path, initialValue: { version: 1, kind: 'NEEDRADAR_REVIEW_BUDGET_V1', ...policy, events: [] },
    validate: value => validate(value, policy), maxBytes: MAX_BYTES, prefix: 'REVIEW_BUDGET',
  }, async ({ value, checkpoint, exists }) => {
    if (!exists) await checkpoint(value);
    const progress = () => validate(value, policy);
    const controller = new AbortController(), abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    let persistenceError;
    const append = async event => {
      try { value.events.push(event); await checkpoint(value); }
      catch (error) { persistenceError = error; controller.abort(); throw error; }
    };
    const reviewer = options.reviewer && (async (request, context) => {
      if (persistenceError) throw persistenceError;
      const state = progress();
      if (!state.remainingCalls) throw new Error('REVIEW_BUDGET_EXHAUSTED');
      // Reserve terminal-event storage before a potentially billable callback.
      if (Buffer.byteLength(JSON.stringify(value, null, 2)) + 1024 > MAX_BYTES) {
        persistenceError = new Error('REVIEW_BUDGET_SIZE_LIMIT'); controller.abort(); throw persistenceError;
      }
      const started = { type: 'STARTED', attemptId: state.reservedCalls + 1,
        pairDigest: pairDigest(request.left, request.right), recordedAt: new Date().toISOString() };
      await append(started);
      let response;
      try {
        if (controller.signal.aborted) throw new Error('REVIEW_BUDGET_CANCELLED');
        response = await options.reviewer(request, context);
      } catch (error) {
        await append({ ...started, type: 'FAILED', recordedAt: new Date().toISOString(), costUsd: null });
        throw error;
      }
      // RETURNED is not semantic success. The original reviewer still validates
      // the decision and may reject it while its real call remains budgeted.
      const descriptor = record(response) ? Object.getOwnPropertyDescriptor(response, 'costUsd') : undefined;
      await append({ ...started, type: 'RETURNED', recordedAt: new Date().toISOString(), costUsd: cost(descriptor?.value) });
      return response;
    });
    try {
      const result = await invoke({ ...options, signal: controller.signal, reviewer,
        maxModelCalls: Math.min(perInvocation, progress().remainingCalls) });
      // The legacy semantic API catches reviewer errors. Persistence failures
      // must cross that boundary and stop the campaign instead of looking done.
      if (persistenceError) throw persistenceError;
      return { ...result, campaignProgress: progress() };
    } finally { options.signal?.removeEventListener('abort', abort); }
  });
}
