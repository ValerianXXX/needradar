import { REVIEW_VERSION, reviewDuplicates } from './semantic-review.mjs';
import { MAX_JOURNAL_BYTES, validateReviewJournal } from './review-journal.mjs';
import { withLockedReviewFile } from './review-state-file.mjs';
import { withCampaignBudget } from './review-budget.mjs';

// Operator-selected campaign state spans proposal shards without rewriting V1.
export async function reviewDuplicatesWithJournalFile(candidate, existing, {
  journalPath, reviewerRevision, onCheckpoint, reviewJournal, campaignBudget, ...options
} = {}) {
  if (typeof journalPath !== 'string' || !journalPath || onCheckpoint !== undefined || reviewJournal !== undefined) throw new TypeError('EXPLICIT_JOURNAL_FILE_REQUIRED');
  const invoke = suppliedOptions => withLockedReviewFile({ path: journalPath,
    initialValue: { version: 1, reviewProtocol: REVIEW_VERSION, reviewerRevision, events: [] },
    validate: value => validateReviewJournal(value, reviewerRevision), maxBytes: MAX_JOURNAL_BYTES, prefix: 'REVIEW_JOURNAL',
  }, ({ value, checkpoint }) => reviewDuplicates(candidate, existing, {
    ...suppliedOptions, reviewerRevision, reviewJournal: value, onCheckpoint: checkpoint,
  }));
  return campaignBudget === undefined ? invoke(options)
    : withCampaignBudget(campaignBudget, reviewerRevision, options, invoke);
}
