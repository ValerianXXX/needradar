# Resumable pair review - 29 October 2026

The default eight-call review limit previously restarted at the beginning of the
shortlist on every invocation. A repeated request could spend the same budget on
the same eight pairs while later candidates remained unvisited. This change adds
an explicit, optional continuation journal; it does not increase that budget or
change retrieval, the V1 model prompt, semantic thresholds or publication rules.

This is the public curated edition. No hosted source, production database, source
policy, service credential or deployment was accessed or modified.

## Architecture and behavior

- `review-contract.mjs` holds the existing V1 fields, digest, schema and grounded
  response validation. Existing imports from `semantic-review.mjs` remain valid.
- `semantic-review.mjs` still applies current human decisions, explicit constraint
  conflicts and exact identity rules before considering a model proposal.
- `review-journal.mjs` records append-only `STARTED`, `RESULT` and `FAILED` events.
  A proposal binds the exact oriented public pair content and an operator-supplied
  reviewer revision. It is never a human decision or evidence of independent demand.
- `review-journal-file.mjs` supplies bounded local file reads, an exclusive lock,
  synced temporary writes and replacement of the checkpoint. Each attempt is
  checkpointed before a provider call; its result is checkpointed before proceeding.

Original stateless callers continue to work. Continuation callers explicitly set
`reviewerRevision`, and either retain the returned `reviewJournal`, await their own
`onCheckpoint` callback, or use the file adapter. A revision should identify the
reviewer implementation, prompt and configured provider/model, without credentials.
Changing that revision requires a new journal. This prevents accidental reuse after
a known provider change; it cannot discover an undisclosed change behind an alias.

Valid saved proposals are rechecked against current source quotations. Current
constraints and human corrections still apply. Reordering records retains their
pair binding; editing relevant content triggers a new review. Reversing the pair
orientation conservatively requires another proposal. New inputs and retrieved
records are snapshotted for one invocation, so edits while awaiting a response do
not silently change its meaning. Retrieval indexes still need explicit rebuilds.

The journal has at most 512 events and 2 MiB. No history is silently truncated.
Identical oriented pair content shares an attempt, independently of source count.
This is proposal reuse, not consolidation of evidence records. The optional file
adapter needs no database, package, network service or new background process.

## Failure, cancellation and cost boundaries

A provider exception or invalid grounded result is recorded as `FAILED`. A saved
start with no terminal event is `REVIEW_INTERRUPTED`: the external request may
already have completed or incurred a charge. Neither is automatically retried.
`retryFailedPairs` must explicitly name the exact pair digests; a pair has at most
three recorded attempts. A new retry still consumes the invocation's normal limit.
An accepted `uncertain` proposal remains for human review, without repeated calls.

Checkpoint errors propagate. If a start cannot be saved, no provider call starts.
If saving its result fails, later candidates are not started and the saved start
remains uncertain. The file adapter detects noncooperating edits before replacing
a checkpoint. Cooperating writers are serialized; it is not a general distributed
transaction system or a defense against an adversarial process with the same
filesystem permissions.

An `AbortSignal` prevents new calls and is passed as the reviewer's second argument.
An already-running provider may ignore it; its response is retained if available.
The existing Hermes/command and direct-provider adapters retain their own timeout
behavior. No claim is made that cancellation refunds or stops a remote request.
Cancellation during the write-ahead checkpoint records a failed attempt without
starting a provider, requiring explicit retry rather than guessing its outcome.

The lock is not broken automatically, including after process termination. Stop
and verify the owning process before an operator removes an abandoned `.lock`.
Preserve the journal, inspect unfinished attempts and choose retries explicitly.
File synchronization and restart tests are not power-loss or hardware-failure proof.

Cached responses use `MODEL_PROPOSAL_REUSED` and retain original usage, latency and
cost observations. `modelCalls` counts only calls started in this invocation;
`reviewProgress` separately reports reuse, pending, failed, interrupted, cancelled
and uncertain pairs. Do not sum cached costs as new charges. Missing observations
remain null; subscription access is not a zero-cost inference claim. Only allowlisted
nonnegative token counters and bounded model metadata enter the journal.

