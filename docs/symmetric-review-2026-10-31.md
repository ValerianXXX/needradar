# Reuse reviewed relationships across pair order: 31 October 2026

Comparing opportunity A with B and later B with A previously requested a second
model answer despite a saved proposal. Reversing a failed or interrupted request
also bypassed its saved status and counted retries under a second digest. Legacy
journals could contain contradictory proposals that produced different results
depending on which opportunity was opened first.

This change applies to the public curated module on
`codex/symmetric-review-cache-20261031`, based on PR #9 at
`2d38a0eb4eeeb8d7d485a59336e8ccb13cdb189a`. Frozen contracts are
`5e92eea6448ed7094d0ba7000bef576ca68dc2b7`; the runtime and evaluator are
`4648be0` (the full commit and file hashes are in the verification receipt).
It changes no hosted application, private source, model/prompt, dependency,
database schema, publication permission or source-rights rule.

## Behavior and compatibility

- Match both existing V1 digests. Source text, constraints and reviewer revision
  must still match. Editing a reviewed field creates a new relationship request.
- Retain original events and quotation order. A reused result carries the current
  `pairDigest`, the original `originalPairDigest` and `originalAttemptId`, and
  `cacheOrientation` (`same` or `reversed`). Only the returned quotation positions
  swap. Original model, elapsed time, usage and unknown cost remain observations
  of the old attempt, never a new charge or a zero-cost claim.
- Validate all applicable saved proposals against their actual source content
  before starting another request. A malformed reverse quotation is rejected
  even when its own pair would be processed later in the queue.
- Compare the latest saved event for each orientation. Agreeing verdicts reuse
  the newer attempt. Different saved verdicts, including same versus uncertain,
  become `MODEL_PROPOSAL_CONFLICT`; both attempt/digest references are returned
  and `reviewProgress.conflictingPairs` counts them. No automatic tiebreak call,
  approval, merge or loss of the conflicting records occurs.
- A newer failed/interrupted orientation is not hidden by an older result. Its
  retry must be explicit; either orientation's digest can identify that retry.
  At most three starts across both directions are allowed. Legacy journals with
  more starts remain readable, but authorize no further call. An identical
  forward/reverse digest is counted only once.
- Existing human decisions, deterministic exact identity and explicit constraint
  rules retain precedence. Missing constraints still prevent a cached positive
  result from becoming a duplicate. Human actions remain caller-authenticated;
  model responses never manufacture them. Returned objects do not edit sources
  or trusted journal history.

The journal format, reviewer revision binding, 512-event/2-MiB file limits and
single-writer lock remain unchanged. Reuse requires the same trusted journal.
Stateless calls or unrelated journals cannot share results. `maxModelCalls` is
still a per-invocation limit, not an account-wide or campaign-wide spending cap.
Hosts must retain approved campaign budgets; this feature does not authorize
rotating journal paths or reopening a closed real-model experiment.

## Evidence and limits

| Observation | Before | After | What it proves |
| --- | --- | --- | --- |
| Frozen 27 contracts | 10 pass, 17 fail, 391.2024 ms | 27 pass, 373.6696 ms | Reverse reuse, metadata, constraints, conflicts, retries, persistence and stale-input behavior; some failures concern newly required metadata |
| Separate Node processes, same file | Two stub calls | One call, zero on reverse | Durable component reuse with one retained start/result pair |
| Fourteen historical real proposals, reversed, zero new calls allowed | Fourteen unresolved | Fourteen reused, seven same/seven different | Compatibility with exact earlier synthetic observations, not a new model experiment |
| Synthetic publication-policy replay of those fourteen | Fourteen REVIEW | Seven SUPPRESS_DUPLICATE, seven PUBLISH recommendations | Pure policy output with explicit synthetic evidence; no actual publication or authenticated workflow |
| Twenty complete per-domain synthetic queues | 848 uncertain-stub callbacks | 424 uncertain-stub callbacks | Eliminate 424 redundant reverse callbacks on these cohorts |
| Same cohort review burden | 848 uncertain rows among 1,008 selected rows | Unchanged | Scheduling improvement does not resolve uncertain needs or measure human effort |
| Full local suite | 151 baseline pass, 1,596.6145 ms | 178 pass, zero skips, 1,513.8371 ms | Regression at this stage; shared-host times are not a speed benchmark |

The final existing fourteen-case forward replay also passes without model calls.
The 27 contract assertions are unchanged after freezing. Tests use actual separate
Node processes and local journal files; callback answers are explicit stubs.
No browser/UI changed. No new Hermes/provider request, independent person,
customer outcome or live hosted product acceptance is claimed. The fourteen
historical proposals were exposed synthetic examples; their original cost and
provider-internal request counts remain unknown.

The evaluator separately inspects all 140 existing lexical queries without
running an encoder or model. It sees 4,480 selected rows, 3,800 ambiguous rows,
1,159 distinct directed content pairs and 1,066 symmetric relationships. All
140 queries have incomplete global coverage under the unchanged top-32 bound.
These are queue counts, not a model-call invoice, a semantic accuracy result or
permission to execute the queue. The previous hybrid retrieval result and the
offline population's 40 unresolved duplicates/80 review pairs are unchanged.

Per-domain cohorts contain the complete small domain-specific comparison sets,
with explicit uncertainty for every stub. They do not complete the global
140-query queue. A global experiment needs a separately frozen retrieval plan,
source/runtime identity, durable aggregate budget, failure handling and receipts;
the earlier fourteen-call campaign remains closed. Independent holdouts, real
operator time/corrections and provider costs remain open.

The [receipt and portable observations](../eval/results/2026-10-31-symmetric-review/verification.json)
retain original failed contracts, both initial scheduling observations, the later
publication-policy comparison, full-check output and source/artifact hashes.
Observation headers taken before committing the implementation retain their
then-current HEAD; their file hashes identify the exact runtime that was measured.
Hosted status in that receipt is a creation-time observation, with terminal
updates recorded in the draft PR.

## Reproduce and integrate

Use the existing Node 20-or-newer setup; this stage was measured with Node
24.22.1 on Windows. No new environment variable or service is required.

```sh
node --test tests/review-symmetry.test.mjs
node --test tests/*.test.mjs
node scripts/check-english.mjs
node scripts/replay-targeted-followup.mjs
node scripts/evaluate-review-symmetry.mjs --output symmetry-observation.json
```

Output must be a new path. The evaluator never loads a provider/command reviewer
and makes no network/model requests. To compare the old implementation, create
an isolated checkout at the base commit above, then run the new evaluator with
`--source-root ../your-baseline-checkout` and a different output path. Source
hashes, Node version and commit are recorded. Do not use the historical real
runner to regenerate these observations.

For product use, keep the existing explicit `reviewerRevision` and trusted
`reviewJournal`/`onCheckpoint`, or `reviewDuplicatesWithJournalFile` configuration.
Display conflict references and original attempt metadata to the reviewer.
Reusing a model proposal is not human approval. Final publication still requires
the host's evidence rights, authentication and transactional revision checks.

## Adoption and rollback

Review this stacked branch after PR #9. Back up trusted journals and compare
conflicting legacy pairs before adoption. There is no format conversion, schema
migration or deployment in this stage; old event bytes and failed attempts stay
intact. The host must not treat a cached cost as a fresh charge.

A normal reviewed code revert to the base restores redundant calls, separate
direction retry accounting and inconsistent legacy conflict handling. Stop
review workers before reverting, retain all observations/corrections, and hold
affected publication decisions for explicit review. Do not erase a journal or
split it into fresh paths to hide failures or restore spending capacity.
