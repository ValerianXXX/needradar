# Durable review budgets: 31 October 2026

The existing `maxModelCalls` limits one invocation. It resets when another
opportunity or process starts. The existing V1 proposal journal also has a
512-event limit, so it cannot hold the entire selected global queue. A host
using several proposal journals needs one aggregate budget shared by all of them.

This change adds an optional `campaignBudget` to
`reviewDuplicatesWithJournalFile`. It reuses the repository's file locking,
bounded reads, atomic replacement and V1 proposal continuation. Existing callers
without the option retain their behavior and limits. This is a public curated
module; it does not change the hosted application or private deployment source.

## Behavior

- One operator-selected budget file binds a frozen-plan digest, reviewer
  revision and total ceiling. Changing any on resume fails before dispatch.
- Acquire the campaign lock before a proposal-journal lock. Cooperating callers
  using different proposal files cannot reserve the same remaining allowance.
- Persist a `STARTED` event before the potentially billable reviewer callback.
  Failed callbacks, interrupted reservations and ambiguous outcomes still count
  against the ceiling. Cache reuse adds no reservation or duplicated old cost.
- Apply both limits: the existing per-invocation pacing and the stored total.
  Exhaustion leaves new relationships for review without starting empty retries.
- Preserve `RETURNED` versus `FAILED` callback observations. A returned callback
  can still fail the existing semantic/quotation validator; it is not a successful
  task, a human decision, a merge or permission to publish.
- Budget persistence errors cancel further dispatch and propagate across the
  semantic layer's normal reviewer-error handling. They cannot appear as a
  completed campaign. Atomic replacement and original error codes remain in use.
- Return `campaignProgress` with reservations, remaining allowance, returned,
  failed and unfinished callbacks. Known cost is a subtotal. Any unknown cost
  keeps `totalCostUsd` null, including a process that exits after reservation.

The budget is a ceiling on **reviewer callbacks**, matching the existing API's
`maxModelCalls` unit. It is not a dollar ceiling, an account-wide quota or proof
of provider-internal request/retry counts. Provider adapters must obey their own
approved settings. The budget file is trusted operator state, not an authorization
source. A caller must use the same file across every planned shard; this module
does not prevent an operator from selecting a different file or restoring an old
valid filesystem backup. Models never choose paths, policy or approvals.

The new file is bounded to 2 MiB and at most 4,096 reservations. Terminal-event
space is reserved before dispatch. Existing pair journals retain their 2-MiB,
512-event and three-attempt limits. Neither format is silently migrated. An
existing V1 cache can be replayed under a zero-call budget without new calls.

Crash locks are deliberately left for ownership review. Production code does
not break them by age or PID. The native recovery test exits an owned Node child
at code 73, checks both real locks and the saved reservation, then explicitly
removes only those fixture locks after the child has exited. Subsequent work
still has no restored allowance. It does not grant a production lock override.

## Reproduction and interpretation

The existing baseline passed 178 tests. Eighteen new contracts were committed
at `d5e6430` before implementation and all failed on the old API; several also
require newly returned progress metadata. Those same 18 pass after implementation.
Three additional native recovery/input-history checks pass, and the complete
local suite passes **199 tests with zero skips**. The first implementation is
`73045c3`; exact commits, times, source hashes and retained failures are in the
[verification receipt](../eval/results/2026-10-31-campaign-budget/verification.json).

The separately frozen
[global queue plan](../eval/boundaries-v2/campaign-budget-plan.json) has all
140 existing synthetic queries and 4,480 selected rows, with a ceiling of 300
explicit uncertain-stub callbacks. Its live-provider authorization is zero.
The same evaluator runs against the old and new source roots, using real files
and one V1 proposal shard per symmetric relationship. All selected rows are
processed, including cache reuse and rows left pending when the budget is spent.
The receipt contains both actual observations and their comparison.

| Global synthetic observation | Before | After |
| --- | --- | --- |
| Queries / selected rows processed | 140 / 4,480 | 140 / 4,480 |
| Explicit uncertain-stub callbacks | 1,066 | 300 |
| Callbacks above the stated 300 ceiling | 766 | 0 |
| Reused proposal rows | 2,734 | 843 |
| New proposal rows deferred by the budget | 0 | 2,657 |
| All uncertain rows requiring review | 3,800 | 3,800 |
| Queries with incomplete original retrieval | 140 | 140 |
| New provider calls | 0 | 0 |