## Reproduce and integrate

Normal checks remain `npm run check` (the English check and all Node tests). The
offline comparison has no provider or encoder configuration:

```powershell
npm run eval:review-continuation -- --output ..\review-continuation-check.json
```

Use a fresh output filename. The script replays one pinned earlier Hermes response
and explicit uncertain stubs, then removes only its owned temporary directory.
It never launches Hermes or contacts a model endpoint.

For an integrating application with an already configured, authorized reviewer:

```js
import { reviewDuplicatesWithJournalFile } from './src/review-journal-file.mjs';

const result = await reviewDuplicatesWithJournalFile(candidate, index, {
  journalPath: operatorSelectedPath, // Existing parent directory outside this checkout.
  reviewerRevision: operatorPinnedReviewerRevision,
  reviewer: configuredGroundedReviewer,
  maxModelCalls: 8,
  signal: abortController.signal,
  // Include queryEmbedding when index is a local semantic index.
});
```

`candidate`, `index`, path, revision, reviewer and controller are caller inputs.
This example supplies no credentials or approval. Reinvoke explicitly to process
later candidates. A replay with `maxModelCalls: 0` can inspect saved proposals.
Keep the public pair text governed: journals contain its source quotations and
are neither a private-data vault nor authenticated provider receipts. Do not accept
an arbitrary uploaded journal as a human decision. The human correction journal
and existing merge/publication/evidence gates remain separate.

## Observed verification

The unchanged starting branch passed 50 Node tests. Of twelve frozen continuation
contracts, two passed and ten failed before implementation; all twelve now pass.
Nine additional checks cover actual separate Node processes, abrupt process exit,
concurrent writers, external edits, corrupt/oversized files, retry limits,
cancellation during persistence, metadata and source mutation. The complete suite
passes 71 tests. These tests use synthetic tasks and contract reviewers.

The [fixed offline comparison](../eval/results/2026-10-29-review-continuation.json)
places the existing translated invoice target at rank 20 among 20 synthetic pairs.
The baseline remains callable through the unchanged stateless API:

| Three explicit invocations, limit eight each | Stateless baseline | File continuation |
| --- | ---: | ---: |
| Reviewer callbacks per invocation | 8 / 8 / 8 | 8 / 8 / 4 |
| Total callbacks | 24 | 20 |
| Distinct pairs visited | 8 | 20 |
| Repeated callbacks | 16 | 0 |
| Retrieved pairs still unvisited | 12 | 0 |
| Pinned earlier real response reached | 0 | 1 |
| Final unresolved proposals | 20 | 19 |
| Automatic merge | No | No |

Both arms make **zero new live model requests**. The remaining 19 continuation
proposals are explicit uncertain stubs; the one `same` proposal is an earlier
response, not new semantic evidence. This demonstrates scheduling and file recovery,
not a measured gain in semantic accuracy, provider latency, cost or human effort.
The local replay times include different filesystem work and are not model timings.

The historical 140-pair result, 80 unresolved decisions and seven duplicate targets
beyond the first eight-call budget remain unchanged observations. This mechanism
can advance a caller's queue; those targets have not received a new live review.
Independent held-out evaluation, human review effort, hosted adaptation and live
complete-workflow acceptance remain outstanding. Truncated retrieval still sets
`retrievalComplete: false` and cannot clear a novelty/publication gate even after
every shortlisted pair has been processed.

## Delivery and rollback

This source change requires no database migration or production action. Review the
draft PR before integration. Preserve journals during rollback; old code ignores
them. Pause review execution before reverting, because the old stateless path would
repeat calls. Do not delete failures, unlock an active writer or convert saved model
proposals into human approvals. The [verification receipt](../eval/results/2026-10-29-review-continuation-verification.json)
records versions, source/log hashes and the exact scope of these observations.
