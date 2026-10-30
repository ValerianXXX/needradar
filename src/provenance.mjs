import { createHash } from 'node:crypto';
import { attributionKey, attributionValue, independentEvidenceUnits } from './evidence-independence.mjs';

export function canonicalEvidenceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // An anchor may identify a different forum comment. Only a source adapter
    // with evidence about that site's semantics may supply a fragment-free
    // canonicalUrl; generic normalization must not collapse those authors.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/iu.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  } catch { return null; }
}

function keys(item) {
  const result = [];
  for (const field of ['evidenceKey', 'originKey', 'repostOf']) {
    if (typeof item[field] === 'string' && item[field].trim()) result.push(`origin:${item[field].trim()}`);
  }
  for (const field of ['canonicalUrl', 'originalUrl', 'url']) {
    const url = canonicalEvidenceUrl(item[field]);
    if (url) result.push(`url:${url}`);
  }
  if (typeof item.contentHash === 'string' && /^sha256:[0-9a-f]{64}$/u.test(item.contentHash)) result.push(item.contentHash);
  return result;
}

function referencedOrigins(item) {
  const refs = [];
  for (const field of ['repostOf', 'originKey']) {
    if (typeof item[field] === 'string' && item[field].trim() && item[field] !== item.evidenceKey) refs.push(`origin:${item[field].trim()}`);
  }
  const originalUrl = canonicalEvidenceUrl(item.originalUrl);
  if (originalUrl) refs.push(`url:${originalUrl}`);
  return refs;
}

function chooseOriginal(items) {
  const originals = items.filter(item => !item.repostOf && !item.originalUrl);
  const references = new Set(items.flatMap(referencedOrigins));
  const anchored = originals.filter(item => keys(item).some(key => references.has(key)));
  const candidates = anchored.length ? anchored : originals;
  const conflicting = ['authorGroup', 'originGroup'].some(field => new Set(candidates.map(item => attributionValue(item[field])).filter(Boolean)).size > 1);
  const invalidAttribution = candidates.some(item => ['authorGroup', 'originGroup'].some(field => item[field] != null && typeof item[field] !== 'string'));
  const attributionKeys = [...new Set(candidates.flatMap(item => ['authorGroup', 'originGroup']
    .filter(field => attributionValue(item[field])).map(field => attributionKey(field, item[field]))))].sort();
  const stable = [...(candidates.length ? candidates : items)].sort((a, b) => {
    const aKey = JSON.stringify([!a.originGroup, !a.authorGroup, keys(a).sort(), a.sourcePolicy ?? '', a.authorGroup ?? '']);
    const bKey = JSON.stringify([!b.originGroup, !b.authorGroup, keys(b).sort(), b.sourcePolicy ?? '', b.authorGroup ?? '']);
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return { original: stable[0], unresolvedRepost: !originals.length, conflicting, invalidAttribution, attributionKeys };
}

export function groupEvidence(observations = []) {
  const parent = observations.map((_, index) => index), seen = new Map();
  const root = (index) => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  observations.forEach((item, index) => {
    for (const key of keys(item)) {
      if (seen.has(key)) parent[root(index)] = root(seen.get(key));
      else seen.set(key, index);
    }
  });
  const groups = new Map();
  observations.forEach((item, index) => {
    const id = root(index);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(item);
  });
  return [...groups.values()].map((items) => {
    const identityKeys = [...new Set(items.flatMap(keys))].sort();
    const { original, unresolvedRepost, conflicting, invalidAttribution, attributionKeys } = chooseOriginal(items);
    const independenceReasons = [
      ...(!identityKeys.length ? ['MISSING_IDENTITY'] : []),
      ...(unresolvedRepost ? ['UNRESOLVED_REPOST'] : []),
      ...(conflicting ? ['CONFLICTING_ORIGINAL_PROVENANCE'] : []),
      ...(invalidAttribution ? ['INVALID_ORIGIN_ATTRIBUTION'] : []),
      ...(!attributionKeys.length ? ['MISSING_ORIGIN_ATTRIBUTION'] : []),
    ];
    return {
      id: createHash('sha256').update(JSON.stringify(identityKeys)).digest('hex'),
      identityKeys, attributionKeys, observations: items, original,
      independenceKnown: independenceReasons.length === 0, independenceReasons,
      duplicateCaptures: items.length - 1,
    };
  });
}

export function evidenceSummary(observations = []) {
  const groups = groupEvidence(observations);
  const independent = groups.filter((group) => group.independenceKnown);
  const independentUnits = independentEvidenceUnits(groups);
  const independentOriginIds = independentUnits.map(unit => unit.id);
  return {
    groups, captureCount: observations.length, uniqueEvidenceCount: groups.length,
    duplicateCaptures: observations.length - groups.length,
    independentEvidenceCount: independentUnits.length, independentOriginIds, independentUnits,
    independentAuthorGroups: independentUnits.filter(unit => unit.hasAuthorAttribution).length,
    distinctAttributedAuthorGroups: new Set(independentUnits.flatMap(unit => unit.attributionKeys)
      .filter(key => JSON.parse(key)[0] === 'authorGroup')).size,
    sourcePolicies: new Set(independent.map(group => attributionValue(group.original.sourcePolicy)).filter(Boolean)).size,
    unresolvedProvenanceCount: groups.filter((group) => !group.independenceKnown).length,
  };
}
