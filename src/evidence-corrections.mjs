import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { evidenceSummary } from './provenance.mjs';
import { independentEvidenceChange } from './evidence-independence.mjs';
import { addEvidence } from './opportunity-state.mjs';
import { timestamp } from './timestamps.mjs';

const token = value => typeof value === 'string' && value.trim().length > 0;
const digestPattern = /^[a-f0-9]{64}$/u;

// Plain source records only. Tagged encoding preserves undefined versus null,
// sorts object keys, and rejects cycles, getters and non-data object types.
function encoded(value, active = new Set()) {
  if (value === null) return ['null'];
  if (value === undefined) return ['undefined'];
  if (['string', 'boolean'].includes(typeof value)) return [typeof value, value];
  if (typeof value === 'number' && Number.isFinite(value)) return ['number', Object.is(value, -0) ? '-0' : value];
  if (!value || typeof value !== 'object' || active.has(value)) throw new TypeError('EVIDENCE_CORRECTION_INPUT_INVALID');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError('EVIDENCE_CORRECTION_INPUT_INVALID');
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length + (array ? 1 : 0)) {
    throw new TypeError('EVIDENCE_CORRECTION_INPUT_INVALID');
  }
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index)))) {
    throw new TypeError('EVIDENCE_CORRECTION_INPUT_INVALID');
  }
  active.add(value);
  try {
    return [array ? 'array' : 'object', keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw new TypeError('EVIDENCE_CORRECTION_INPUT_INVALID');
      return [key, encoded(descriptor.value, active)];
    })];
  } finally { active.delete(value); }
}
const digest = value => createHash('sha256').update(JSON.stringify(encoded(value))).digest('hex');

export function evidenceCorrectionDigest(opportunity) {
  if (!opportunity || typeof opportunity !== 'object' || !Array.isArray(opportunity.observations)) {
    throw new TypeError('EVIDENCE_CORRECTION_INPUT_INVALID');
  }
  return digest(opportunity);
}

function historyOf(state) {
  const history = state.provenance_corrections === undefined ? [] : state.provenance_corrections;
  try {
    if (!Array.isArray(history)) throw new Error();
    let previous = '';
    for (const event of history) {
      const { id, ...body } = event;
      if (body.schemaVersion !== 1 || !['ATTRIBUTION_CORRECTED', 'ATTRIBUTION_REVERTED'].includes(body.kind)
          || !token(body.actor) || !token(body.reason) || !Array.isArray(body.changes) || !body.changes.length
          || !digestPattern.test(id) || digest(body) !== id
          || !digestPattern.test(body.beforeEvidenceDigest) || !digestPattern.test(body.afterEvidenceDigest)
          || timestamp(body.recordedAt) !== body.recordedAt || body.recordedAt <= previous) throw new Error();
      previous = body.recordedAt;
    }
  } catch { throw new Error('EVIDENCE_CORRECTION_HISTORY_INVALID'); }
  return history;
}

function begin(opportunity, options, fields) {
  const currentDigest = evidenceCorrectionDigest(opportunity);
  const state = structuredClone(opportunity), history = historyOf(state);
  if (!options || Object.keys(options).some(key => !fields.includes(key))
      || !token(options.actor) || options.actor.length > 200 || !token(options.reason) || options.reason.length > 2000) {
    throw new TypeError('EVIDENCE_CORRECTION_REVIEW_REQUIRED');
  }
  if (options.expectedDigest !== currentDigest) throw new Error('EVIDENCE_CORRECTION_STALE_INPUT');
  const recordedAt = timestamp(options.recordedAt);
  if (history.length && recordedAt <= history.at(-1).recordedAt) throw new Error('EVIDENCE_CORRECTION_TIME_MUST_ADVANCE');
  return { state, history, currentDigest, recordedAt,
    actor: options.actor.trim(), reason: options.reason.trim() };
}

function finish(context, observations, changes, kind, undoes) {
  const { state, history, currentDigest, recordedAt, actor, reason } = context;
  const change = independentEvidenceChange(evidenceSummary(state.observations), evidenceSummary(observations));
  if (change.added !== 0) throw new Error('EVIDENCE_CORRECTION_CANNOT_CREATE_ARRIVAL');
  const result = addEvidence({ ...state, observations }, [], { observedAt: recordedAt });
  result.independent_recency_verified = state.evidence_state_version === 2
    && state.independent_recency_verified === true && change.consolidatedOrLost === 0;
  result.provenance_change = { newIndependentOrigins: 0, resolvedExistingOrigins: change.resolvedExisting,
    consolidatedOrLostOrigins: change.consolidatedOrLost };
  const body = {
    schemaVersion: 1, kind, actor, reason, recordedAt, inputDigest: currentDigest,
    beforeEvidenceDigest: digest(state.observations), afterEvidenceDigest: digest(observations),
    changes: structuredClone(changes), ...(undoes ? { undoes } : {}),
  };
  result.provenance_corrections = [...structuredClone(history), { id: digest(body), ...body }];
  return structuredClone(result);
}

// A pure proposed transition, not authentication or a database transaction.
// A host must authenticate the reviewer and compare the current revision again
// when storing the returned state. A model-supplied actor is not approval.
export function correctEvidenceAttribution(opportunity, options) {
  const context = begin(opportunity, options,
    ['expectedDigest', 'evidenceKeys', 'patch', 'actor', 'reason', 'recordedAt']);
  const { evidenceKeys, patch } = options;
  if (!patch || Array.isArray(patch) || typeof patch !== 'object' || !Object.keys(patch).length
      || Object.entries(patch).some(([field, value]) => !['authorGroup', 'originGroup'].includes(field)
        || value !== null && (!token(value) || value.length > 1000))) {
    throw new TypeError('EVIDENCE_CORRECTION_PATCH_INVALID');
  }
  if (!Array.isArray(evidenceKeys) || !evidenceKeys.length || evidenceKeys.some(key => !token(key))
      || new Set(evidenceKeys).size !== evidenceKeys.length) throw new TypeError('EVIDENCE_CORRECTION_TARGET_INVALID');
  const selected = new Set(evidenceKeys), found = new Set(), changes = [];
  const fields = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value === null ? null : value.trim()]));
  const observations = context.state.observations.map((before, index) => {
    if (!selected.has(before.evidenceKey)) return before;
    found.add(before.evidenceKey);
    const after = { ...before, ...fields };
    if (!isDeepStrictEqual(before, after)) changes.push({ index, before, after });
    return after;
  });
  if (found.size !== selected.size) throw new Error('EVIDENCE_CORRECTION_TARGET_INVALID');
  if (!changes.length) throw new Error('EVIDENCE_CORRECTION_NO_CHANGE');
  return finish(context, observations, changes, 'ATTRIBUTION_CORRECTED');
}

export function revertEvidenceAttribution(opportunity, options) {
  const context = begin(opportunity, options, ['expectedDigest', 'eventId', 'actor', 'reason', 'recordedAt']);
  const event = context.history.at(-1);
  if (!event || event.id !== options.eventId || event.kind !== 'ATTRIBUTION_CORRECTED') {
    throw new Error('EVIDENCE_CORRECTION_UNDO_NOT_CURRENT');
  }
  if (digest(context.state.observations) !== event.afterEvidenceDigest) throw new Error('EVIDENCE_CORRECTION_SOURCE_CHANGED');
  const observations = structuredClone(context.state.observations);
  const changes = event.changes.map(change => {
    const before = observations[change.index], after = structuredClone(change.before);
    observations[change.index] = after;
    return { index: change.index, before, after };
  });
  return finish(context, observations, changes, 'ATTRIBUTION_REVERTED', event.id);
}
