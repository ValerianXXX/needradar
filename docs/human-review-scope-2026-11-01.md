# Human corrections belong to the reviewed records

Scope: the public curated library, 1 November 2026. This unmerged change does not
update the hosted application, authorize a reviewer or publish an opportunity.

## Problem and behavior

A recorded correction for A/B was reused for C/D when their public wording
matched. Record IDs were excluded from the pair digest. Two separately recorded
decisions could also receive the same event ID. The cluster view already grouped
events by record IDs, so its result disagreed with direct review and publication
policy. A foreign `same` decision could suppress the new pair; a foreign
`different` decision could clear its semantic review.

Human decision creation and resolution now share
[one module](../src/human-review.mjs). Existing imports from `opportunity-state`
and `semantic-review` remain supported; this also removes the state module's
dependency on the asynchronous model-review module.

- New `recordPairDecision` events include `recordScope`, with protocol
  `OPPORTUNITY_RECORD_PAIR_V1` and the two oriented record IDs. That scope is
  included in the new event ID. Original source snapshots are retained.
- Scope and source content must both match. Reversing the whole pair works;
  swapping IDs independently of their contents does not. Changed source content
  still invalidates the prior decision.
- An absent ID is recorded as `null`, meaning unidentified, not any record.
  Later assignment of an ID requires a new review. Explicit invalid IDs fail.
- Existing events with original snapshots derive scope from those snapshots.
  Their bytes and historical event IDs are not rewritten. Inconsistent snapshots,
  malformed scope metadata and sparse ID arrays cannot downgrade to content reuse.
- The latest decision is selected only among applicable events. Foreign newer
  decisions cannot replace an older valid decision. Same-time disagreement still
  requires review. Constraint and evidence-policy gates remain unchanged.
- Model suggestions retain their separate content-bound cache. This change does
  not duplicate provider calls for equivalent public text or grant a model human
  authority. The quotation contract, budgets and source rights are unchanged.

### Legacy caller-built decisions

The older low-level interface also accepts caller-built events with neither
`originals` nor `recordScope`. For compatibility, these still describe a
content-wide judgment. Resolved results now identify that case as
`humanScope: LEGACY_CONTENT_ONLY`; snapshot-bound decisions report `RECORD_PAIR`,
and an equal-time combination reports `MIXED_RECORD_AND_LEGACY`.

That compatibility path is **not record-level approval**. Integrators should use
`recordPairDecision` with stable opportunity IDs for new decisions, preserve its
whole returned event, and hold legacy content-only records for explicit review
when record-specific approval is required. Do not invent old target IDs or remove
snapshots/scope to make a legacy decision apply. This change does not claim to
retroactively establish the unknown target of an old content-only judgment.

Scope is a consistency check, not a signature, authentication system or database
transaction. The host must authenticate reviewers, keep authoritative history and
compare the current revision when saving. Raw model output must not be entered
into the human-decision journal. Evidence arrivals/attribution remain separate.

## Frozen comparison and limits

Baseline: `659c1768096d0e443eb5c4221998f91e523b31db` (draft #11), 199 existing tests
passed on Windows / Node 24.22.1. Seventeen scope contracts and the comparison
runner were frozen at `cf53c1ceb76d4c3021a34e12a81f8fe0a737e75a` before product edits.
Before: one passed, sixteen failed, including new metadata requirements. The
same seventeen subsequently passed. A separate sparse-array persistence case
failed on the first implementation and its original failure is retained.

The matched comparison takes the unchanged low-overlap case from each of twenty
existing synthetic domains. Each gets four distinct record IDs and three
simulated human decisions. This tests record scope, not new semantic labels or
actual human approval. All calls use a zero model budget.

| Same 60 scope observations | Before | After |
| --- | ---: | ---: |
| Original pair keeps its own decision | 60 | 60 |
| Foreign pair receives that human decision | 60 | 0 |
| Foreign pair receives a definite same/different result | 40 | 0 |
| Foreign pair remains for review | 20 | 60 |
| Foreign pair remains separate in the cluster view | 60 | 60 |
| Distinct record decisions share an event ID | 60 | 0 |
| New provider calls | 0 | 0 |

The reverse comparison has the same scope result. More required review is the
correct consequence of removing inherited approvals, not a claimed reduction in
reviewer effort. The full local suite passes **217 tests**, with English-only
checking and all fourteen saved real-proposal replays. No existing test assertions
were removed or changed. The eighteen new tests include direct publication-policy
calls, split consistency, persistence, reverse order and unchanged model-cache reuse.
No user interface was changed, so no new browser or independent-user result is claimed.

The unchanged 140-pair offline evaluation still has zero decided false merges or
decided missed merges, **40 unresolved duplicates and 80 pairs requiring review**.
Uncertainty is not correctness. This repair establishes no general semantic
quality gain, cost saving, human-time saving or customer result. Closed real-model
campaigns remain closed; model/provider versions, prompts and dependencies are
unchanged. Hosted check results belong to the exact delivery commit and are
reported separately in the PR.

[Verification, hashes and original failures](../eval/results/2026-11-01-human-review-scope/verification.json)
retain the pre-fix, first implementation and final observations. These are
engineering checks on authored synthetic records, not an independent benchmark.

## Run and adopt

Use the existing Node >=20 setup; this milestone was run locally on Node 24.22.1.
No additional service, environment variable or configuration is required.
The existing `.env.example` continues to govern separately opted-in model use.

```sh
npm run check
node scripts/evaluate-human-review-scope.mjs --output new-scope-results.json
node scripts/evaluate-boundaries.mjs --output new-boundary-results.json
```

Evaluation output paths must be new. These two evaluations make no model requests.
Local validation ran the three existing check commands directly with Node; the
hosted workflow runs the npm wrapper.

```js
import { pairDigest } from './src/semantic-review.mjs';
import { recordPairDecision } from './src/opportunity-state.mjs';

const event = recordPairDecision(currentLeft, currentRight, {
  digest: pairDigest(currentLeft, currentRight),
  decision: reviewedDecision,
  actor: authenticatedReviewerId,
  reason: reviewerReason,
  recordedAt: serverRecordedTime,
});
// Persist the whole event in the host's authorized, revision-checked transaction.
```

The values above are host inputs, not a supplied identity or approval. An operator
adopting this source should back up original opportunities and the complete human
journal, derive both old/new views, inspect changed decisions and retain unresolved
items for review. Historical content-only event-ID collisions cannot be repaired
by guessing; preserve both records and their source snapshots where available.

No automatic migration, merge, release or production deployment is included.
Code rollback preserves source/history files, but old readers ignore record scope
and restore the defect. Stop affected decision consumers before rollback, retain
the journals and snapshots, and require explicit review for affected publication
decisions. Do not delete events, rewrite approvals or reset real-model budgets.

Still open: independent natural-language holdouts, full bounded semantic queues,
actual human review effort, attributable model costs and separately authorized
hosted adoption. This milestone is not complete NeedRadar product acceptance.
