# Evidence clusters and measured boundaries - 29 October 2026

This milestone changes the public curated policy edition only. Its base is
`71e30a70623c065ff538ab3ff7225f22b97acd60`, the unmerged October 27 task branch.
The hosted application and its database were not changed. The new helpers are
library interfaces, not a newly deployed product UI or an authenticated service.

## Problems fixed

- Exact task/persona/outcome identity could fall below a title-weighted threshold.
  In 20 fixed cases, the synchronous API incorrectly missed a duplicate even
  though the asynchronous exact-task path recognized it. Exact identity now
  bypasses that threshold and has priority within a bounded candidate shortlist.
- Non-string task/persona/outcome values could be coerced into matching strings.
  Invalid identity fields remain reviewable and cannot establish equality.
- An ordered pair digest made a human correction disappear in reverse order.
  V1 digests remain valid in either orientation, bound to unchanged source fields.
  Opposite decisions at the same instant require review; a later valid decision
  resolves the conflict. Impossible dates and timestamps without zones are rejected.
- A human `same` proposal cannot override conflicting or missing current constraints
  or malformed identity. The proposal ID and reason remain available; correcting
  the actual source data requires a new content-bound decision.
- Removing URL anchors collapsed different comments. Generic canonicalization
  now preserves fragments; source-specific adapters may supply a proven canonical URL.
- Identical content with conflicting original-author attribution no longer derives
  independence from input order. An explicit original reference can resolve a repost;
  ambiguous groups retain every capture and report unresolved provenance.
- Net evidence-group counts hid a new item when another incoming item joined two
  older groups. New captures, new independent origins and recapture counts are now
  reported separately. Independence is provenance, not supportive demand or validation.

## Interfaces and state

| Interface | Behavior and boundary |
|---|---|
| `createCandidateIndex(drafts)` | Immutable in-memory public-field snapshot, stable IDs, bounded at 10,000 records. Rebuild explicitly when sources change. No new service or vector dependency. |
| `retrieveCandidates(candidate, index)` | Exhaustive at up to 64 records; otherwise bounded lexical candidates, exact identities first. `complete:false` prevents a partial search from proving novelty. |
| `reviewDuplicates(...)` | Exact rules, explicit constraints, valid human decisions, then optional grounded model proposals with a call budget. It never merges source records. |
| `buildReviewClusters(drafts, {humanDecisions})` | Derived conservative groups require a current `same` human review for every cross-pair. An A-B/B-C chain cannot hide A-C conflict or an unreviewed A-C pair. |
| `recordClusterSplit(drafts, options)` | Returns additional `different` pair decisions for the requested partition. Append to the journal; retain original opportunities and previous journal entries. |
| `addEvidence(...)` | Monotonic `last_seen` and `last_new_independent_evidence`, new groups/origins, counterevidence and validation history. Reposts do not refresh the independent-evidence clock. |
| `assessOpportunityFreshness(draft, {asOf})` | Explicit, deterministic review scheduling: FRESH / AGING / STALE / UNKNOWN / CLOCK_SKEW. Default 30/90-day thresholds are policy choices, not calibrated demand decay. |

Cluster views are deterministic conservative partitions, not a mathematically
optimal clustering or proof that all singletons are different. Work bounds leave
groups separate and expose the unresolved checks. Models cannot create human
journal entries; an integrating application must authenticate and authorize the
person writing them. This library does not implement that application's login.

Freshness does not delete evidence, auto-publish, lower a business-validation
status or infer that an old interview became false. Legacy records with no
independent-evidence timestamp stay UNKNOWN. Independent-origin counts include
counterevidence when assessing provenance; publication support still excludes
counterevidence through the existing evidence policy.

## Frozen comparison

The [fixture pack](../eval/boundaries-v2/cases.json) contains 140 pairs, 20 per
required category, based on 20 authored domains. Twelve domains (84 pairs) are
development data; eight (56 pairs) are designated held-out domains. The same coding
assistant authored the seeds and common transformations: this is **not** an
independent blind benchmark, market dataset, or natural prevalence estimate.
The pack was hashed before changing product code; its generation is reproducible
from [seeds](../eval/boundaries-v2/seeds.json) and the fixture builder. Chinese text
is stored as Unicode escapes to preserve the repository's English-only artifacts.

