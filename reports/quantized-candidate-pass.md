# Compact quantized candidate passes — measured against an exact oracle

Bead `idb-vector-kuc.6`. Research only: **no index strategy is implemented or selected in
`index.js` by this work.** A compact side-store (int8 scalar quantization, 1-bit sign codes,
coarse cosine buckets) is measured as a *candidate-ordering* pass in front of an exact Float64
rerank, and compared with the exact scan over the same vectors. Full samples, browser and
hardware identity, commit and per-corpus detail are in
[quantized-candidate-pass.json](quantized-candidate-pass.json).

Reproduce with `node tools/evaluate-quantized-pass.mjs` (headless Chromium, ~3.5 minutes; it
writes `reports/quantized-candidate-pass.json` — preserve this report when repeating).
The pure module is `test-harness/quantized-pass.js`, driven by
`tests/unit/quantized-pass.test.mjs` in the fast tier (`npm run test:fast`).

## Conditions

Chrome 155.0.8059.39 (headless, fresh profile), Intel Xeon Platinum 8259CL, load 2.06/1.42/0.79,
commit `9e439ed`. Corpora: seeded uniform and adversarial near-duplicate sets at 100k × 128,
100k × 384, 20k × 1536, plus the tracked real MiniLM corpus at 2,000 × 384
(`demo/data/vectors-2000.f32`, `Xenova/all-MiniLM-L6-v2`). Warm medians over 10 queries and
three order-rotated repetitions (one repetition for the filtered leg); the first timed call of
each method is recorded separately. Single process, warm heap, page cache warm — these are
**not** p95, cold-disk or multi-process numbers, and the clock is quantized at the sub-millisecond
end. The candidate codes are built in page memory; the exact baseline computes norms inline the
way the library scan does. A second run at the predecessor commit reproduced the resident numbers
closely (100k × 128: exact 28.5/28.2 ms, int8 35.7/36.2 ms, sign 13.1/13.3 ms, bucket 0.7/0.7 ms).

Two legs are measured separately: (1) **resident arithmetic** — codes and originals all in page
memory, rerank reads resident originals; (2) **side-store read leg** — each representation stored
in IndexedDB and read back, plus the originals as 100,000 individual records. The composed
pipeline in the last section adds measured legs together; it is not one end-to-end query.

## Resident arithmetic (median ms per query; recall@10 is against the exact oracle)

| Corpus | exact | int8 (SQ8) | 1-bit sign | coarse buckets | build int8 / sign / buckets | code bytes |
|---|---:|---:|---:|---:|---|---:|
| uniform 100k × 128 | 28.2 | 36.2 (r 1.000) | 13.3 (r 0.770) | 0.7 (r 0.040) | 0.50 / 0.17 / 17.4 s | 12.8 MB / 1.6 MB / 1.3 MB |
| adversarial 100k × 128 | 49.7 | 56.8 (r 1.000) | 12.7 (r 1.000) | 0.8 (r 1.000) | 0.94 / 0.37 / 25.3 s | 12.8 MB / 1.6 MB / 1.3 MB |
| real MiniLM 2k × 384 | 1.5 | 3.9 (r 1.000) | 2.3 (r 0.980) | 1.0 (r 1.000) | 0.09 / 0.08 / 7.3 s | 0.8 MB / 0.1 MB / 0.4 MB |
| uniform 100k × 384 | 86.8 | 83.9 (r 1.000) | 20.1 (r 0.920) | 1.5 (r 0.040) | 5.2 / 0.9 / 42.5 s | 38.4 MB / 4.8 MB / 1.6 MB |
| uniform 20k × 1536 | 63.5 | 70.0 (r 1.000) | 16.5 (r 0.950) | 3.6 (r 0.090) | 1.2 / 0.4 / 12.1 s | 30.7 MB / 3.8 MB / 0.6 MB |
| adversarial 20k × 1536 | 64.3 | 65.6 (r 1.000) | 18.2 (r 1.000) | 3.6 (r 1.000) | 1.2 / 0.2 / 11.8 s | 30.7 MB / 3.8 MB / 0.6 MB |

