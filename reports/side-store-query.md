# int8 code side-store, measured end to end on the IndexedDB read path

Bead `idb-vector-kuc.9`, answering the one hypothesis
[quantized-candidate-pass.md](quantized-candidate-pass.md) left open: a compact int8 code
side-store with a **bounded exact rerank** should cut the read leg of a query that reads from
IndexedDB. That report composed the estimate from separately measured legs (~114 ms against
328 ms at 100k × 128); this one times every leg inside one query, per query, and compares it with
the exact read paths in the same run.

Research only: **`index.js` is untouched by this bead** and no side-store is implemented in the
library. Reproduce with `node tools/evaluate-side-store-query.mjs` (headless Chromium).
`IDB_KUC9_SMOKE=1` runs the same code path on a 2,000-row corpus in seconds, which is how the
driver itself is checked. The driver writes its report to a temp path by default so a gate can
never be tripped by a tracked write; `IDB_VECTOR_SIDE_STORE_REPORT=reports/side-store-query.json`
refreshes the committed report, deliberately. The pure parts are in `test-harness/side-store.js`,
covered by `tests/unit/side-store.test.mjs` in the fast tier.

This revision fixes two review findings on the first version of this measurement: the filtered
comparison was against a **resident-only** exact scan, and only aggregate medians were emitted
(no cold/warm per leg, one whole-block sample). Both are addressed below, and where the corrected
numbers change the conclusion it says so.

## What a single query does