| Category | Pairs | Offline correct duplicate proposals | Offline decided distinct | Offline unresolved |
|---|---:|---:|---:|---:|
| Same demand, different evidence | 20 | 20 | 0 | 0 |
| Same demand across English and Chinese | 20 | 0 | 0 | 20 |
| Low-overlap paraphrases | 20 | 0 | 0 | 20 |
| Same persona, different task | 20 | 0 | 0 | 20 |
| Same task, conflicting constraints | 20 | 0 | 20 | 0 |
| Reposts and repeated captures | 20 | 20 | 0 | 0 |
| Nearby distinct tasks | 20 | 0 | 0 | 20 |

Both [baseline](../eval/results/2026-10-29-boundaries-baseline.json) and
[final offline](../eval/results/2026-10-29-boundaries-offline.json) runs have zero
false `same` proposals and zero duplicates explicitly decided `different`.
However, 40 expected duplicates remain unresolved and **80/140 pairs require
semantic adjudication**. Uncertainty is not a correct answer. These results do not
show improved general semantic accuracy; the synchronous exact-identity misses
fell from 20 to zero. All 140 offline reverse comparisons agreed, and all 20
repost-case independent-evidence expectations matched.

### Actual Hermes pilot

The [12-pair selection](../eval/boundaries-v2/pilot.json) was fixed before responses:
invoice, support and research domains, four ambiguous categories each, six
expected duplicates and six distinct tasks. Twelve actual adapter requests took
96.067 seconds; recorded per-request times were 7.300-8.965 seconds. The existing
Hermes route was `gpt-5.6-sol` / `openai-codex`, Python 3.11.15, Hermes revision
`afe53708ee7400919ae3e17a6dde9b02629e5c87`, verified 29 October 2026.

| Same selected 12 pairs | False same | Duplicate decided different | Unresolved duplicates | Unresolved pairs | Correct duplicate proposals | Correct distinct |
|---|---:|---:|---:|---:|---:|---:|
| Offline | 0 | 0 | 6 | 12 | 0 | 0 |
| Actual Hermes responses | 0 | 0 | 0 | 0 | 6 | 6 |

This is a bounded correctness observation, not a confidence interval or a quality
claim about the other 128 pairs. Zero unresolved pairs does not mean zero operator
work: merge proposals and source-policy decisions still need the appropriate
application controls. No tools were exposed or called. Provider-internal request
count, token usage and billed cost were unavailable; they remain `null`.
No model upgrade, paid service activation or OpenClaw installation occurred.

The [live receipt](../eval/results/2026-10-29-boundaries-hermes.json) and
[request/response journal](../eval/results/2026-10-29-boundaries-hermes.requests.jsonl)
preserve the observation, including exact synthetic quote evidence. Two final
deterministic guards were added after that process loaded its source. A
[same-output replay](../eval/results/2026-10-29-boundaries-replay.json) confirms the
final local decisions without repeating model calls. It is not a second live test.
Reverse model agreement was not tested; the live metric is `null`.

