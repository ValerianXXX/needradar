# Targeted semantic follow-up - 30 October 2026

This follow-up tests the seven translated duplicate targets that exceeded the
earlier first-invocation review budget, with seven same-domain nearby-distinct
controls. It uses the public curated edition, exposed synthetic descriptions and
the existing configured Hermes route. No hosted source or deployment is involved.

## Frozen scope and execution

The [protocol](../eval/targeted-followup-v1/plan.json), runner and budget contracts
were committed at `2012a45a4c4f1f99c8d61f1bbd1bdfae4d6633f8` before live calls.
The plan binds the original 140-pair corpus hash, the prior retrieval observation
and unchanged product/reviewer source hashes. It selects all seven prior
over-budget duplicate targets, interleaved with their nearby-distinct controls.
Gold labels, category names and selection rationale are not sent to the model.

This is **direct adjudication of preselected pairs**, not continuation through all
32 retrieved neighbors for each query. Selecting the targets avoids spending
dozens of extra calls on intervening distractors, but does not establish that a
full queue finishes within fourteen calls. The earlier retrieval ranks and
incomplete-retrieval publication gates remain unchanged.

The live plan permits at most fourteen reserved adapter attempts across the run,
with seven new attempts per explicit invocation. Two failed adapter/grounding
results stop further calls, including after restart. There is no automatic retry.
An interrupted start remains uncertain. A third, read-only-model replay permits
zero new calls and checks proposal reuse through the actual file adapter.

Each invocation has an exclusive run lock. Product, runner, protocol and declared
runtime changes reject continuation. The original append-only proposal journal
still binds pair content and reviewer revision; the experiment keeps a separate
request/response audit. A lock left by a crash needs operator ownership review,
not automatic deletion. These are bounded local-process controls, not distributed
transactions, power-loss guarantees or an account-wide spending cap.

Before execution, the locally installed runtime was checked without reading or
printing credentials: Hermes `afe53708ee7400919ae3e17a6dde9b02629e5c87`, Python
`3.11.15`, configured `gpt-5.6-sol` / `openai-codex`. This is an observed existing
route, not a claim that it is the newest model. No model or dependency is changed.
The adapter exposes no tools and checks zero tool calls. Provider-internal
requests, tokens, billed costs and human review time remain unknown.

## Observed results

The two explicit Node invocations made seven requests each. The second reused
the first seven proposals. A third process replayed all fourteen with zero new
calls. All fourteen responses passed the existing exact-quotation contract and
matched the frozen synthetic labels; the coding assistant also inspected the
paired quotations and the specific differences. This is not independent review.

| Selected fourteen pairs | Offline rules | Actual Hermes proposals |
| --- | ---: | ---: |
| False merge proposals | 0 | 0 |
| False distinct proposals | 0 | 0 |
| Unresolved duplicate pairs | 7 | 0 |
| All unresolved pairs | 14 | 0 |
| Same proposals | 0 | 7 |
| Different proposals | 0 | 7 |

No records were merged or deleted. Zero unresolved model proposals does not mean
zero human work: review/merge authority and publication requirements remain.
The two measured invocations total **62.809 seconds**. Their fourteen adapter
measurements total 61.030 seconds, with a 4.303-second median and 3.870-4.936-second
range. These include local adapter overhead and share a host with other tests.
No before/after latency improvement, billed saving or population accuracy gain is
claimed. There were no adapter failures and no observed tool calls.

The [verification receipt](../eval/results/2026-10-30-targeted-followup-verification.json)
binds both invocation observations, zero-call replay, original local byte hashes
and published LF hashes. The [request/response audit](../eval/results/2026-10-30-targeted-followup-requests.jsonl)
contains only synthetic public fields and validated grounded responses. Original
local artifacts remain unchanged; the published proposal journal uses ASCII JSON
escaping for the repository's English-source convention without changing values.
All 74 Node tests passed, including the three new budget/restart contracts.
The separately executed portable offline replay also passed.

## Reproduce without another paid run

Normal checks need only the declared Node runtime:

```powershell
node --test tests/*.test.mjs
node scripts/check-english.mjs
node scripts/replay-targeted-followup.mjs
```

The last command validates the published observations, hashes and all fourteen
saved proposals with zero model calls and no writes. It does not need a local
Agent or the original run directory.

The new contracts exercise an actual local proposal journal with injected
reviewers: seven plus seven calls, zero-call replay, a closed budget on another
continuation, stop after two failures, redacted errors, runtime changes and a
competing invocation lock. These contract reviewers are not semantic observations.

For a separately authorized live run, first inspect the frozen protocol and
configure `NEEDRADAR_ALLOW_COMMAND`, `NEEDRADAR_REVIEW_EXECUTABLE`, the trusted
argument array and the allowlisted `NEEDRADAR_REVIEW_RUNTIME` metadata described in
`.env.example`. Keep the existing Agent installation and credentials outside this
repository. The review command receives only the selected public fields on stdin.

```powershell
node scripts/evaluate-targeted-followup.mjs start --command --run-dir ..\approved-followup-run
node scripts/evaluate-targeted-followup.mjs continue --command --run-dir ..\approved-followup-run
node scripts/evaluate-targeted-followup.mjs replay --run-dir ..\approved-followup-run
```

The run directory must be outside this checkout, with an existing parent. `start`
refuses an existing directory. Do not create another directory to evade an
exhausted protocol budget; a new trial needs a new explicit plan. Replay requires
the same frozen runner and product source and no live command configuration.
Original observations are never overwritten. Local journals are model proposals,
not authenticated human corrections or provider billing receipts.

## Interpretation and remaining work

Report false merge proposals, false distinct proposals, unresolved duplicates,
all unresolved pairs and provider attempts separately. An `uncertain` result is
retained in the denominator. A decrease in unresolved model proposals is not a
measurement of human time saved; no merge happens automatically.

These selected cases are biased toward an already known retrieval limitation.
Two domains retain their historical `held_out` label for traceability, but their
cases are now exposed and must not be presented as a fresh blind evaluation.
The previous 140-pair aggregate, twelve-pair real pilot and offline continuation
replay remain distinct observations. Do not overwrite them with this subset.
Independent natural examples, human correction workload and full-queue execution
still need separate evaluation. No customer adoption or business result is inferred.

The task-specific comparisons and separate failure measures follow the
[official evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices),
checked October 30. Only the methodology is used; this experiment does not depend
on a hosted evaluation service or introduce an SDK.

## Rollback

This stage adds an opt-in evaluation runner, tests, protocol and observations. The
product deduplication/prompt/retrieval code and deployment are unchanged. No data
migration or release is needed. Stop the runner before reverting its source and
retain the evidence directory and journals. Do not relaunch against a fresh path
to repeat unknown or completed provider attempts.
