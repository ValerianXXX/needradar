# Reviewed attribution corrections without invented demand

Scope: the public curated edition, 31 October 2026. This is an opt-in library
change on an unmerged task branch. It does not update the hosted application,
publish an opportunity, authenticate a reviewer or establish market demand.

## Problem and resulting behavior

At baseline `b3f28694c3aad17ff1acd7c6801d2aaf7a6defaa`, arrival accounting could
mistake relabeling a known author for both a new source and a lost source. Its
prior-capture check used JavaScript object identity, which did not survive a
save/load cycle. Counting surviving output groups alone could also let a split
hide the loss of an unrelated old group.

The comparison now uses stable capture identities and typed author/organization
attribution. It matches retained independent units one to one with iterative
augmenting paths; overlapping corrections cannot claim that two old groups both
survived through one group. Capture grouping, comment anchors and source rights
remain governed by the existing provenance rules. No source observations are
deleted or merged by this matching operation.

| Boundary | Baseline | Current behavior |
| --- | --- | --- |
| Existing capture gets a corrected known author | Could report a new arrival and a lost unit | Resolve existing attribution; no arrival |
| Previously saved capture is deserialized | Object reference no longer identifies it | Match stable capture identities |
| One old unit splits while another is lost | Split could mask loss | Account for retained units one to one |
| Correction groups three sources into one known organization | No explicit reviewed correction API | Preserve sources; revise independence and require recency review |
| Stale or repeated correction/undo | No correction contract | Reject without changing the supplied state |
| Correction survives JSON save/load | Early implementation accepted lossy values | Reject lossy inputs; normal JSON records retain valid history |

`independentEvidenceChange(before, after)` retains the result fields `added`,
`resolvedExisting` and `consolidatedOrLost`. The second now includes known-source
relabeling as well as unknown-source resolution. Legacy callers passing a third
argument still run in JavaScript; reference identity no longer determines the
answer. An unresolved or conflicting attribution does not become independent
merely because a repost has a known author.

## Opt-in correction interface

The new [module](../src/evidence-corrections.mjs) returns a proposed, detached
opportunity state. For a current opportunity containing evidence keys `a` and `b`:

```js
import {
  evidenceCorrectionDigest,
  correctEvidenceAttribution,
  revertEvidenceAttribution,
} from './src/evidence-corrections.mjs';

const corrected = correctEvidenceAttribution(current, {
  expectedDigest: evidenceCorrectionDigest(current),
  evidenceKeys: ['a', 'b'],
  patch: { originGroup: 'reviewed-shared-organization' },
  actor: authenticatedReviewerId,
  reason: 'The reviewed original sources identify the same organization.',
  recordedAt: '2026-10-31T12:00:00Z',
});

const restored = revertEvidenceAttribution(corrected, {
  expectedDigest: evidenceCorrectionDigest(corrected),
  eventId: corrected.provenance_corrections.at(-1).id,
  actor: authenticatedReviewerId,
  reason: 'Withdraw that attribution after reviewing conflicting source notes.',
  recordedAt: '2026-10-31T13:00:00Z',
});
```

Only `authorGroup` and `originGroup` are editable. A nonempty string sets a token;
explicit `null` clears one. Every selected evidence key must exist; all captures
with that exact key are selected. Other linked keys do not silently join the
selection. Quotes, evidence keys, source accessibility, rights and personal-data
flags cannot be patched through this API. Actor, reason and monotonically
increasing valid event time are required. Empty/no-op patches are rejected.

The whole opportunity must be losslessly JSON-persistable plain data. Undefined
values, negative zero, nonfinite numbers, cycles, getters, symbols, hidden
properties, sparse arrays, functions and nonplain objects are rejected. Check
legacy data before opting in; do not silently discard source metadata to make it
pass. Null-prototype records are accepted. Digests sort object keys and survive
ordinary JSON serialization.

Each correction appends a schema-versioned event with the actor, reason, time,
input digest, before/after observation digests and complete selected snapshots.
Snapshots, returned sources and prior states do not alias each other. This is
content-addressed local history, **not a cryptographic signature or a trusted
audit service**. The host must authenticate the actor, retain server-owned
history, and compare the current revision again in the transaction that saves
the result. A caller-provided actor string is not authorization. A digest check
in this pure function alone cannot prevent concurrent database writes.

Undo applies only to the latest correction, while its observation digest still
matches. Later captures, rights changes or source edits require a new review of
the current state. Undo adds another event and retains the original correction;
older/repeated undo is rejected. It restores original source values and counts
but does not automatically recertify recency invalidated by consolidation.
Corrections and undo create zero arrivals, preserve observation dates and
business-validation history, and do not count as publication approval.

## Reproducible evidence

