import { createHash } from 'node:crypto';

export function canonicalEvidenceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
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
    // Prefer the explicitly referenced original. A repost is not a new author/source.
    const original = items.find((item) => !item.repostOf && !item.originalUrl) ?? items[0];
    const unresolvedRepost = items.every((item) => item.repostOf || item.originalUrl);
    return {
      id: createHash('sha256').update(JSON.stringify(identityKeys)).digest('hex'),
      identityKeys, observations: items, original,
      independenceKnown: identityKeys.length > 0 && !unresolvedRepost && Boolean(original.authorGroup || original.originGroup),
      duplicateCaptures: items.length - 1,
    };
  });
}

export function evidenceSummary(observations = []) {
  const groups = groupEvidence(observations);
  const independent = groups.filter((group) => group.independenceKnown);
  return {
    groups, captureCount: observations.length, uniqueEvidenceCount: groups.length,
    duplicateCaptures: observations.length - groups.length,
    independentEvidenceCount: new Set(independent.map((group) => group.original.originGroup || group.original.authorGroup)).size,
    independentAuthorGroups: new Set(independent.map((group) => group.original.authorGroup).filter(Boolean)).size,
    sourcePolicies: new Set(independent.map((group) => group.original.sourcePolicy).filter(Boolean)).size,
    unresolvedProvenanceCount: groups.filter((group) => !group.independenceKnown).length,
  };
}