The [official Hermes repository](https://github.com/NousResearch/hermes-agent)
was checked on 29 October 2026; local revision and runtime inspection establish
what this experiment used. This milestone makes no claim that this is the latest
model or Hermes version. It adds no third-party implementation code or dependency.

### Retrieval scale: speed is not recall

[Before](../eval/results/2026-10-29-retrieval-before.json) and
[final](../eval/results/2026-10-29-retrieval-after.json) use two fixed difficult
queries, each repeated three times at each size. The true duplicate is placed
after same-domain distractors. Times are medians of six query measurements.

| Records | Baseline uncached ms | Final uncached ms | Final cached ms | One-time index build ms | Cached post-query RSS MiB / heap MiB |
|---|---:|---:|---:|---:|---|
| 100 | 13.81 | 12.55 | 2.59 | 11.97-14.43 | 67-70 / 6-9 |
| 1,000 | 115.52 | 90.15 | 17.18 | 82.34-124.26 | 105-115 / 12-27 |
| 10,000 | 1,121.73 | 779.26 | 114.98 | 973.15-1,113.57 | 262-328 / 69-89 |

**Both difficult targets were absent from the top 32 in every size/path.** Cached
tokenization reduces repeated work but does not repair cross-language or
low-overlap candidate recall. At up to 64 records, exhaustive candidates avoid
this shortlist loss, still subject to the explicit semantic-call budget.
Larger incomplete searches must remain REVIEW; do not interpret zero selected
duplicates as a publication clearance. A separately evaluated multilingual
embedding or controlled expansion is still needed before claiming scalable recall.

Measurements share a host with a JobFlow regression run. They are descriptive,
not an isolated speed guarantee. RSS/heap are process snapshots, not peak memory
or per-query allocations; the cache has a real memory and rebuild cost. No large
vector database has been introduced to hide the recall problem.

## Run, verify and integrate

```sh
npm run check
node scripts/evaluate-boundaries.mjs --output boundary-results.json
node --expose-gc scripts/benchmark-retrieval.mjs --output retrieval-results.json
node scripts/replay-boundary-pilot.mjs --receipt eval/results/2026-10-29-boundaries-hermes.json --journal eval/results/2026-10-29-boundaries-hermes.requests.jsonl --output replay-results.json
```

Use a fresh output path. Default evaluations and replay make no model calls.
If npm is unavailable, the complete check is `node scripts/check-english.mjs`
followed by `node --test tests/*.test.mjs`. Existing Node 24.19.0 was used here;
the declared Node >=20 compatibility range was not tested as a runtime matrix.

For an intentional new pilot, configure the existing command adapter as in
[the earlier guide](dedup-upgrade-2026-10-27.md#run-and-configure), then run:

```sh
node scripts/evaluate-boundary-pilot.mjs --command --output new-pilot.json
```

`NEEDRADAR_ALLOW_COMMAND=true` plus a trusted executable/argument array is required.
Never derive that command from an opportunity or model. On Windows with WSL, use
`--cd /tmp` and the actual installed Hermes Python with `-I`. The prior attempt to
locate a `.venv` directory failed before any model request; the verified installation
uses `venv`. No installation was changed. The script reserves its receipt/journal
before requests, caps adapter attempts at 12, and records failures without automatic
paid reruns. Only the fixed synthetic public descriptions enter stdin. The existing
provider may be cloud-backed; real/private observations must not be substituted
without the relevant data authorization. Optional runtime metadata contains no keys.

Integrators retain the original opportunities and review journal, build a snapshot,
and call `reviewDuplicates(candidate, index, options)`. Cluster input is the original
opportunity list plus authenticated human decisions. Rebuild snapshots after edits;
a changed content digest invalidates prior decisions instead of approving new facts.

## Verification, release and rollback

The recorded baseline check passed 20 tests. The final check and exact source hashes
are in [verification](../eval/results/2026-10-29-boundaries-verification.json).
Regression cases cover malformed identities, ambiguous provenance, input reversal,
repeated decisions, same-time conflicts, transitive cluster contamination, explicit
splits/relinking, preserved originals, shortlist truncation, clocks and source gates.
There is no UI change, live hosted integration, independent human acceptance or
market result in this milestone. Earlier hosted demonstrations remain separate.

No database migration or production deployment is required for this public library
change. The index is disposable. Rollback can stop using the added helpers and
rebuild prior cluster views from retained source records/journal; a split is reversed
through new explicit current-content reviews, never by deleting evidence. A future
hosted adaptation must snapshot source data, replay both policies, review changed
groups, validate authenticated writes and retain the previous application release.
Publishing or deploying that adaptation requires its own approval.

Remaining work: multilingual candidate recall beyond the small exhaustive set,
an independently authored natural-language holdout, measured token/cost reporting,
broader model/provider comparison only when budget and expected value justify it,
and a separately reviewed deployment-source integration. These remain open rather
than being counted as completed by this draft PR.
