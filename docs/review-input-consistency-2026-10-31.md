# Consistent inputs across asynchronous reviews

Checked 31 October 2026. Public curated edition only; no hosted service, account,
database, deployment or live model campaign was changed.

## Problem and behavior

A model wait allowed callers to edit a draft, replace its peers or append a human
correction while the same invocation still used earlier similarity/constraint
results. Stateless review also exposed nested constraints and the shared response
schema to adapters. Publication could return `PUBLISH` after evidence rights or
publication rules had changed during that wait.

Each invocation now compares a detached input snapshot. Requests carry detached
public fields and schema; returned observations use the existing allowlisted
metadata sanitizer. At asynchronous boundaries the invocation checks for changed
inputs. An observed change is sticky: restoring the value later cannot revive the
invocation. It stops subsequent provider requests, returns `inputChanged: true`,
keeps `requiresReview: true`, and clears the actionable `duplicate` flag. Rows that
were not processed have method `REVIEW_INPUT_CHANGED`. Completed rows still show
their original snapshot, pair digest, response and original cost. They are not a
decision about the edited input.

The publication wrapper also watches evidence, complete draft fields and rules.
It returns `REVIEW / REVIEW_INPUT_CHANGED` when these change, and stops later
requests. A response already in flight can finish; its record is retained. This
does not add provider-side cancellation or automatic retry. Checkpoint failures
still propagate; nothing silently treats an unsaved response as complete.

## API and integration

The ordinary API, pair digest, V1 proposal journal, thresholds, model prompts and
human-decision format remain compatible. Supply plain, structured-cloneable data;
functions and nonportable application objects do not belong in opportunity data.
No new package, environment variable, model or service is required.

```js
const reviewedRevision = record.revision;
const result = await decidePublicationWithReview(cluster, comparisonSnapshot, {
  reviewer,
  reviewerRevision: configuredReviewerRevision,
  reviewJournal,
  maxModelCalls: 8,
  isInputCurrent: () => record.revision === reviewedRevision,
});
```

`isInputCurrent` is an optional **synchronous** caller revision check. Only `true`
permits continued processing. False, undefined, a thrown error or a Promise leaves
the invocation invalid; a non-function option is rejected. The callback and
evidence observations are not sent to the reviewer. Authentication of human
actions remains the integrating application's responsibility.

An explicit immutable lexical/vector index describes its own snapshot. Editing
the old source array does not change that index. Rebuild it or use an external
revision check when the active corpus changes. This library cannot observe changes
to a different process or database. It cannot detect an edit and restoration that
both occur between checks unless a monotonic caller revision changes. After the
function returns, the application must compare revisions in its publication
transaction; this is not a database lock, transaction or publish authorization.

Retain returned journals. A new explicit review may reuse a proposal only for its
unchanged pair and reviewer revision. Changed content needs fresh review within
the operator's existing authorized budget. Do not reset a closed experiment or
create another run directory to repeat completed or uncertain paid calls.

## Verification and retained failures

The [verification receipt](../eval/results/2026-10-31-review-input-verification.json)
binds source commits, LF-normalized source hashes, original logs and portable logs.

| Stage | Observed result |
| --- | --- |
| 15 contracts frozen at `93860f8` before implementation | 2 passed, 13 failed |
| Same 15 contracts after initial snapshot fix | 15 passed |
| 6 additional boundary contracts at `4cf835b` | Initially 1 passed, 5 failed; all now pass unchanged |
| First related suite | 59 passed, 1 failed: an old expectation required a second request after an edit |
| Final related suite | 60 passed, no skips; 1.588 seconds |
| First full suite | 106 passed, 3 failed due to historical experiment/source coupling |
| Intermediate full suite | 111 passed, no skips; 2.715 seconds |
| Compatibility follow-up | Initially failed for supported null-prototype records; the same test now passes for candidate, peer and constraints |
| Final full suite | 112 passed, no skips; 2.415 seconds on Windows / Node 24.22.1 |
| Published historical proposal replay | 14 reused, zero new provider requests |

