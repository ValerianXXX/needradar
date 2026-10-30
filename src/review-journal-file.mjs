import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { REVIEW_VERSION, reviewDuplicates } from './semantic-review.mjs';
import { MAX_JOURNAL_BYTES, validateReviewJournal } from './review-journal.mjs';

async function readJournal(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_JOURNAL_BYTES) throw new Error('REVIEW_JOURNAL_FILE_INVALID');
    const handle = await open(path, constants.O_RDONLY);
    try {
      const current = await handle.stat();
      if (current.dev !== info.dev || current.ino !== info.ino || current.size > MAX_JOURNAL_BYTES) throw new Error('REVIEW_JOURNAL_FILE_CHANGED');
      // A bounded read, even if another process grows the file during this read.
      const bytes = Buffer.alloc(current.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count !== current.size) throw new Error('REVIEW_JOURNAL_FILE_CHANGED');
      return bytes.subarray(0, count).toString('utf8');
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// The path is explicit trusted operator configuration, never model output.
// Cooperating writers hold an exclusive lock. A crash leaves that lock for
// manual ownership review; it is never automatically broken by age or PID.
export async function reviewDuplicatesWithJournalFile(candidate, existing, {
  journalPath, reviewerRevision, onCheckpoint, reviewJournal, ...options
} = {}) {
  if (typeof journalPath !== 'string' || !journalPath || onCheckpoint !== undefined || reviewJournal !== undefined) throw new TypeError('EXPLICIT_JOURNAL_FILE_REQUIRED');
  const requested = resolve(journalPath), parent = await realpath(dirname(requested));
  const path = resolve(parent, basename(requested)), lockPath = path + '.lock';
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('REVIEW_JOURNAL_LOCKED');
    throw error;
  }
  const owner = randomUUID();
  const lockIdentity = await lock.stat();
  try {
    await lock.writeFile(owner);
    await lock.sync();
    let previous = await readJournal(path);
    let journal;
    try { journal = previous === null ? { version: 1, reviewProtocol: REVIEW_VERSION, reviewerRevision, events: [] } : JSON.parse(previous); }
    catch { throw new Error('REVIEW_JOURNAL_JSON_INVALID'); }
    validateReviewJournal(journal, reviewerRevision);
    const checkpoint = async value => {
      validateReviewJournal(value, reviewerRevision);
      if (await readJournal(path) !== previous) throw new Error('REVIEW_JOURNAL_FILE_CHANGED');
      const next = JSON.stringify(value, null, 2) + '\n';
      if (Buffer.byteLength(next) > MAX_JOURNAL_BYTES) throw new Error('REVIEW_JOURNAL_SIZE_LIMIT');
      const temporary = path + '.' + owner + '.tmp';
      let handle, ownsTemporary = false;
      try {
        handle = await open(temporary, 'wx', 0o600);
        ownsTemporary = true;
        await handle.writeFile(next);
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, path);
        previous = next;
      } finally {
        if (handle) await handle.close();
        // Only the uniquely owned temporary file, never a prior journal/lock.
        if (ownsTemporary) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    };
    return await reviewDuplicates(candidate, existing, { ...options, reviewerRevision, reviewJournal: journal, onCheckpoint: checkpoint });
  } finally {
    await lock.close();
    // Do not read through or remove a replaced lock owned by another process.
    const current = await lstat(lockPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current?.isFile() && !current.isSymbolicLink() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) await unlink(lockPath);
  }
}
