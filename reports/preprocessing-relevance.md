# Preprocessing relevance pilot — retain raw cosine default

Observed 2026-10-12. Reproduce with `node tools/evaluate-preprocessing.mjs` (local
headless Chromium model inference, then Node exhaustive scoring). The complete
query-level top tens, labels, timings, transform versions, manifest SHA-256s and
conditions are in [preprocessing-relevance.json](preprocessing-relevance.json).
This is a **small exploratory page-level evaluation**, not a benchmark proving
that one transform generally improves retrieval.

## Corpus, labels and split

The tracked [Wikipedia MiniLM corpus](../demo/data/source.json) has 2,000
passages (384-dimensional Float32 vectors), quantized
`Xenova/all-MiniLM-L6-v2` revision
`751bff37182d3f1213fa05d7196b954e230abad9`, CC BY-SA 4.0 excerpts with
per-record source revisions. The script checks the binary vector SHA-256 against
the provenance manifest. Questions are embedded by the same local model in a
fresh Chromium profile; no paid API or remote inference.

[Twenty manually authored question-to-page labels](../tests/fixtures/wikipedia-relevance.json)
were selected **before** running the ranking comparison. They are page-level
labels from titles/topic descriptions, **not independent passage judgments**:
all passages for the named page count as relevant, even if a particular excerpt
would not answer the question. This optimistic recall definition limits the
conclusion. The queries are paraphrases rather than corpus text or self-vectors.
No external relevance benchmark or held-out human adjudication is claimed.

Unique Wikipedia page titles in corpus order are split deterministically:
indices divisible by four are held-out eligible candidates (42 pages, 503
passages); all other titles are the transform-fit-only train corpus (125 pages,
1,497 passages). No held-out candidate or query vector enters the mean or
whitening fit. The eligible set is **exactly** those 503 passages for every
query; this deliberately tests candidate-set-restricted ranking, not quality
against the other 1,497 passages. Each labelled target is in the eligible set.

For each method, `hit@1/10` is the fraction of questions with a labelled page
in the first 1/10 ranked passages; MRR@10 uses the first labelled rank;
**eligible recall@10** is the fraction of that target page's eligible passages
present in the top ten, averaged over questions. `overlap@10` is the mean
fraction of passage IDs shared with raw cosine's top ten. Overlap alone is **not
relevance**. Scores are cosine in all methods, and rank ties break by original
passage position. No index/search implementation is changed.

| Method | Hit@1 | Hit@10 | MRR@10 | Eligible recall@10 | Overlap with raw@10 | Median exhaustive query search† | Fit / eligible preparation |
|---|---:|---:|---:|---:|---:|---:|---:|
| Raw cosine | 19/20 | 20/20 | 0.975 | 0.6625 | 1.000 | 0.75 ms | 0 / 0.95 ms |
| Training-mean centered cosine | 19/20 | 20/20 | 0.975 | 0.6708 | 0.925 | 0.74 ms | 83.48 / 20.98 ms |
| Training Cholesky-whitened cosine | 20/20 | 20/20 | 1.000 | 0.5875 | 0.735 | 0.99 ms | 384.59 / 103.75 ms |

† Timings are one local Node process against only 503 already-resident eligible
vectors; browser encoding and one-time fit/preparation are excluded from per-query
search. No p95, disk, IDB, or statistically stable speedup claim. The model
encoding itself was driven in Chromium but is not a measured retrieval latency.

Whitening changes the top ten substantially and fixes the single raw top-one
miss (Cryptography, from rank two to rank one), while losing roughly 7.5
percentage points of eligible recall@10 versus raw on these same 20 questions.
Mean-centering changes the top ten modestly and has only a ~0.8 percentage-point
eligible-recall difference, with no hit@1/MRR gain. The sample is tiny,
page-level labels are coarse and the regularization choice was not tuned on a
separate validation set. These differences cannot support a default change.

## Decision and versioning

**Reject adopting either transform by default. Keep raw cosine unchanged.**
Whitening may remain an explicit opt-in experiment with training-only fit; on
this pilot it trades a single top-one correction for lower recall over eligible
relevant passages. A future adoption decision needs independently judged,
held-out sentence/passage qrels across multiple encoders and corpus sizes,
relevance confidence intervals, and build/query/memory costs under realistic
storage/filter constraints. Do not use neighbour overlap as a quality proxy.

Any opt-in transform must persist or otherwise bind the **model and exact
revision, dimensions, `transformVersion`, training-corpus fingerprint, fit
parameters (including ridge), and fitted mean/matrix** to both stored vectors
and query encoding. Mixing vectors from different fit versions invalidates
cosine rankings; build a new corpus or refuse incompatible queries. This pilot
uses `raw-cosine-v1`, `mean-center-v1`, and
`cholesky-whiten-v1-ridge-1e-6` (the existing `fitWhitening` implementation,
regularization 1e-6). It does not introduce a durable transform format or
migration path.
