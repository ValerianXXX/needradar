# Source evidence and returned-view isolation

Observed October 31, 2026. Runtime `cc707982859f9dad7c3435ce500e3859f25e0192`,
based on `5f052b552b36f32d48ae36a93b4dcf25f2734ef6` (draft PR #7).
This change applies to the public curated library. No hosted application, private
source, database, deployment or UI was read or changed for this milestone.

## Reproduced behavior

`buildReviewClusters` returned source capture objects inside its derived evidence
summary. An integrating editor could change a preview quote, metadata or rights
field and inadvertently change the original source record. Source edits also
rewrote already-returned views, erasing the distinction between observations.

The fixed synthetic workflow has three attributed source records under one
source policy. One record has `rightsApproved: false`; publication initially
returns **HOLD** for insufficient qualifying independence. Changing that field
only in the returned preview changed the source record and the next publication
decision to **PUBLISH** before the repair. Afterwards, the original flag remains
false and publication remains **HOLD**. This is a real call to the local library
with synthetic data, not evidence of unauthorized publication in the live product.

`recordValidation` cloned the opportunity but then replaced its history with a
shallow array of caller-owned events. Editing an earlier event in the returned
transition could rewrite the previous state's history, and vice versa. The
fixed exercise retains the original `INTERVIEWED` event after a caller edits its
returned copy; it does not create or authenticate a real interview.

## Changes and boundaries

Clone the complete cluster return value after grouping and clone the complete
validation transition after composing its event history. Keep internal capture
identity in the provenance algorithm, where arrival/group calculations depend on
it. Detaching the finished result preserves those algorithms and reference
relationships within each returned view without sharing objects with the source.

Public function arguments, schemas, event IDs, pair digests, grouping limits,
explicit constraints, review precedence, split/relink behavior and independent
evidence counts remain unchanged. There is no persistence migration or new
dependency. Existing cloneable data records remain the supported interchange.

Returned values are detached **editable snapshots**, not authenticated, frozen or
tamper-proof records. The integrating application must still authorize source
edits and human decisions, persist journals, and recheck authoritative data in its
publication transaction. Passing an intentionally modified copy as authoritative
input is outside this isolation guarantee. No model can authorize a human event.

## Verification

The unchanged predecessor had 112 passing tests and
[passing delivery CI](https://github.com/ValerianXXX/needradar/actions/runs/41211718343).
That baseline was reused before the new focused reproduction.

- Eight contracts frozen at `f6859d6`: two passed and six failed before repair;
  all eight pass unchanged afterwards, 165.1421 ms. They cover edits in both
  directions, nested source fields, rights/publication, split views and two
  already-correct detachment paths. No previous assertion was removed.
- Complete current suite: **120 passed, no skips, 1,981.5406 ms** on Windows /
  Node 24.22.1. English checks and the same fourteen saved semantic proposals
  pass. The latter makes **zero new model requests**.
- `npm` is unavailable in this shell. The attempted wrapper did not execute its
  checks. Its three declared commands were then run directly with Node and
  checked independently; the missing wrapper is not counted as a passing run.
- A fresh offline 140-pair run retains zero decided false merges and zero
  duplicates explicitly decided different, but **40 duplicate pairs remain
  unresolved and 80 pairs need review**. This repair does not establish improved
  semantic accuracy or reduced human workload.
- An actual local before/after workflow preserves explicit split, relinking,
  original source records and the original human journal. Existing full-suite
  contracts also retain historical replay.
  The same inputs and all nine scaled result-content hashes match across versions.

[Verification receipt](../eval/results/2026-10-31-view-isolation-verification.json),
[before workflow](../eval/results/2026-10-31-view-isolation-before.json),
[after workflow](../eval/results/2026-10-31-view-isolation-after.json) and
[current offline population](../eval/results/2026-10-31-view-isolation-boundaries.json)
preserve measurements and source hashes. Failure logs remain available through
the verification receipt. No new model, paid service, marketplace evidence or
independent participant was used.

## Cost of detachment

Each size has three observations in a separate process for each revision. Inputs
form reviewed three-member groups, with 99 / 999 / 9,999 synthetic human events.
The same host is running a separate JobFlow regression. Medians are descriptive,
not an isolated speed guarantee; this does not measure a worst-case dense graph.

| Records | Before median ms | After median ms | After heap snapshot MiB | After RSS snapshot MiB |
| --- | ---: | ---: | ---: | ---: |
| 100 | 23.31 | 25.71 | 7.3–7.5 | 50.8–51.3 |
| 1,000 | 317.02 | 311.16 | 18.1–24.4 | 70.9–87.4 |
| 10,000 | 3,455.66 | 3,605.12 | 117.0–122.5 | 236.2–249.0 |

Memory values are post-call process snapshots, not peak usage, per-call
allocations or additional memory attributable solely to cloning. The extra copy
has a real cost; no performance improvement is claimed.

## Run and integrate

From this draft checkout:

```sh
node --test tests/evidence-view-isolation.test.mjs
node scripts/check-english.mjs
node --test tests/*.test.mjs
node scripts/replay-targeted-followup.mjs
node --expose-gc scripts/evaluate-view-isolation.mjs --output path/to/new-observation.json
```

The last command accepts optional `--module-root path/to/trusted-checkout` for a
matching baseline run. It executes that checkout's library, creates a fresh output
file, generates only fixed synthetic data and makes no model/network call. Keep
partial evidence after an error; do not overwrite an earlier observation. The
runner records actual source hashes and a commit; a dirty checkout is a separate
working-tree observation and must not be presented as an exact committed runtime.

No new environment setting or account configuration is required. Test on an
isolated copy before adapting any real host. Deployment source and authorization
remain separate from this public repository.

A normal reviewed revert restores the prior implementation and its shared-object
defects. Stop affected editors/review workers first, preserve source/journal
backups and retain all evidence. No production rollback was performed. Full
semantic queues, independent holdouts, actual operator effort and hosted
integration remain open.
