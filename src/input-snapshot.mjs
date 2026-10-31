import { isDeepStrictEqual } from 'node:util';

// Single-process optimistic check at async boundaries, not a database lock.
// Once an observed edit invalidates this invocation, restoring its contents
// cannot silently revive it. Callers still need a transaction at publication.
export function captureInput(read, isCurrent) {
  if (isCurrent !== undefined && typeof isCurrent !== 'function') throw new TypeError('INPUT_CURRENT_CALLBACK_REQUIRED');
  const snapshot = structuredClone(read());
  let changed = false;
  return { snapshot, changed() {
    // Normalize both sides with the same clone contract. In particular, cloning
    // a supported null-prototype record must not itself look like a user edit.
    try { changed ||= (isCurrent !== undefined && isCurrent() !== true) || !isDeepStrictEqual(structuredClone(read()), snapshot); }
    catch { changed = true; }
    return changed;
  } };
}