The [verification receipt](../eval/results/2026-10-31-provenance-corrections/verification.json)
binds source revisions, normalized file hashes and portable original logs. All
observations below are synthetic/local on Windows with Node v24.22.1. No new
dependencies, provider configuration or model calls were introduced.

| Frozen check | Before | After |
| --- | --- | --- |
| Original suite before modification | 120 passed | Retained in the final suite |
| Initial 22 correction contracts | 1 pass, 21 failures | 22 passed |
| Seven additional fault/source/undo contracts | 27 pass, 2 failures across all 29 | 29 passed |
| Two additional JSON-persistence contracts | 30 pass, 1 failure across all 31 | 31 passed |
| Final full suite at `5d24da6a5b564c299c515ceacc69556bde338ac4` | Not a baseline comparison | 151 passed, zero skipped, 1,565.663 ms |

Of the initial 21 failures, nine were wrong results from existing delta behavior
and twelve were unavailable new API contracts. They are not 21 production
incidents. The later two failures exposed malformed history and hidden metadata;
the final failure exposed lossy JSON values. Original failing logs are retained.
No expectation was relaxed to obtain the passing result.

The executable walkthrough preserves three original captures, corrects their
shared organization (three independent units become one), and undoes the
correction (three units return). Both changes add zero arrivals and preserve
`last_seen` and the last independent-arrival timestamp. Validation stays
`UNVALIDATED`; the restored count does not restore a verified freshness claim.
A stale edit is rejected. This is a pure-library synthetic workflow, not a UI,
hosted database, independent-person or complete business acceptance test.

The matched scale comparison uses 100, 1,000 and 10,000 observations per snapshot,
three scenarios and three repetitions per revision. Timing includes both
provenance summaries and the delta; memory observations are heap/RSS snapshots,
not peaks. At 10,000 records, medians in milliseconds were:

| Scenario | Before | After | Correctness result |
| --- | ---: | ---: | --- |
| Unchanged sources | 3,408.68 | 3,425.81 | Both report zero changes |
| Relabel each author | 3,404.58 | 3,413.25 | 10,000 invented arrivals/losses become zero; 10,000 resolutions |
| Overlapping correction chain | 3,363.80 | 3,368.91 | 5,000 invented arrivals/losses become zero; 5,000 resolutions |

There is no measured speed benefit. The shared-host snapshots are not capacity
limits or a broad performance guarantee. Benchmark revision `fd0fbf7` precedes
the final JSON-input repair; all modules used by that benchmark are byte-identical
at the final runtime revision. The receipt checks this rather than relabeling the
older run as a new run.

The unchanged offline semantic evaluation still has 140 pairs: zero decided
false merges, zero decided missed merges, **40 unresolved duplicates and 80 pairs
requiring review**. Fourteen saved Hermes proposals also pass a zero-call replay.
That selected historical pilot is not the full population; its original cost is
unknown. No reduction in real reviewer time, semantic error or model cost is
measured in this milestone.

## Running and integrating

The project declares Node 20 or newer; this observation used v24.22.1. From this
checkout, use fresh output paths:

```bash
npm run check
node scripts/demo-provenance-correction.mjs --output correction-demo.json
node --expose-gc scripts/benchmark-provenance-corrections.mjs --baseline-root /path/to/baseline-checkout --output correction-scale.json
```

The scale baseline must be a clean public checkout at
`b3f28694c3aad17ff1acd7c6801d2aaf7a6defaa`. Output files are exclusive-created;
choose a new filename to repeat an observation without overwriting history.
For this local milestone npm was unavailable; the three declared check commands
were executed directly: `node scripts/check-english.mjs`,
`node --test tests/*.test.mjs`, and `node scripts/replay-targeted-followup.mjs`.
This does not claim that the npm wrapper ran locally.

No UI or existing storage route invokes the correction API automatically. A host
adapter still needs authenticated review, a clear selected-source preview,
transactional persistence with revision conflicts, safe history access, a
review queue and an explicit treatment of recency invalidation. Contract and
synthetic-library success do not establish that such an adapter is deployed.

## Rollout and rollback

This PR adds an optional `provenance_corrections` array to returned states; there
is no database migration or deployed-schema change here. Before adoption, back
up original observations and derived summaries, validate persisted data and
recompute summaries in a staged comparison. Keep source history and timestamps;
do not bulk-convert legacy dates to verified recency. Review consumers of
`resolvedExisting` because its documented scope now includes known relabeling.

For a code rollback, revert the PR normally and disable the optional host
correction action. Keep captured sources and correction history. Reverting code
does not undo persisted metadata; use the reviewed undo only when its source
guard still applies, otherwise reconcile current state or restore an approved
backup. Do not run old arrival accounting against changed attribution and treat
the resulting false arrivals as new demand. Hosted adaptation, real-person
acceptance, production rollout and any migration remain separate work.
