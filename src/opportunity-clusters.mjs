import { createHash } from 'node:crypto';
import { compareConstraints } from './similarity.mjs';
import { pairDigest, resolveHumanDecision } from './semantic-review.mjs';
import { recordPairDecision } from './opportunity-state.mjs';
import { evidenceSummary } from './provenance.mjs';

const pairKey = (left, right) => JSON.stringify([left, right].sort());
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function registry(opportunities) {
  if (!Array.isArray(opportunities) || opportunities.length > 10000) throw new Error('CLUSTER_SIZE_LIMIT');
  const byId = new Map();
  for (const item of opportunities) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200 || byId.has(item.id)) throw new Error('UNIQUE_OPPORTUNITY_IDS_REQUIRED');
    byId.set(item.id, item);
  }
  return byId;
}

// A derived, non-destructive view of authenticated human decisions. Callers
// must authorize journal writes; a model response is never a human event.
// Complete cross-pair review is required before joining groups: A~B and B~C
// cannot imply A~C, and an explicit A!=C cannot be hidden by transitivity.
export function buildReviewClusters(opportunities, { humanDecisions = [], maxPairChecks = 100000 } = {}) {
  const byId = registry(opportunities);
  if (!Array.isArray(humanDecisions) || humanDecisions.length > 20000) throw new Error('CLUSTER_REVIEW_LIMIT');
  if (!Number.isInteger(maxPairChecks) || maxPairChecks < 1 || maxPairChecks > 1000000) throw new Error('CLUSTER_CHECK_LIMIT');
  const buckets = new Map(), ignored = [];
  for (const event of humanDecisions) {
    const originals = event?.originals;
    if (!Array.isArray(originals) || originals.length !== 2 || originals[0]?.id === originals[1]?.id
      || !byId.has(originals[0]?.id) || !byId.has(originals[1]?.id)) {
      ignored.push({ reviewId: event?.id ?? null, reason: 'REVIEW_TARGET_MISSING' });
      continue;
    }
    const left = byId.get(originals[0].id), right = byId.get(originals[1].id);
    if (event.digest !== pairDigest(originals[0], originals[1]) || !resolveHumanDecision(left, right, [event])) {
      ignored.push({ reviewId: event.id ?? null, reason: 'STALE_OR_INVALID_REVIEW' });
      continue;
    }
    const key = pairKey(left.id, right.id);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(event);
  }
  const active = new Map([...buckets].map(([key, events]) => {
    const [left, right] = JSON.parse(key);
    return [key, resolveHumanDecision(byId.get(left), byId.get(right), events)];
  }));
  const ids = [...byId.keys()].sort(), parent = new Map(ids.map(id => [id, id])), members = new Map(ids.map(id => [id, [id]]));
  const root = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
  const blockedEdges = [];
  let pairChecks = 0;
  for (const [key, review] of [...active].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (review.decision !== 'same') continue;
    const edge = JSON.parse(key), leftRoot = root(edge[0]), rightRoot = root(edge[1]);
    if (leftRoot === rightRoot) continue;
    const leftMembers = members.get(leftRoot), rightMembers = members.get(rightRoot);
    if (pairChecks + leftMembers.length * rightMembers.length > maxPairChecks) {
      blockedEdges.push({ pair: edge, reason: 'PAIR_CHECK_BUDGET_EXHAUSTED' });
      continue;
    }
    const reasons = new Set();
    let blockingPair = null;
    for (const leftId of leftMembers) for (const rightId of rightMembers) {
      pairChecks++;
      const cross = active.get(pairKey(leftId, rightId)), left = byId.get(leftId), right = byId.get(rightId);
      const constraints = compareConstraints(left, right);
      let reason = null;
      if (constraints.conflicts.length) reason = 'EXPLICIT_CONSTRAINT_CONFLICT';
      else if (constraints.missing.length) reason = 'INCOMPLETE_CONSTRAINTS';
      else if (![left.persona, left.jobToBeDone, right.persona, right.jobToBeDone].every(text => typeof text === 'string' && text.trim())) reason = 'INCOMPLETE_IDENTITY';
      else if (cross?.decision === 'different') reason = 'CANNOT_LINK_REVIEW';
      else if (cross?.method === 'HUMAN_DECISION_CONFLICT') reason = 'CONFLICTING_HUMAN_DECISIONS';
      else if (cross?.decision !== 'same') reason = 'CROSS_PAIR_REVIEW_REQUIRED';
      if (reason) {
        reasons.add(reason);
        if (!blockingPair || reason === 'CANNOT_LINK_REVIEW' || reason === 'EXPLICIT_CONSTRAINT_CONFLICT') blockingPair = [leftId, rightId];
      }
    }
    if (reasons.size) { blockedEdges.push({ pair: edge, reasons: [...reasons].sort(), blockingPair }); continue; }
    const leader = leftRoot < rightRoot ? leftRoot : rightRoot, other = leader === leftRoot ? rightRoot : leftRoot;
    parent.set(other, leader);
    members.set(leader, [...leftMembers, ...rightMembers].sort());
    members.delete(other);
  }
  const groups = [...members.values()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(memberIds => ({
    id: digest(memberIds.map(id => [id, pairDigest(byId.get(id), byId.get(id))])), memberIds,
    evidence: evidenceSummary(memberIds.flatMap(id => byId.get(id).observations ?? [])),
  }));
  const unreviewedPairs = ids.length * (ids.length - 1) / 2 - active.size;
  // Evidence grouping deliberately retains capture identity internally. Detach
  // the completed view here, before a caller can edit its preview or rights.
  return structuredClone({ protocol: 'HUMAN_REVIEW_CLUSTER_VIEW_V1', groups, ignoredReviews: ignored, blockedEdges,
    pairChecks, maxPairChecks, unreviewedPairs,
    requiresReview: unreviewedPairs > 0 || blockedEdges.length > 0 || [...active.values()].some(review => review.decision === 'uncertain'),
    automaticMerge: false, originalRecordsRemoved: 0,
    scope: 'Deterministic conservative grouping, not an optimal partition or proof of novelty. Original records and the full review journal remain caller-owned.' });
}

// Append these decisions to the existing journal. The prior journal still
// reproduces the prior view; later current-content reviews can restore links.
export function recordClusterSplit(opportunities, { groups, actor, reason, recordedAt } = {}) {
  const byId = registry(opportunities);
  if (!Array.isArray(groups) || groups.length < 2 || groups.some(group => !Array.isArray(group) || !group.length)) throw new Error('SPLIT_GROUPS_REQUIRED');
  const all = groups.flat();
  if (new Set(all).size !== all.length || all.some(id => !byId.has(id))) throw new Error('SPLIT_MEMBERS_INVALID');
  const sorted = groups.map(group => [...group].sort()).sort((a, b) => a[0] < b[0] ? -1 : 1);
  const pairCount = sorted.reduce((sum, group, index) => sum + sorted.slice(index + 1).reduce((n, other) => n + group.length * other.length, 0), 0);
  if (pairCount > 4096) throw new Error('SPLIT_PAIR_LIMIT');
  const events = [];
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    for (const leftId of sorted[i]) for (const rightId of sorted[j]) {
      const left = byId.get(leftId), right = byId.get(rightId);
      events.push(recordPairDecision(left, right, { digest: pairDigest(left, right), decision: 'different', actor, reason, recordedAt }));
    }
  }
  return { id: digest(events.map(event => event.id)), kind: 'HUMAN_CLUSTER_SPLIT', groups: sorted, events,
    reversible: true, automaticMerge: false, originalRecordsRemoved: 0 };
}