The old snapshot test retains its pair-digest assertion and now additionally
requires the first original quote, exactly one request, explicit invalidation and
no actionable duplicate. Its former requirement to continue calling after an edit
was replaced, not silently discarded. The first failing full run is preserved.

The three historical campaign tests now use built-in uncertain/failure stubs in
the **same budget, checkpoint and lock controller**. Contract mode rejects any
caller-supplied provider callback. Their 7+7 bound, two-failure stop, zero-call
replay, identity rejection and competing-lock checks remain. Two new checks prove
that contract mode cannot accept a provider and that real mode still rejects this
changed product before creating a run or invoking a callback.

Historical replay reads the fixed plan and verifies the published observations
against their recorded hashes and original runner hash. It then tests saved
proposal compatibility with today's reviewer using a zero-call budget. Real
execution still checks the original product hashes and cannot reopen the closed
fourteen-call campaign on this version. The original plan, observations, journals,
limits and results are unchanged. No new AI quality or cost saving is established.

On the unchanged [140-pair offline population](../eval/results/2026-10-31-review-input-compatible-boundaries.json),
there are zero **decided** false merges and false distinct results, but **40
unresolved duplicates and 80 pairs requiring review**. All seven categories and
reverse/evidence checks retain the prior results. This is not 100% accuracy or
measured human effort. Independent holdouts and full semantic queues remain open.

## Snapshot cost at current scale

The [final scale observations](../eval/results/2026-10-31-review-snapshot-final-scale.json) use
100/1,000/10,000 synthetic records, eight uncertain contract callbacks per
invocation and three observations per configuration. These measure current
retrieval/review overhead, not model latency or a before/after speed improvement.
The final measurement uses the tested runtime. The initial observations and
[intermediate verification](../eval/results/2026-10-31-review-input-initial-verification.json)
remain available; they precede the null-prototype compatibility fix.

| Records | Mutable array median | Existing immutable index median | Index construction |
| --- | --- | --- | --- |
| 100 | 20.21 ms | 12.12 ms | 10.69 ms |
| 1,000 | 158.78 ms | 10.30 ms | 70.37 ms |
| 10,000 | 852.26 ms | 87.00 ms | 509.53 ms |

The largest sampled process RSS was 268.79 MiB. These are process snapshots, not
peak allocations or an index-only memory claim. The shared host was also running
JobFlow regression, and early observations overlapped local checks. Index reuse
avoids repeatedly copying and comparing the whole mutable corpus, with explicit
rebuild responsibility. Shortlists remain incomplete and cannot certify novelty.

## Reproduce and roll back

```text
npm run check
node scripts/evaluate-boundaries.mjs --output NEW-boundary-observation.json
node --expose-gc scripts/benchmark-review-snapshots.mjs --output NEW-scale-observation.json
```

The two evaluator destinations must be new files. These commands make no real
model calls. Locally npm was absent from PATH, so its three existing check steps
were executed directly: `node scripts/check-english.mjs`,
`node --test tests/*.test.mjs`, and `node scripts/replay-targeted-followup.mjs`.

No database migration or hosted rollout was performed. An integrating application
must honor `REVIEW_INPUT_CHANGED`, preserve raw evidence/journals and use its own
transactional revision check. To roll back, stop active review work, retain
journals and restore the earlier code through a normal reviewed revert. An older
version lacks this protection: keep asynchronous publication held or use immutable
caller snapshots with a transaction guard. Do not reopen the historical live run.

No UI changed, so no new browser or independent-user acceptance is claimed.
Hosted adaptation, representative independent examples and human review workload
are still separate external verification requirements.

Implementation uses existing platform primitives rather than a new service:
[Node's deep equality API](https://nodejs.org/api/util.html#utilisdeepstrictequalval1-val2-options)
and the [structured clone contract](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm),
checked 31 October 2026. Only the existing two-argument deep-equality operation is
used; no migration to the documentation site's latest Node version is required.
