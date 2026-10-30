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
export function independentEvidenceChange(before, after, priorCaptures) {
  const priorKeys = new Set(before.independentUnits.flatMap(unit => unit.attributionKeys));
  const groups = new Map(after.groups.map(group => [group.id, group]));
  let added = 0, resolvedExisting = 0, survivingPriorUnits = 0;
  for (const unit of after.independentUnits) {
    if (unit.attributionKeys.some(key => priorKeys.has(key))) { survivingPriorUnits++; continue; }
    const includesPriorCapture = unit.evidenceGroupIds.some(id => groups.get(id).observations.some(item => priorCaptures.has(item)));
    if (includesPriorCapture) resolvedExisting++;
    else added++;
  }
  return { added, resolvedExisting,
    consolidatedOrLost: Math.max(0, before.independentUnits.length - survivingPriorUnits) };
}
