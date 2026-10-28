# Multilingual deduplication, 27 October 2026

## Scope and verified baseline

The public baseline is `42349e824f9cb24e0bfc152e7c25975d3fbb9a3e`.
Its ASCII tokenizer removed Chinese. Its evidence weight capped identical text
with different evidence keys at 0.75, below the 0.78 duplicate threshold.
The original eight tests passed; they did not cover these defects.

This repository remains a curated portfolio edition. The connected Sites
deployment was separately verified as version 38, source commit
`2839f2637c5a7fc35f34f99ef7b8d76413d82c11`, with successful publication on
27 August 2026. That implementation already supports Chinese and bilingual
aliases. Its evidence-overlap shortcut can still suppress different tasks.
An adapter has been prepared in an isolated checkout of that actual source;
it has **not** been deployed. No private source or operational data is included here.

## Implementation

- Unicode segmentation and Han bigrams retain multilingual text.
- Null text remains missing; two absent personas/tasks cannot establish exact identity.
- Identity scores exclude corroboration. Exact task/persona/outcome and compatible
  structured constraints may suppress a duplicate proposal. Other pairs require
  grounded semantic or human review; low lexical overlap is not proof of novelty.
- Up to 64 existing briefs use bounded exhaustive candidate retrieval, including
  zero-overlap translations. Larger collections use a lexical shortlist and expose
  incomplete recall; they cannot silently pass the publication gate.
- Optional reviewers receive only public title, persona, task, desired outcome and
  constraints. Strict verdicts require verbatim quotations of supplied descriptions.
  Invalid output, errors, missing constraints and exhausted budgets retain REVIEW.
- Reposts, repeat crawls, canonical URLs and exact content hashes are grouped before
  independent evidence counts. Unknown provenance does not become corroboration.
  Counterevidence remains visible and cannot satisfy positive-demand thresholds.
- `addEvidence`, `recordValidation` and `recordPairDecision` preserve observations,
  `last_seen`, new evidence, counterevidence and version-bound human corrections.
  Pass authenticated human decisions to `decidePublicationWithReview`; never accept
  actor identity from model output. Corrections expire when compared content changes.
- No automatic destructive merge, database, vector service or new runtime dependency.

## Fixed synthetic comparison

Fixtures: `eval/dedup-cases.mjs`, 16 deliberately selected cases (6 duplicates,
10 distinct). They cover Chinese, translation, low-overlap paraphrases, same-persona
different tasks, constraints, negation, reposts and nearby nonduplicates.
These are engineering fixtures, not representative market observations.

| Path | False merge | Missed duplicate decided distinct | Unresolved duplicate | Human review pairs | Correct duplicate proposals |
|---|---:|---:|---:|---:|---:|
| Frozen public baseline | 4 | 5 | 0 | 0 | 1 |
| New offline policy | 0 | 0 | 2 | 9 | 4 |
| Policy + existing Hermes, actual model requests | 0 | 0 | 0 | 0 | 6 |

The measured Hermes round used configured `gpt-5.6-sol` through `openai-codex`,
Node 24.19.0 and the existing WSL Ubuntu Hermes installation. Nine model requests
took 50.309 seconds overall; measured request times were 4.414-8.073 seconds.
Tool calls were disabled and audited. Only synthetic descriptions were sent.
Token usage and billed cost were unavailable: `null` means unmeasured, not free.
There was one earlier nine-request attempt whose Windows temporary-directory cleanup
failed; those results were rejected, recorded separately and excluded from quality
claims. Four single-pair diagnostic calls were also made while fixing the adapter.
WSL execution now starts with `--cd /tmp`, avoiding its inherited Windows directory lock.

This small round supports the tested behavior, not a production error-rate claim.
No claim is made that a newer model improves this result. The final outcome-field
guard has deterministic regression coverage; those fixtures have no outcome-field
differences, and the live round was not needlessly repeated.

Records: [offline](../eval/results/2026-10-27-offline.json),
[Hermes](../eval/results/2026-10-27-hermes.json),
[rejected transport attempt](../eval/results/2026-10-27-hermes-rejected.json).

## Run and configure

```sh
npm test
npm run check:english
npm run eval:dedup
```

No model is called by default. For an existing local/Agent connector, use
`createCommandReviewer` with a trusted executable and argument array, and explicit
`allowExecution: true`. The process receives JSON on stdin, uses no shell, is bounded
by time/output limits and must return `{decision, model, toolCalls: 0}`.
`scripts/hermes-review.py` uses Hermes's configured provider, not an extracted key.
Run it with that installation's Python and `-I`. On Windows, configure WSL arguments
as `-d <distro> --cd /tmp --exec <Hermes-venv-python> -I <absolute-script-path>`.
Use `NEEDRADAR_ALLOW_COMMAND=true`, `NEEDRADAR_REVIEW_EXECUTABLE` and a JSON array in
`NEEDRADAR_REVIEW_ARGS`, then `node scripts/evaluate-dedup.mjs --command`.
The provider can be cloud-backed; existing Hermes configuration controls that route.

Direct Responses integration additionally requires `NEEDRADAR_ALLOW_CLOUD=true`,
`OPENAI_API_KEY` and an explicitly chosen `NEEDRADAR_MODEL`; run
`node scripts/evaluate-dedup.mjs --live`. It sends the public fields to OpenAI with
`store:false`, no tools, bounded output and strict JSON schema. No raw observations,
author identifiers or account credentials are part of the review payload.
Direct Responses transport is contract-tested only; account access was not assumed
from Hermes authentication.

## Official capability check and delivery gates

Checked 27 October 2026: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[Decisions](https://developers.openai.com/api/docs/guides/decisions),
[GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra).
Decisions and Terra remain candidates: no direct account availability or comparative
benefit was established, so no production dependency or model switch was introduced.

Validation: 20 public tests and the unchanged English-only check pass. The hosted
source has a separate baseline and adaptation validation record, retained privately.
Source integration, scheduling, authenticated reviewer controls, persistence and a
production observation sample still require validation in that deployment.

Publishing requires review of the staged hosted-source diff and a production backup.
No schema migration is introduced by the staged conservative gate. Rollback is the
previous immutable Sites version 38; do not reclassify or delete stored opportunities
as a side effect. The public task branch can be reverted independently.
