# Independent evidence and recency correction

Scope: the public curated edition, synthetic engineering observations, 30 October
2026. This is not a hosted deployment or a new semantic-model experiment.

The [31 October follow-up](provenance-corrections-2026-10-31.md) fixes known-author
relabeling and serialized-capture accounting, and adds reviewed correction/undo.
The observations below remain the original milestone's results.

## Observed defects

At `5b58e5378a204bc10b35c70f3706c66ec8f79eec`, independent origins used
`originGroup || authorGroup` hashes. Adding an organization to an existing capture
changed that hash and reported one new independent origin even though the count
stayed at one. It advanced a June observation to October. Another pair of posts
from the same author, only one with organization metadata, counted as two origins
and could pass the two-source-policy publication path.

| Synthetic boundary | Before | Corrected behavior |
|---|---|---|
| Existing capture gains organization attribution | One new origin; recency advances | Zero new origins; original date retained |
| Same author, two policies, partially enriched attribution | Two origins; eligible | One origin; insufficient independence |
| Three authors from one known organization | One origin but three independent authors; eligible | One independent unit; insufficient independence |
| Equal label in unrelated author/organization namespaces | One origin | Two distinct units unless explicitly linked |
| Previously unattributed capture becomes attributable | New independent arrival dated now | Resolution of existing provenance; no invented arrival date |
| Legacy stored recency without a tracked arrival | Could appear fully fresh | Date visible; review required |

These are fixed authored counterexamples, not a representative estimate of
real-world provenance error or product adoption.

## Domain boundaries

`provenance.mjs` keeps capture equivalence: evidence keys, declared repost/original
references, canonical URLs and exact content hashes. Original observations are
preserved. Ambiguous originals, unresolved reposts, missing identity and malformed
author/organization values remain unresolved. Complementary original annotations
for the same capture can contribute attribution; a reposter cannot replace an
original author's identity.

`evidence-independence.mjs` builds small in-memory connected groups using typed
author and organization tokens. Shared known authors or organizations withhold
independence, including transitive links. Tokens are trimmed and case-sensitive;
this does not identify people, guess aliases, merge similar names or prove that
unknown sources are independent. Adapters must supply grounded, scoped canonical
tokens. A shared organization is deliberately a conservative dependency signal.

`evidenceSummary()` adds `independentUnits` with attribution keys and evidence
group IDs for explanation, and `distinctAttributedAuthorGroups` for descriptive
counts. `independentAuthorGroups` now counts independent units with author
attribution. A known shared organization cannot use several authors to bypass
the unchanged publication thresholds. `independentOriginIds` remain available
but are derived summaries, not durable arrival-event identifiers.

`addEvidence()` compares prior capture membership and attribution. Digest changes
alone never create new evidence. It adds:

- `evidence_state_version: 2` and `independent_recency_verified`;
- `provenance_change.newIndependentOrigins`;
- `provenance_change.resolvedExistingOrigins`;
- `provenance_change.consolidatedOrLostOrigins`.

`last_seen` can advance after a permitted recapture. Independent evidence time
advances only for a new unrelated origin, and clocks never move backward. Losing
or consolidating old origins makes their previous recency unverified. A genuine
new arrival can establish recency at or after the retained clock; an older
out-of-order arrival cannot certify an unverified later date.

`assessOpportunityFreshness()` retains the computed date/age and adds `verified`
and `verificationReason` to `independentEvidence`. Legacy or uncertain provenance
requires review even if the displayed date is recent. These are scheduling
signals, not probabilities or market-validation outcomes. Counterevidence counts
as provenance but remains excluded from supporting-evidence publication gates.

## Verification and limits

Fourteen behavior contracts were committed at `f86b359` before the runtime
change. The old implementation passed three and failed eleven in 201.1632 ms.
Several failures concern new explicit verification fields; this is a regression
contract count, not eleven separately measured production incidents.

The related suite passes 44/44 in 345.1112 ms. The full suite passes 88/88 in
1,151.7838 ms with no skips. English-only checks and the published fourteen-pair
hash-bound offline replay pass. The replay makes zero provider calls and does not
reopen the closed live protocol, revise its observations or claim free historical
model usage. No new model, dependency or service was required.

The 140-pair offline boundary evaluation remains: zero decided false merges,
zero decided missed merges, **40 unresolved duplicate pairs and 80 pairs requiring
review**, 40 duplicate proposals and 20 distinct decisions. There are zero
evidence-count mismatches in that existing fixture set. Uncertain pairs are not
counted as correct. Actual human review time and hosted effects remain unknown;
this correction establishes no new semantic accuracy improvement.

The [verification receipt](../eval/results/2026-10-30-evidence-origin-verification.json)
records source/log hashes, the before failures and after results. Full model
queue completion, independently authored holdouts, human correction workload and
deployment-source adaptation remain separate unfinished work.

## Run, adoption and rollback

No configuration or dependency change is needed. Node.js 20 or newer is enough:

```sh
npm run check
node --test tests/evidence-independence.test.mjs
node scripts/evaluate-boundaries.mjs --output fresh-boundary-results.json
```

On the observed Windows shell, `npm` was not on PATH. The same `check` commands
were run directly and passed: `node scripts/check-english.mjs`,
`node --test --test-reporter=tap tests/*.test.mjs`, then
`node scripts/replay-targeted-followup.mjs`. Output files must be fresh paths.

Existing raw observations need no destructive migration. Recompute summaries
from originals, preserving validation and correction events; the next
`addEvidence()` call returns version 2 state even with an empty additions list.
Do not treat that recomputation as a new arrival. Old stored counts can change;
historical timestamps remain visible and unverified. Missing history must be
reviewed, not manufactured. Derived summary IDs must not be used as persistent
foreign keys or as proof of a new independent source.

No hosted code, database or publication state was changed. A deployment adapter
would first need its own source/contract audit, backup, dry-run diff and approved
deployment. Roll back this public implementation with a normal reviewed revert;
preserve the original observations and version 2 metadata. An older reader that
ignores the verification flag must not silently re-enable publication or report
verified freshness. No production migration or release is authorized here.
