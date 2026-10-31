import { isDeepStrictEqual } from 'node:util';

// Single-process optimistic check at async boundaries, not a database lock.
// Once an observed edit invalidates this invocation, restoring its contents
// cannot silently revive it. Callers still need a transaction at publication.
export function captureInput(read) {
  const snapshot = structuredClone(read());
  let changed = false;
  return { snapshot, changed() {
    try { changed ||= !isDeepStrictEqual(read(), snapshot); }
    catch { changed = true; }
    return changed;
  } };
}
