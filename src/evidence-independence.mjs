import { createHash } from 'node:crypto';

// These are source-adapter identity tokens, not names to fuzzy-match or infer.
export const attributionValue = value => typeof value === 'string' && value.trim() ? value.trim() : null;
export const attributionKey = (field, value) => JSON.stringify([field, attributionValue(value)]);

// Capture identity and independent attribution are separate equivalence relations.
// A known shared author OR organization is sufficient to withhold independence.
// Typed keys avoid treating an author token as an unrelated organization token.
export function independentEvidenceUnits(groups) {
  const known = groups.filter(group => group.independenceKnown);
  const parent = known.map((_, index) => index), seen = new Map();
  const root = index => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  known.forEach((group, index) => {
    for (const key of group.attributionKeys) {
      if (seen.has(key)) parent[root(index)] = root(seen.get(key));
      else seen.set(key, index);
    }
  });
  const units = new Map();
  known.forEach((group, index) => {
    const id = root(index);
    if (!units.has(id)) units.set(id, []);
    units.get(id).push(group);
  });
  return [...units.values()].map(items => {
    const attributionKeys = [...new Set(items.flatMap(group => group.attributionKeys))].sort();
    return {
      id: createHash('sha256').update(JSON.stringify(attributionKeys)).digest('hex'),
      attributionKeys, evidenceGroupIds: items.map(group => group.id).sort(),
      hasAuthorAttribution: attributionKeys.some(key => JSON.parse(key)[0] === 'authorGroup'),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

// Unit digests can change when attribution improves. Newness must follow both
// prior capture membership and attribution, never a set difference of digests.
export function independentEvidenceChange(before, after) {
  const beforeGroups = new Map(before.groups.map(group => [group.id, group]));
  const afterGroups = new Map(after.groups.map(group => [group.id, group]));
  const priorAttribution = new Map(), priorIndependentCaptures = new Map();
  const priorCaptureKeys = new Set(before.groups.flatMap(group => group.identityKeys));
  before.independentUnits.forEach((unit, index) => {
    for (const key of unit.attributionKeys) priorAttribution.set(key, index);
    for (const id of unit.evidenceGroupIds) {
      for (const key of beforeGroups.get(id).identityKeys) priorIndependentCaptures.set(key, index);
    }
  });
  let added = 0, resolvedExisting = 0;
  const retainedCandidates = after.independentUnits.map(unit => {
    const captureKeys = unit.evidenceGroupIds.flatMap(id => afterGroups.get(id).identityKeys);
    const sameAttribution = unit.attributionKeys.some(key => priorAttribution.has(key));
    const sameCapture = captureKeys.some(key => priorCaptureKeys.has(key));
    if (!sameAttribution) {
      if (sameCapture) resolvedExisting++;
      else added++;
    }
    return [...new Set([
      ...unit.attributionKeys.filter(key => priorAttribution.has(key)).map(key => priorAttribution.get(key)),
      ...captureKeys.filter(key => priorIndependentCaptures.has(key)).map(key => priorIndependentCaptures.get(key)),
    ])].sort((a, b) => a - b);
  });
  return { added, resolvedExisting,
    consolidatedOrLost: before.independentUnits.length - retainedUnitCount(retainedCandidates) };
}

// Each prior independent unit can survive at most once. A split must not hide
// another unit's loss, and a merge retains one unit rather than all its inputs.
// Iterative augmenting paths avoid order-dependent greedy losses and recursion
// limits on long correction chains. These matches never merge source records.
function retainedUnitCount(candidates) {
  const matchedBefore = new Map(), matchedAfter = new Map();
  for (let start = 0; start < candidates.length; start++) {
    const queue = [start], visitedAfter = new Set(queue), predecessor = new Map();
    let free;
    search: for (let cursor = 0; cursor < queue.length; cursor++) {
      const after = queue[cursor];
      for (const before of candidates[after]) {
        if (predecessor.has(before)) continue;
        predecessor.set(before, after);
        if (!matchedBefore.has(before)) { free = before; break search; }
        const next = matchedBefore.get(before);
        if (!visitedAfter.has(next)) { visitedAfter.add(next); queue.push(next); }
      }
    }
    while (free !== undefined) {
      const after = predecessor.get(free), previous = matchedAfter.get(after);
      matchedAfter.set(after, free); matchedBefore.set(free, after);
      free = previous;
    }
  }
  return matchedAfter.size;
}
