# Optional local semantic retrieval - 29 October 2026

This change repairs the measured shortlist gap in the public curated library.
The previous lexical cache found neither difficult target at any tested large
size. Optional task embeddings plus diverse selection now retain both targets,
while the existing rules and grounded review decide whether an opportunity is
the same. No vectors authorize merges, publication, source rights or business claims.
The hosted application and its database are unchanged.

## Architecture and source references

The ordinary Node path remains available with no new npm dependency. The optional
encoder runs in a separate Python process, uses pinned local ONNX/tokenizer assets,
and never downloads models during inference. A 384-dimensional in-memory index is
enough for this bounded 10,000-record library; there is no vector database service.

The [official E5-small model card](https://huggingface.co/intfloat/multilingual-e5-small)
and [published ONNX assets](https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3/onnx)
were checked on 29 October 2026. The model is MIT-licensed; this run pins revision
`614241f622f53c4eeff9890bdc4f31cfecc418b3`. It uses the documented symmetric-task
prefix, masked mean pooling and normalization. Only English and Chinese were tested
here; the model card's wider language support is not our acceptance evidence.
Weights and tokenizer total approximately 135 MB, downloaded separately and hash-checked.

Candidate selection keeps exact identities first, then alternates the lexical
rank and standard maximal marginal relevance (MMR, lambda 0.5). MMR penalizes
redundant candidates in the shortlist; it never merges or deletes their records.
The [LangChain in-memory architecture](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/vectorstores/in_memory.py)
and [MMR reference](https://reference.langchain.com/python/langchain-core/vectorstores/utils/maximal_marginal_relevance)
were inspected as design references, with its [MIT license](https://github.com/langchain-ai/langchain/blob/master/LICENSE)
checked on the same date. This implementation does not import LangChain or copy
its source. Unlike a truncated nearest-neighbor pool, the bounded local MMR pass
can consider a diverse target below many repeated high-score distractors.

The embedding input is the task text. Persona and outcome remain bound to the
packet through an identity digest, while the immutable lexical snapshot retains
title, constraints and evidence keys. Model identity, source digests, dimensions,
finite nonzero vectors and complete packet counts must match. Old-format vectors
cannot be reused silently after an encoder-format change. Raw observations,
author identifiers, credentials and command configuration are excluded from input.
This is data minimization, not an automatic PII detector: callers still govern
what they put in the public task fields.

## Frozen observations and limits

The same [140-pair corpus](../eval/boundaries-v2/cases.json) remains unchanged.
The [first plan](../eval/boundaries-v2/retrieval-plan.json), weak initial result
and source commit `bd011da162d1dd3eeed6d6bbdbc387c6434e16c4` are preserved. Full
identity text plus plain dense ranking missed 19/80 paired duplicate targets;
the lexical path missed 20/80. That first vector implementation was insufficient.

A four-input development diagnostic compared the quantized model with the pinned
FP32 model using the same tokenization/pooling. Cross-precision cosine was
0.9954-0.9962 on those inputs, giving no evidence of gross quantization corruption
there. Removing generic identity boilerplate improved the development comparison.
The [second plan](../eval/boundaries-v2/retrieval-plan-v2.json) froze task-only
encoding and standard MMR before its full run. No labels or fixtures changed.
Designated held-out domains had already been exposed to the initial experiment;
they are not an independent blind confirmation set. No further tuning was done
from the second run.

| Same 140 queries against 140 counterpart records | Lexical | Initial dense union | Task-only diverse union |
|---|---:|---:|---:|
| Paired duplicate targets absent from top 32 (80 expected duplicates) | 20 | 19 | 0 |
| All paired targets absent from top 32 | 20 | 19 | 0 |
| Duplicate targets reachable with the default eight ambiguous-pair review calls | Not compared in first run | 60 | 73 |
| Offline unresolved duplicate decisions | 40 | 40 | 40 |
| Offline unresolved pair decisions | 80 | 80 | 80 |

These are exact paired-target ranks, not recall over every possible equivalent
opportunity or a population false-merge rate. The final paired offline decisions
have zero false `same` proposals and zero duplicates decided `different`; their
80 unresolved pairs are not counted as correct answers. Seven expected duplicate
targets exceed the default review budget. Partial retrieval remains explicitly
incomplete; it cannot clear a novelty/publication gate.

The [reversal run](../eval/results/2026-10-29-local-reversal.json) found all paired
targets in both directions (140 each), with zero candidate-ID disagreements from
repeating the query or reversing corpus order. This tests retrieval stability,
not live model agreement. All data are authored synthetic fixtures with shared
transformations, not observed market needs or independent human acceptance.

### Scale and operating cost

The two frozen stress queries each used three repetitions per size. Both targets
were absent from the lexical top 32 and present at **rank 3** in every hybrid
measurement. The final readout separates index construction and a new query's
encoding from cached-vector ranking:

| Records | Cached lexical ranking median ms | Hybrid ranking median ms | Cold index build, including encoding, seconds | Uncached query encoding seconds |
|---|---:|---:|---:|---:|
| 100 | 0.96 | 3.61 | 2.08-2.17 | 1.67-1.68 |
| 1,000 | 8.25 | 19.64 | 6.19-6.79 | 1.67-1.74 |
| 10,000 | 42.83 | 266.81 | 46.61-51.68 | 1.62-1.64 |

Hybrid retrieval does more work. It does not promise faster ranking than lexical
search, and the ranking column is not end-to-end first-query latency. An application
should build indexes outside its interactive request and retain the encoder instance
for its bounded, content-addressed cache. Indexes remain explicit immutable snapshots;
source edits require a rebuild. The two-thread CPU encoder was tested on Windows x64
with an Intel Core i7-10700K, Node 24.19.0 and Python 3.11.3. JobFlow regressions shared
the host, so these are descriptive timings, not isolated performance guarantees.

Node RSS during the hybrid scale run ranged from 72-75 MiB, 112-135 MiB and
331-378 MiB respectively. A separate fresh-process memory profile measured Python
peak RSS of **444, 448 and 459 MiB** at the three sizes. Those peaks and Node
snapshots are separate observations, not a synchronized whole-system peak.
The encoder is optional partly because this memory cost is material.
The [Windows memory API](https://learn.microsoft.com/en-us/windows/win32/api/psapi/nf-psapi-getprocessmemoryinfo)
was checked before adding the profiler; missing observations remain null.

Embedding inference made no cloud requests or paid API calls. Electricity, hardware
amortization and engineering maintenance cost were not measured. No new live LLM
round is claimed. The previous Hermes pilot's unavailable token/cost values remain
unknown, and the task-only encoder does not replace semantic pair adjudication.

## Setup and use

Default installation and `npm run check` still require only Node. To opt in, create
a separate Python 3.11 environment outside the repository and install the pinned
[optional requirements](../requirements-local-encoder.txt). Do not modify Hermes's
or another project's environment. For example, from this repository on Windows:

```powershell
python -m venv ..\needradar-encoder-env
..\needradar-encoder-env\Scripts\python.exe -m pip install --only-binary=:all: -r requirements-local-encoder.txt
..\needradar-encoder-env\Scripts\python.exe scripts/download-local-encoder.py --download --directory ..\needradar-encoder-model
$env:NEEDRADAR_ALLOW_LOCAL_ENCODER = 'true'
$env:NEEDRADAR_ENCODER_PYTHON = (Resolve-Path '..\needradar-encoder-env\Scripts\python.exe').Path
$env:NEEDRADAR_ENCODER_MODEL_DIR = (Resolve-Path '..\needradar-encoder-model').Path
node scripts/check-local-encoder.mjs --output runtime-check.json
node scripts/evaluate-local-retrieval.mjs --output retrieval-check.json
```

Use new output paths. Linux/macOS environment paths use `bin/python`; those local
runtime combinations have not been exercised here. The installed requirements
passed `pip check`; exact dependency versions are recorded with the verification.
No automatic model download, GPU setup, framework migration or paid service is enabled.

An integrating Node application can use the same grounded review API:

```js
import { createLocalEncoder } from './src/local-encoder.mjs';
import { createSemanticCandidateIndex } from './src/semantic-retrieval.mjs';
import { reviewDuplicates } from './src/semantic-review.mjs';

const encode = createLocalEncoder({
  pythonExecutable: process.env.NEEDRADAR_ENCODER_PYTHON,
  modelDirectory: process.env.NEEDRADAR_ENCODER_MODEL_DIR,
  allowExecution: process.env.NEEDRADAR_ALLOW_LOCAL_ENCODER === 'true',
});
const index = createSemanticCandidateIndex(existing, await encode(existing));
const [queryEmbedding] = (await encode([candidate])).rows;
const review = await reviewDuplicates(candidate, index, {
  queryEmbedding, reviewer: configuredGroundedReviewer, maxModelCalls: 8,
});
```

`existing`, `candidate` and the explicitly configured reviewer are application
inputs; this snippet does not supply them or activate a provider. Vectors select
candidates only. Retain `requiresReview`, retrieval evidence and original sources;
never turn an encoder error or incomplete search into `PUBLISH`. Inputs over 512
tokens fail without silent truncation. An incomplete/failed process contributes
no partial cache results. Returned vector mutation cannot alter cached values.

## Verification, release and rollback

- The base branch passed 43 Node tests; the final local suite passes 50, including
  source/model binding, mutation isolation, diverse shortlist coverage and existing
  constraint/evidence gates. Default CI uses deterministic contract vectors only.
- Actual local runtime checks verify inference, content-cache reuse with new identity
  binding, returned-vector isolation, rejected overlength input and recovery after
  a partial batch failure. These are real CPU-model checks, not contract stubs.
- One complete 100-record retrieval-to-publication-policy integration replay reaches
  the translated target and proposes duplicate suppression. It uses **one previously
  recorded real Hermes pair response plus seven explicit uncertain contract stubs**.
  It makes zero new LLM requests, performs no merge, and keeps incomplete coverage
  visible. This is not a live end-to-end production or authenticated-human test.

Receipts: [initial failure](../eval/results/2026-10-29-local-retrieval-initial.json),
[precision diagnostic](../eval/results/2026-10-29-local-precision-diagnostic.json),
[final paired retrieval](../eval/results/2026-10-29-local-retrieval-pairs.json),
[scale](../eval/results/2026-10-29-local-retrieval-scale.json),
[memory](../eval/results/2026-10-29-local-encoder-memory.json),
[runtime](../eval/results/2026-10-29-local-encoder-runtime.json),
[integration replay](../eval/results/2026-10-29-local-review-workflow.json),
[verification](../eval/results/2026-10-29-local-retrieval-verification.json).
The paired/scale runs preceded memory-only instrumentation; the later reversal,
runtime and integration checks use that instrumentation. Historical receipts are
not rewritten or represented as newly executed final-source measurements.

This is a stacked draft above the evidence-cluster milestone. No production
migration, application deployment or model auto-merge is included. Rollback disables
the optional encoder and rebuilds the previous lexical snapshot; all opportunities,
observations and human journals remain untouched. Lexical fallback retains its
known recall limits and must continue to expose incomplete review.

Remaining validation: independently authored natural-language examples, alternative
CPUs/runtime versions, genuine user review workload, production-source adaptation
and deployment approval. Preserve the unresolved 80-pair semantic burden; this
retrieval improvement is not full NeedRadar product acceptance.