Per corpus, in one fresh database: the originals are written as **100,000 individual
`{ id, embedding }` records** (`Float64Array`, the library's storage shape), the **int8 SQ8 codes
plus row norms and the affine tables** as one packed record, the eligibility mask as its own
record, and the corpus as one packed `Float32Array` for the snapshot path. Oracles are computed
from the resident vectors.

A timed side-store query is: read the code record and mask → scan the codes (`sq8Scan`) → **fetch
the top-N originals by key in a single readonly transaction** → rerank exactly in Float64
(`rerankFetched`). Every leg is recorded per query, and a **whole-block** observation per query
wraps all four legs inside one timer, so the end-to-end claim does not rest on a single sample or
on medians that are added together. The packed-Float32 path (one packed record read, exact scan)
and the library's batched page walk over the individual records (paged `getAll`, exact scan) are
timed in the same session for comparison.

## Conditions

Chrome 155.0.8059.39 headless, Intel Xeon Platinum 8259CL, commit `735904b`, **load average
4.27 / 4.98 / 5.10 on 2 vCPUs**. The run was preempted once for the merger and requeued, and
absolute milliseconds on this VM move with contention, so the **ratios within a run** are the
decision-grade part. Three runs of this driver bracket the published one and all three agree on
direction and rough magnitude:

| path per query | run A (load 8.68) | run B (load 2.10) | run C (published, load 4.27) |
|---|---:|---:|---:|
| side-store N = 100, 100k × 128 | 126.2 | 137.9 | 97.7 |
| side-store N = 100, 100k × 384 | 586.1 | 196.6 | 295.4 |
| packed Float32 + exact, 100k × 128 | 340.3 | 337.5 | 271.9 |
| packed Float32 + exact, 100k × 384 | 1528.4 | 1108.3 | 646.4 |
| batched record walk, 100k × 128 | 3101.1 | 4729.8 | 4093.4 |
| batched record walk, 100k × 384 | 8965.7 | 6264.2 | 9401.7 |

Across those runs the side-store is 2.0–2.8× faster than the packed-Float32 snapshot per query and
13–42× faster than the batched record walk; the spread is contention, not method. Sample sizes in
the published run: the side-store path is n = 30 queries at 128 dimensions (3 order-rotated
repetitions × 10 queries) and n = 20 at 384 (2 × 10); whole-block observations have the same n;
the packed-Float32 path is n = 6 (2 repetitions × 3 queries); the batched walk is n = 1, a single
query, so its figure is one measurement and its ratio rests on the mechanical byte difference as
much as on the sample. "Cold" is the first query of the run, before anything has read that record;
"warm" figures are medians of the remaining samples only.

## End-to-end query cost, published run (ms per query)

| path per query | n | 100k × 128 | 100k × 384 |
|---|---:|---:|---:|
| int8 codes + bounded rerank, N = 100 (recall@10 1.000) | 30 / 20 | **97.7** | **295.4** |
| int8 codes + bounded rerank, N = 300 (recall@10 1.000) | 30 / 20 | 107.9 | 320.0 |
| one packed Float32 record read + exact scan | 6 | 271.9 | 646.4 |
| batched page walk over individual records + exact scan | 1 | 4093.4 | 9401.7 |

The side-store figures are medians of per-query leg sums; whole-block medians come out slightly
lower (94.5 ms at N = 100 and 101.2 ms at N = 300 for 100k × 128; 262.8 / 326.9 at 384), which is
what the leg-summed table cannot show: separate leg medians are not one query's cost. Recall@10 is
1.000 for both candidate budgets and both the leg-summed and whole-block rankings, with a
candidate ceiling of 1.000.

## Cold and warm, per leg (published run)

The first query of the run is the only independent cold path — the reads after it are warm — so
cold is n = 1 and the warm column is the median of the rest.

| leg (ms) | 100k × 128 cold | 100k × 128 warm (n = 29) | 100k × 384 cold | 100k × 384 warm (n = 19) |
|---|---:|---:|---:|---:|
| read the code record + mask (13.2 MB / 38.8 MB packed) | 135.9 | 42.2 | 163.7 | 132.8 |
| scan the codes (keep = 300) | 79.2 | 37.6 | 119.2 | 104.8 |
| fetch N = 100 originals by key | 25.7 | 11.8 | 21.0 | 14.6 |
| fetch N = 300 originals by key | 27.2 | 22.5 | 36.8 | 26.9 |
| exact rerank of fetched rows (N = 300) | 0.1 | 0.1 | 0.3 | 0.2 |
| one packed Float32 record read (snapshot path) | 401.9 | 211.0 | 924.5 | 484.8 |
| exact scan of the packed record | 47.0 | 32.3 | 114.4 | 105.5 |

Whole-block cold / warm (n = 30 / 20): 370.4 / 94.5 ms at N = 100 and 168.8 / 101.2 ms at N = 300
for 100k × 128; 277.8 / 262.8 and 321.5 / 326.9 for 100k × 384. The cold figure is one sample and
includes first-touch effects after the corpus write; the warm medians are the reproducible numbers.
The code-record read is **43–45% of the warm query** at both dimensions (42.2 of 97.7; 132.8 of
295.4), so this path is a read-bandwidth trade, not an arithmetic trick — which is why it wins:
13.2 MB of code record instead of 51.2 MB of packed Float32 (12.8 MB of codes plus norms and
affine tables), or instead of ~102–307 MB of individually read records.

**Batching the rerank fetch is what makes the rerank affordable.** Measured here: 0.118 ms per get
at N = 100 and 0.075 ms at N = 300 (128 dimensions), 0.146 and 0.090 ms at 384 — against the
0.47 ms per get in `quantized-candidate-pass.md`, which was 1,000 serial one-shot transactions and
is now known to be an upper bound, 4–6× the batched figure.

## Predicate-before-candidate at 1% selectivity: a paired comparison

The first version of this section compared the IndexedDB side-store path against a **resident**
exact scan (0.8 ms) and concluded that a 1% query cannot benefit from codes. That comparison was
not apples-to-apples, and the corrected paired measurement says something more useful. All three
alternatives below read their data from IndexedDB in the same run, over the same 1,000 eligible
rows of 100k × 128, and all three reach recall@10 1.000:

| path | mask read | candidate work | fetch | rerank | leg-sum end-to-end | whole-block warm |
|---|---:|---:|---:|---:|---:|---:|
| int8 codes: masked scan, fetch top-300 | 43.0 | 1.6 | 20.0 | 0.1 | 72.3 | 70.0 |
| **exact over the eligible originals, fetched by key** | 0.6 | — | 62.0 | 0.3 | **67.4** | 69.1 |
| packed Float32 record read + masked exact scan | 190.8 | — | 1.3 (scan) | — | 192.6 | 187.9 |

*(leg-sum end-to-end is the median of per-query sums; whole-block warm is the median of the
per-query whole-block timings, n = 30. Cold whole-block: 80.2 ms, 112.0 ms, 244.7 ms.)*

**The exact path over the eligible originals is not slower than the code path — it is slightly
faster, and it is exact by construction.** At 1% selectivity the eligible set *is* the candidate
set: once a metadata index has produced 1,000 keys, fetching those 1,000 originals in one
transaction (62.0 ms warm, 0.062 ms per get) and ranking them exactly costs the same as reading
13.2 MB of codes to rank them approximately and then fetch a subset. Measured against the packed
Float32 read path the exact-eligible path is 2.7× faster, so the corrected conclusion is not "use
chunked codes for filtered queries" but **"do not use the code store for a query whose predicate
already leaves a small eligible set"**. Codes only help when the eligible set stays large relative
to the corpus, which is the unfiltered case measured above.

The cost of obtaining the eligible set is not free and is measured separately from the paths here:
this driver reads a stored 100 KB eligibility mask (0.6–43 ms depending on cache state), while the
library uses a metadata index for that step. Neither is an IDB index scan in this run, so the
comparison isolates the *ranking* paths, not the eligibility lookup. The earlier reference figure
of 13.5 ms for a metadata index at 1% selectivity is from a different host
([browser-analysis.md](browser-analysis.md)) and is not substituted for a measurement here.

## Revision pinning: the recall survived, the work did not

The side-store is advanced to revision 2 by deleting 25,000 rows (`id % 4 === 0`), clearing their
codes, updating the mask and writing a new record under the new revision stamp, then both
revisions are queried against the same live oracle (100k × 128, 300 candidates):

| revision queried | recall@10 | dead rows hit by the fetch |
|---|---:|---:|
| current (revision 2, mask applied) | 1.000 | 0 |
| stale (revision 1) | 1.000 | 772 of 3,000 candidate slots |

Recall did **not** drop at these parameters: with 300 candidates against 25% churn the rerank
simply skips the missing rows and the remaining live candidates still contain the true top-10. What
the stale revision costs is work — 772 fetches (about 26% of the 3,000 candidate slots) returned
nothing, so roughly 6 ms of the ~20 ms per-query fetch went to rows that no longer exist, and each
of those is a real read. So a stale side-store is not automatically *wrong*, it is silently
*wasteful*, and how far it degrades depends on the candidate budget relative to churn — which is
why a query must still pin one revision and reject a record it did not ask for, rather than relying
on the rerank to clean up. `tests/unit/side-store.test.mjs` pins the contract that makes that
enforceable: rows the pinned revision no longer has are skipped, never scored as zero, and a
wrong-width row is refused loudly rather than silently ranked.

## Write cost (same run, contended)

| corpus | writing 100,000 individual originals + the packed record + codes |
|---|---:|
| 100k × 128 (102.4 MB of records) | 30,724 ms |
| 100k × 384 (307.2 MB of records) | 29,283 ms |

This is the cost of the *comparison baseline's* storage shape as much as of the side-store: the
individual originals dominate the write, and the code record is one packed write on top (its CPU
build is 0.50 s at 100k × 128 and 5.15 s at 100k × 384 in
[quantized-candidate-pass.md](quantized-candidate-pass.md)). It is reported because a side-store
adds bytes and a write path, and neither is free; it is not a measured single-query write cost,
because the driver writes the whole corpus before any timing.

## Findings

1. **For an unfiltered read-per-query workload, the int8 code side-store with a bounded exact
   rerank is the fastest measured path**: 2.0–2.8× faster than reading a packed Float32 snapshot
   per query and 13–42× faster than the batched individual-record walk across three runs, at
   recall@10 1.000 with 100 candidates (candidate ceiling 1.000). The win is bytes read: the code
   record read is 43–45% of the warm query and 3.9× smaller than the packed Float32 record.
2. **For a selective predicate it is the wrong tool.** At 1% selectivity the exact path over the
   eligible originals fetched by key is 67.4 ms against 72.3 ms for the codes (whole-block warm
   69.1 vs 70.0 ms) — the same work, done exactly, with no code store to maintain. The eligible set
   *is* the candidate set at that selectivity, so codes add a lossy ranking step and 13.2 MB of
   reads for nothing. (This corrects the first version of this report, which compared the code path
   against a resident scan and overstated the gap in both directions.)
3. **Predicate *ordering* still matters** — `quantized-candidate-pass.md` measures predicate-after
   at 32.7 ms with recall 0.870 — but ordering is not sufficient: with a small eligible set, the
   exact eligible path is both simpler and at least as fast.
4. **int8 codes are a storage/read lever, not a speed one.** A resident scan of the codes is no
   faster than exact Float32 (`quantized-candidate-pass.md`), so this path is for the not-resident
   case only, beside the existing opt-in packed snapshot rather than replacing it.
5. **The rerank fetch, not the arithmetic, decides whether a side-store helps.** 0.075–0.146 ms per
   batched get; 1,000 serial gets (the earlier upper bound) cost 470 ms, more than an entire packed
   Float32 read, which is why the fetch must be one transaction and the candidate budget bounded.
6. **Bounded candidates are enough.** 100 candidates reached recall@10 1.000 on every corpus and in
   every run here and in `quantized-candidate-pass.md`; the budget costs 0.075–0.118 ms per get, so
   N = 100 buys the same answer for a fraction of the fetch.

## Decision

**Choose: an opt-in int8 code side-store with a bounded exact rerank (N ≤ 300) is worth
implementing for the read-per-query path — and it must not be used for selectively filtered
queries, which should fetch the eligible originals by key and rank them exactly.** Exact Float64
rerank stays the ranking contract; the codes only order candidates, and the fetch must be batched
in one transaction.

Conditions, each measured here:

1. **Small eligible set → skip the code store.** At 1% selectivity the exact eligible path is
   67.4 ms against 72.3 ms for the codes and reaches the same recall@10. The threshold to test
   before an implementation claims a win is the eligible-set size relative to the corpus, not the
   predicate's presence.
2. **A resident workload does not benefit at all.** The codes scan no faster than exact Float32, so
   this is for the not-resident case, beside the existing opt-in packed snapshot.
3. **Revision pinning is required.** A stale record that merely skips dead rows is silently
   wasteful (26% of candidate slots here) rather than safe, and the contract has to be enforceable.
4. **Quantization stays at int8.** 1-bit sign codes lose recall on well-spread data (0.770 at
   uniform 128D) and coarse buckets collapse on uniform data with a 7.3–42.5 s rebuild and no
   incremental path (`quantized-candidate-pass.md`).

Implementation is filed as `idb-vector-kuc.10`, with the two conditions and the batched-fetch
requirement among its acceptance criteria; its filtered-query requirement now reads "route to the
exact eligible path" rather than "chunk the code store". `index.js` is out of scope here.

## Boundaries

- Load average 4.27 during the published run and 2.10–8.68 across the three runs; the paths were
  timed in sequence within each session, not interleaved, so the ratios are the result and the
  absolute milliseconds are contended values. The three-run table is the honest statement of how
  much they move.
- Cold figures are one sample each and include first-touch effects after the corpus write, so only
  the warm medians should be quoted as reproducible.
- The batched walk is a single measurement; its ratio against the side-store is supported by the
  mechanical byte difference (every record read versus one packed code record) as much as by that
  sample.
- The eligibility source in the paired filtered comparison is a stored mask record, not the
  library's metadata index; the comparison isolates the ranking paths, and no metadata-index cost
  is claimed from this run.
- Recall is measured against an exact oracle over the same resident vectors, so it isolates the
  candidate pass and the fetch from read errors and from real query distributions. The fetched
  originals were verified row-for-row against the stored vectors at both dimensions.
- Synthetic uniform corpora only; real-corpus and larger-scale real-vector work is
  `idb-vector-kuc.7`. No multi-tab, quota, eviction or cold-disk claim; one process, one browser.