`exact` is the resident Float32 scan with inline norms; originals are 51.2 MB at 100k × 128,
153.6 MB at 100k × 384 and 122.9 MB at 20k × 1536, so int8 codes cost 25% of the originals and
1-bit codes 3%. The reference baselines in the JSON (exact 941.6 ms, batched read 796.3 ms,
metadata-index 13.5 ms at 100k × 128) are Chrome 152 on a Ryzen 9 9955HX from
[browser-analysis.md](browser-analysis.md); only ratios, never these absolute numbers, cross hosts.

## Recall@10 against the candidate budget

Mean over all ten queries; `ceiling` is the share of the oracle top-10 that is even present in
the candidate list, so it bounds the recall any rerank could reach.

| Corpus | method | 100 | 300 | 1000 |
|---|---|---|---|---|
| uniform 100k × 128 | int8 | 1.000 (c 1.000) | 1.000 (c 1.000) | 1.000 (c 1.000) |
| | sign | 0.400 (c 0.400) | 0.630 (c 0.630) | 0.770 (c 0.770) |
| | buckets | 0.000 | 0.020 | 0.040 |
| uniform 100k × 384 | int8 | 1.000 | 1.000 | 1.000 |
| | sign | 0.420 | 0.660 | 0.920 |
| | buckets | 0.000 | 0.010 | 0.040 |
| uniform 20k × 1536 | int8 | 1.000 | 1.000 | 1.000 |
| | sign | 0.580 | 0.760 | 0.950 |
| | buckets | 0.000 | 0.010 | 0.090 |
| adversarial 20k × 1536 | int8 | 1.000 | 1.000 | 1.000 |
| | sign | 1.000 | 1.000 | 1.000 |
| | buckets | 0.310 | 0.720 | 1.000 |

Recall equals the ceiling in every row, i.e. reranking a candidate list here costs no recall —
all loss is in candidate selection. int8 reaches the full oracle top-10 with only 100 candidates
on every corpus; the budget only starts to matter for 1-bit codes and for buckets.

## Predicate before candidate (1% selectivity, 100k × 128, 1,000 eligible rows)

The compact passes take the eligibility mask **before** scoring, so they only score eligible rows.
The same pass ranking the whole corpus and filtering afterwards is measured alongside it.

| ordering | method | candidate pass ms | recall@10 | ceiling |
|---|---|---:|---:|---:|
| predicate before candidate | int8 | 1.3 | 1.000 | 1.000 |
| | 1-bit sign | 0.9 | 1.000 | 1.000 |
| | buckets | 0.6 | 1.000 | 1.000 |
| predicate after candidate | int8 | 32.7 | 0.870 | 0.870 |
| | 1-bit sign | 10.1 | 0.350 | 0.350 |
| exact eligible scan (reference) | — | 0.8 | 1.000 | — |

Ranking the whole corpus first costs 25× the int8 pass (32.7 vs 1.3 ms) and still loses recall,
because a fixed 1,000-candidate budget covers 1% of the corpus while the predicate keeps 1% of
the rows — the two rates have to be compared before choosing the order. At this selectivity no
compact pass beats the exact eligible scan (0.8 ms): there is nothing to save once the eligible
set is small. The unit test `predicate-before-candidate keeps the eligible neighbours that
predicate-after loses` pins this on a corpus where the collapse is unambiguous.

## Side-store read leg (100k × 128, one packed record per representation)