The final aggregate record has 300 reservations, 300 returned callbacks, no
unfinished reservations and 300 unknown-cost observations; total cost remains
null. The after run created 300 pair-journal files and left no owned locks.
Observed local elapsed time increased from 24.211 to 59.254 seconds. These single
Windows-host runs include real disk persistence and stub execution; they are
not a provider-latency benchmark. The added durability has measurable local I/O
and validation overhead. No runtime acceleration is claimed.

The earlier fourteen-call real-model campaign remains closed. No encoder or
provider adapter is imported by this evaluation. Callback reductions are not
measured model-cost savings, semantic accuracy or reduced human correction time.
The existing top-32 retrieval is still incomplete for all 140 queries; completing
its selected rows does not cover all possible global pairs. Uncertain stubs
cannot establish false-merge or missed-merge improvements. The original offline
population's 40 unresolved duplicates and 80 review pairs remain unresolved.

## Configuration and operation

The caller supplies `campaignBudget: { path, scopeDigest, maxModelCalls }` alongside
the existing explicit `journalPath` and `reviewerRevision`. Use a SHA-256 digest of
the frozen inputs, retrieval policy and intended campaign as `scopeDigest`.
Retain that plan so a reviewer can reconstruct its meaning. The module checks
digest equality on resume; the host is responsible for verifying actual input
membership in the plan. The fixed evaluator checks every selected pair against
its frozen query/corpus digests before executing the queue.

```js
const result = await reviewDuplicatesWithJournalFile(candidate, existing, {
  journalPath: operatorSelectedPairFile,
  reviewerRevision: frozenReviewerRevision,
  reviewer,
  maxModelCalls: 8,
  campaignBudget: {
    path: operatorSelectedCampaignFile,
    scopeDigest: verifiedFrozenPlanSha256,
    maxModelCalls: 0, // Safe replay only; this example authorizes no new calls.
  },
});
```

Create the parent directory explicitly under the host's private application data
area. Do not accept these paths from opportunity text or a model. Select an
approved nonzero ceiling before creating a real-call campaign; a stored zero
ceiling cannot be silently increased. A new file is not approval to reopen a
closed experiment. Human correction and publication still use their existing
authenticated host boundaries.

Run the existing `npm run check` and these optional offline checks:

```sh
node --test tests/campaign-budget.test.mjs tests/campaign-budget-recovery.test.mjs
node scripts/evaluate-campaign-budget.mjs --output reports/new-global-budget-observation.json
```

The second command uses only the fixed uncertain stub and refuses to overwrite
its output. An optional `--source-root` selects a prepared source checkout for a
before/after comparison. Do not regenerate the frozen plan to hide a changed
population. Model credentials, a vector database and new dependencies are not
required.

## Maintenance, remaining work and rollback

The shared file helper is extracted from the repository's existing
[MIT-licensed implementation at the base revision](https://github.com/ValerianXXX/needradar/blob/f2f00aeaad3b8ad16c81dd81a1572aa028b53582/src/review-journal-file.mjs).
Its lock ownership, bounded read and atomic replacement behavior is preserved
and covered by the existing file contracts. No external implementation or new
dependency was added. The new budget events are separate from opportunity data
and original evidence.

Full hybrid/global semantic validation, independent holdouts, actual correction
effort, attributable provider costs, hosted transactional acceptance and approved
deployment remain open. No UI changed and no independent-person or customer
outcome is claimed. Hosted CI belongs to its own exact delivery and is tracked
separately from local passes in the PR.

A reviewed source rollback requires no opportunity-data migration. Stop new
dispatch first, preserve all budget and proposal files and ownership records,
and keep the aggregate policy enforced by the host. Older code ignores the new
option and would restore per-invocation-only budgeting; therefore it must not
continue a real-call campaign while relying on that option. Do not delete or
reset a budget to regain allowance. Publication and production deployment still
require separate approval.