Each representation is written into its own fresh database and read back five times; the first
read is that store's first read in the process (cold structured-clone deserialisation, warm page
cache), the rest are warm. Originals as individual `{ id, embedding }` records (100,000 ×
Float64Array(128), the library's current storage shape) are written to a fourth store.

| record | bytes | first read ms | warm read ms (spread of 5) |
|---|---:|---:|---|
| packed Float32 originals | 51.2 MB | 205.7 | 299.8 (187.4–414.3) |
| packed int8 codes | 12.8 MB | 24.9 | 31.6 (27.4–72.6) |
| packed 1-bit sign codes | 1.6 MB | 5.4 | 4.4 (4.0–5.3) |
| 1,000 serial gets of individual originals | — | — | 470.4 total (0.47 per get) |

Reading int8 codes is 9.5× cheaper than reading the packed Float32 originals and 1-bit codes
68× cheaper; the read leg does scale with bytes. But a candidate pass still has to obtain the
original vectors for the exact rerank, and 1,000 individual gets cost 470.4 ms — more than the
whole packed Float32 read.

**Composed pipeline, 100k × 128** (measured legs added, not one query):

| path | ms |
|---|---:|
| readable packed Float32 + exact scan | 328.0 |
| int8 codes read + int8 scan + 1,000 original gets + rerank | 537.5 |
| int8 codes read + packed Float32 originals read + int8 scan + rerank | 367.6 |
| reference: current live scan, 100k individual object records (Chrome 155, this VM) | 6,255.9 |

([packed-read-2026-10-12.md](packed-read-2026-10-12.md) measured the individual-record scan; that
is a different query path, cited as the existing published number rather than re-measured here.)
At a **bounded** rerank the picture changes: with 100 candidates (100 gets, ~47 ms) the composed
int8 path is 31.6 + 35.5 + 47 ≈ **114 ms**. int8 recall@10 at budget 100 was 1.000 on all seven
corpora, so that composition is the one plausible benefit this work supports — and it is a
composition, so it needs an end-to-end measurement before anyone builds on it.

## Update, delete and rebuild costs

Per-row costs are single-sample means over 100 randomly spread rows and are noisy where the clock
is quantized (the same corpus varied by an order of magnitude between runs); treat them as
directions, not constants.

| operation | int8 | 1-bit sign | coarse buckets |
|---|---|---|---|
| update one row | 5–323 µs | 1–15 µs | 78–449 µs (reassign) |
| delete one row | code clear ≈ 1 µs | code clear ≈ 1 µs | list shift ≤ 1 µs (lists of 14–560 entries) |
| rebuild for one generation | 0.09–5.2 s | 0.08–0.9 s | 7.3–42.5 s |
| retrain required | no (per-dimension affine) | no | yes — k-means over a 10k sample, then reassign all rows |

int8 and sign codes are row-local: a row update rewrites `dims` bytes and a delete clears them.
Buckets are not: a row's membership comes from its distance to every centroid, and any change in
the sample changes the centroids, so a bucket index has no incremental write path — it is rebuilt.
A side-store also has to be **versioned**: a query must pin one revision and the codes, membership
and originals must move to that revision atomically. The unit test `a side-store that does not
apply deletions for its revision loses recall` shows the failure mode — a pass that still serves
deleted ids trails the current-revision pass on the same oracle.

## Findings

1. **int8 (SQ8) is a storage and memory lever, not a latency lever.** 25% of the original bytes,
   recall@10 = 1.000 at a 100-candidate budget on every corpus, but the resident scan shows no
   consistent win over the exact Float32 scan: 36.2 vs 28.2 ms at 100k × 128 (28% slower), 83.9
   vs 86.8 ms at 100k × 384 (3% faster), 70.0 vs 63.5 ms at 20k × 1536 (10% slower). It buys I/O
   bytes, not arithmetic.
2. **1-bit sign codes are 2.1–4.3× faster to scan but lose recall on well-spread data**: 0.770
   at uniform 128D, 0.920 at uniform 384D, 0.950 at uniform 1536D, and 1.000 on clustered and
   real data. Usable only as a *candidate* pass with a budget of 1000 (or on clustered data),
   never as a filter or a final ranking.
3. **Coarse buckets fail on uniform data.** With 256 (or 64) buckets, probing only the nearest
   buckets until the budget fills leaves recall@10 at 0.04–0.09 after 1,000 candidates at 100k ×
   128/384 and 20k × 1536, because the true neighbours scatter across buckets. They reach 1.000
   only when the data is clustered (adversarial) or on the 2k real corpus, and they cost 7.3–42.5 s
   to build with no incremental update path.
4. **Predicate-before-candidate is required, not an optimisation.** Masked passes score only the
   eligible rows (1.3 ms for int8 at 1% selectivity, recall 1.000); ranking the corpus first costs
   32.7 ms and still loses recall (0.870). The library already evaluates eligibility before
   distance in its own scan (`selectCandidates`, `index.js:136-160`); any side-store must preserve
   that order.
5. **The rerank fetch, not the arithmetic, decides whether a side-store helps.** Reading 1.6 MB of
   1-bit codes costs 4.4 ms and reading 12.8 MB of int8 codes 31.6 ms — both far below the 51.2 MB
   packed Float32 read (299.8 ms) — but 1,000 individual original gets cost 470.4 ms, which is
   larger than the entire packed read and exact scan (328.0 ms). A candidate pass pays off only
   with a small rerank budget (≈100 at 100k × 128) or when the originals can also be read packed.
6. **A pass re-read per query is a different product from a resident index.** If the working set
   is resident (the opt-in packed snapshot already on `main`), int8 codes add memory and buy no
   query time. If nothing is resident, the read leg is the dominant cost and a compact code store
   is the only representation in this experiment that reduces it.

## Decision

**Choose: keep exact cosine ranking and the opt-in packed snapshot as they are. Adopt no compact
candidate pass yet, and select no ANN family from this work.** The numbers do not support any
query-latency claim for a resident workload — int8 is slower per query than exact, 1-bit loses
recall on well-spread data at 128–384 dimensions, and coarse buckets collapse on uniform data and
cannot be updated incrementally. `idb-vector-kuc`'s exact baseline plus the metadata index
(13.5 ms at 1% selectivity in [browser-analysis.md](browser-analysis.md)) remains the contract.

**Do not choose 1-bit sign as a filter or final ranker:** recall@10 of 0.770 (uniform 128D) and
0.920 (uniform 384D) is a data-dependent loss with no bound, and nothing here measures a real
workload's tolerance for it.

**Do not choose coarse buckets:** rebuild cost 7.3–42.5 s, no incremental update path, and
recall@10 0.04 at 1,000 candidates on uniform 100k × 128 — the two properties are each
disqualifying on their own.

**The one supported hypothesis, to be measured end-to-end before any implementation:**
for a workload that reads from IndexedDB per query, an **int8 code side-store with a bounded
exact rerank (≈100 candidates)** should cut the read leg from 51.2 MB to 12.8 MB plus 100 original
gets. Composed from measured legs that is ~114 ms against 328.0 ms for reading the packed Float32
snapshot and scanning exactly, and against 6,255.9 ms for the current live individual-record scan
on this VM; int8 recall@10 at budget 100 was 1.000 on every corpus here. It must still be measured
as one query — codes written to IndexedDB, read, scanned, originals fetched, reranked, timed as a
whole — at 100k × 128 and 100k × 384, and it must not replace exact rerank. Tracked as
`idb-vector-kuc.8`.

Storage a side-store would add to 100k × 128: 12.8 MB of int8 codes beside the 51.2 MB of
originals (25%), plus a per-row code update of 5–323 µs and a revision stamp so a query cannot mix
generations. Both the extra bytes and the write path belong in the end-to-end measurement.

## Boundaries this report does not cross

- Single process, warm heap, warm page cache, one browser; no p95, no cold-disk and no
  multi-tab claim. Packed-read timings varied by 2.2× across five warm reads, so small differences
  in the read table are not meaningful.
- Only the tracked 2,000-row real corpus is in the repository; larger real corpora are prepared
  locally and uncommitted (`tools/prepare-real-vectors.py`, `.cache/real-vectors/`), so real-data
  scale is covered by the larger synthetic sets, not by real embeddings at 100k rows. The
  real-vector recall workstream is `idb-vector-kuc.7`.
- The codes are built in page memory in the resident leg; only the read leg stores them in
  IndexedDB. No claim is made about write amplification, quota behaviour or eviction.
- Recall is measured against an exact oracle over the same in-memory vectors, so it isolates
  candidate selection from read errors; it is not a retrieval-quality claim about any real corpus
  or query distribution.
