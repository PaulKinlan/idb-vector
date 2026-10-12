# int8 code side-store, measured end to end on the IndexedDB read path

Bead `idb-vector-kuc.9`, answering the one hypothesis
[quantized-candidate-pass.md](quantized-candidate-pass.md) left open: a compact int8 code
side-store with a **bounded exact rerank** should cut the read leg of a query that reads from
IndexedDB. That report composed the estimate from separately measured legs; this one times every
leg inside one query, per query, and compares it with the exact read paths in the same run.

Research only: **`index.js` is untouched by this bead** and no side-store is implemented in the
library. Reproduce with `node tools/evaluate-side-store-query.mjs` (headless Chromium).
`IDB_KUC9_SMOKE=1` runs the same code path on a 2,000-row corpus in about a minute, which is how
the driver itself is checked; a smoke run writes its report to a temp path and never to
`reports/`. `IDB_VECTOR_SIDE_STORE_REPORT=reports/side-store-query.json` refreshes the committed
report, deliberately. The pure parts are in `test-harness/side-store.js`, covered by
`tests/unit/side-store.test.mjs` in the fast tier.

**How to read this report.** Part 1 is the unpredicated read-per-query measurement and stands on
its own: its numbers, its cold phase and its conclusion can be reviewed and used without Part 2.
Part 2 is the filtered-query comparison, which is a *different* methodology (a paired three-way
comparison plus a mutation control) and is the part that earlier revisions of this report got
wrong. Part 3 and Part 4 are the revision and write-cost measurements.

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

Chrome 155.0.8059.39 headless, Intel Xeon Platinum 8259CL, commit `68aa9cb`, **load average
2.96 / 2.04 / 1.62 on 2 vCPUs** (the least contended of the four runs below), no preemption. Each
corpus is written once, completely, before any timing.

Absolute milliseconds on this VM move with contention, so the **ratios within a run** are the
decision-grade part. Four full runs of this driver bracket the published one and all four agree on
direction and rough magnitude:

| path per query | run A (load 8.68) | run B (load 2.10) | run C (load 4.27, preempted) | run D (published, load 2.96) |
|---|---:|---:|---:|---:|
| side-store N = 100, 100k × 128 | 126.2 | 137.9 | 97.7 | 110.7 |
| side-store N = 100, 100k × 384 | 586.1 | 196.6 | 295.4 | 279.9 |
| packed Float32 + exact, 100k × 128 | 340.3 | 337.5 | 271.9 | 356.7 |
| packed Float32 + exact, 100k × 384 | 1528.4 | 1108.3 | 646.4 | 1053.3 |
| batched record walk, 100k × 128 | 3101.1 | 4729.8 | 4093.4 | 4386.8 |
| batched record walk, 100k × 384 | 8965.7 | 6264.2 | 9401.7 | 6328.4 |

Across those runs, at N = 100 per query, the side-store is **2.2–5.6×** faster than the
packed-Float32 snapshot and **15–42×** faster than the batched record walk. The packed ratio spans
that much because the packed path's own read leg is the noisy one (294.9–946.5 ms warm at 384
dimensions across the runs); the side-store's ratio is the more stable side of the comparison. Sample sizes in the published run: the side-store path
is n = 30 queries at 128 dimensions (3 repetitions × 10 queries) and n = 20 at 384 (2 × 10);
whole-block observations have the same n; the packed-Float32 path is n = 6 (2 repetitions × 3
queries); the batched walk is n = 1, a single query, so its figure is one measurement whose ratio
rests on the mechanical byte difference as much as on the sample.

Three terms, defined once and used exactly this way everywhere below:

- **warm median** — the median of samples taken after the first query of the first repetition.
- **first-read** — the first sample of a leg's series in the *warm* process. The record was written
  moments earlier, so this is a **cache-first read, not a cold one**. The N = 300 fetch series
  follows the N = 100 fetch inside the same query, so even its first sample is not a first fetch.
  No cold figure in this report is taken from the warm loop.
- **cold** — a single query run in a **new browser process** on the profile the warm phase wrote:
  fresh process, fresh IndexedDB connection, nothing timed before it in that process, and a query
  vector the warm loop never issued. That vector is corpus row 12345, clamped to `count - 1` for
  smaller corpora (the smoke corpus uses row 1999). It is not *disk*-cold: the bytes were written
  moments earlier and the OS page cache still holds them. It is process-cold, nothing stronger.

Repetition order rotates with each repetition (`(i + rep) % queries.length`), so the same records
are not replayed in the same sequence.

## Part 1 — the unpredicated read-per-query measurement

### End-to-end query cost (ms per query, warm medians, published run)

| path per query | n | 100k × 128 | 100k × 384 |
|---|---:|---:|---:|
| int8 codes + bounded rerank, N = 100 (recall@10 1.000) | 30 / 20 | **110.7** | **279.9** |
| int8 codes + bounded rerank, N = 300 (recall@10 1.000) | 30 / 20 | 132.6 | 291.3 |
| one packed Float32 record read + exact scan | 6 | 356.7 | 1053.3 |
| batched page walk over individual records + exact scan | 1 | 4386.8 | 6328.4 |

Whole-block medians (the same query with all four legs inside one timer) come out close to the
leg sums and are the figure to quote when a single-query cost is wanted: **104.7 ms** at N = 100 and
114.1 ms at N = 300 for 100k × 128; **256.2** and 289.7 ms at 384. Recall@10 is 1.000 for both
candidate budgets in the leg-summed and the whole-block rankings, with a candidate ceiling of
1.000. The code record is 3.9× smaller than the packed Float32 record (12.6 MB against 48.8 MB at
128 dimensions; 37.0 against 146.5 MB at 384), and measured one-read-to-one-read the difference is
even larger (294.9 ms against 63.6 ms warm at 128, 946.5 against 150.8 at 384).

### Per-leg cost (ms, published run)

| leg | 100k × 128 first-read | warm median (n = 29) | 100k × 384 first-read | warm median (n = 19) |
|---|---:|---:|---:|---:|
| read the code record + mask (12.6 MB / 37.0 MB packed) | 262.0 | 63.6 | 489.3 | 150.8 |
| scan the codes (keep = 300) | 90.6 | 31.8 | 121.1 | 90.0 |
| fetch N = 100 originals by key | 29.9 | 10.2 | 82.4 | 16.5 |
| fetch N = 300 originals by key | 43.4 | 18.9 | 64.9 | 34.2 |
| exact rerank of fetched rows (N = 300) | 0.1 | 0.1 | 0.3 | 0.3 |
| one packed Float32 record read (snapshot path, n = 6) | 268.8 | 294.9 | 1299.0 | 946.5 |
| exact scan of the packed record | 36.6 | 61.8 | 98.8 | 106.5 |

The code-record read is **55–59% of a warm query** (63.6 of 108.5 ms at 128 dimensions; 150.8 of
276.4 at 384), so this path is a read-bandwidth trade, not an arithmetic trick — which is why it
wins: 12.6 MB of code record instead of 48.8 MB of packed Float32, or instead of 97.7 MB of
individually read records. **Batching the rerank fetch is what makes the rerank affordable**:
0.102 ms per get at N = 100 and 0.063 ms at N = 300 (128 dimensions), 0.165 and 0.114 ms at 384 —
against the 0.47 ms per get in `quantized-candidate-pass.md`, which was 1,000 serial one-shot
transactions and is now known to be an upper bound, 3–7× the batched figure.

### Part 1's cold phase (fresh browser process, published run)

| configuration | legs (read + scan + fetch + rerank) | one whole-block query |
|---|---:|---:|
| 100k × 128, N = 100 | 227.7 (138.1 + 51.4 + 36.7 + 1.5) | **121.8** |
| 100k × 128, N = 300 | 156.4 (71.8 + 48.1 + 34.3 + 2.2) | 98.8 |
| 100k × 128, packed Float32 + exact | 364.3 (313.5 + 50.8) | 253.1 |
| 100k × 384, N = 100 | 501.0 (343.7 + 114.3 + 39.2 + 3.8) | 364.2 |
| 100k × 384, N = 300 | 231.9 (107.2 + 92.3 + 28.3 + 4.1) | 295.0 |
| 100k × 384, packed Float32 + exact | 1047.1 (945.3 + 101.8) | 651.4 |

Recall@10 is 1.000 in every cold observation. What this adds to Part 1: a query that is the first
thing a fresh process does costs **1.2–1.4×** the warm whole-block figure (121.8 against 104.7 at
128 dimensions; 364.2 against 256.2 at 384) and the cold read leg on the N = 100 observations is about 2.2× the warm read leg (138.1 against 63.6 ms
at 128 dimensions; 343.7 against 150.8 at 384) - and the N = 300 observations were taken *after*
those in the same fresh process, so they are not first reads either.
So the ranking in the end-to-end table is not an artefact of a warm-up loop: the side-store is
faster than the packed snapshot for a first query in a fresh process too (121.8 against 253.1 at
128 dimensions; 364.2 against 651.4 at 384). The cold *leg-sum* figures are noisier than the
whole-block ones because a first read in a new process has no cache history and the four legs are
measured separately; the whole-block column is the one to quote, and neither is a disk-cold claim.

## Part 2 — filtered queries: a paired three-way comparison

This part has its own methodology and is the part that failed review twice. All three alternatives
below read their data from IndexedDB **in the same run, over the same 1,000 eligible rows of
100k × 128**, and all three reach recall@10 1.000:

| path | eligibility source (timed) | candidate work | fetch | rerank | leg-sum end-to-end | whole-block warm |
|---|---|---:|---:|---:|---:|---:|
| int8 codes: masked scan, fetch top-300 | mask read from the code record, 63.1 ms | 2.0 | 48.8 | 0.2 | 100.2 | 101.7 |
| **exact over the eligible originals, fetched by key** | stored mask read + id derivation, 2.7 ms | — | 86.8 | 0.4 | **89.8** | 86.4 |
| packed Float32 record + masked exact scan | packed read 277.2 ms + stored mask 5.7 ms | 1.7 (scan) | — | — | 296.5 | 272.0 |

*(n = 30 for every leg and for the whole-block column; per-leg figures are warm medians.)*

**Every one of those legs reads its eligibility from IndexedDB inside its own timed query.** The
codes path uses the mask that travels with the code record; the exact path reads the stored mask
record and derives the eligible ids from that value, timed as `eligibleIdRead`; the packed path
reads the stored mask record and passes that value to the scan. No leg is filtered by a resident
array, and that is not asserted but *demonstrated*: the negative control **overwrites the stored
mask record** with a different 1% mask (`id % 100 === 8`), re-runs the three measured leg functions
unchanged, and requires each to change its top-10 and to match the oracle *of the wrong mask* —
then restores the record and verifies the restore.

```
mask probe: stored mask differs from resident by 0 bytes | probe mask served back true | every leg
changed under the stored probe mask and matched its oracle: codesTop=true exactTop=true packedTop=true
```

Concretely, the codes leg's top-10 moves from `6707,8507,23107,…` to
`15208,23408,29808,…`, and the same holds for the exact and packed legs. A leg that had quietly kept
using the resident array would have returned its baseline and failed this.

**The corrected conclusion: the exact path over the eligible originals is not slower than the code
path — it is 7–20% faster, and it is exact by construction.** At 1% selectivity the eligible set
*is* the candidate set: once a metadata index has produced 1,000 keys, fetching those 1,000
originals in one transaction (86.8 ms warm, 0.087 ms per get) and ranking them exactly costs less
than reading 12.6 MB of codes to rank them approximately and then fetch a subset. Measured in three
runs (loads 2.10 / 4.27 / 2.96), the paired figures are 96.9 vs 116.6, 67.4 vs 72.3 and 89.8 vs
100.2 ms — the exact path wins in all three, by 7–17% (16.9% / 6.8% / 10.4%). Against the packed Float32 read path the
exact-eligible path is 3.3× faster. So the conclusion is not "chunk the code store for filtered
queries" but **"do not use the code store for a query whose predicate already leaves a small
eligible set"**. Codes only help when the eligible set stays large relative to the corpus, which is
the unpredicated case in Part 1.

The cost of obtaining the eligible set is measured separately from the ranking paths and is not free:
this driver reads a stored 100 KB eligibility mask (2.7 ms for the exact path's read + id derivation;
63.1 ms inside the codes path, where it is a read of the code record's accompanying mask), while the
library uses a metadata index for that step. Neither is an IDB index scan here, so this comparison
isolates the *ranking* paths, not the eligibility lookup; the earlier 13.5 ms metadata-index figure
is from a different host ([browser-analysis.md](browser-analysis.md)) and is not substituted for a
measurement.

## Part 3 — revision pinning: the recall survived, the work did not

The side-store is advanced to revision 2 in **its own database** (the main database is deliberately
left as written, so Part 1's cold phase still measures the corpus it describes): 25,000 rows
(`id % 4 === 0`) are deleted from that store, their codes cleared, the mask updated and a new record
written under the new revision stamp. Both revisions are then queried against the same live oracle
(100k × 128, 300 candidates):

| revision queried | recall@10 | dead rows hit by the fetch |
|---|---:|---:|
| current (revision 2, live mask applied) | 1.000 | 0 |
| stale (revision 1) | 1.000 | 772 of 3,000 candidate slots |

Recall did **not** drop at these parameters: with 300 candidates against 25% churn the rerank simply
skips the missing rows and the remaining live candidates still contain the true top-10. What the
stale revision costs is work — 772 fetches (about 26% of the 3,000 candidate slots) returned nothing,
so roughly a quarter of the fetch leg went to rows that no longer exist. A stale side-store is
therefore not automatically *wrong*, it is silently *wasteful*, and how far it degrades depends on
the candidate budget relative to churn — which is why a query must still pin one revision and reject
a record it did not ask for, rather than relying on the rerank to clean up.
`tests/unit/side-store.test.mjs` pins the contract that makes that enforceable: rows the pinned
revision no longer has are skipped, never scored as zero, and a wrong-width row is refused loudly
rather than silently ranked.

## Part 4 — write cost

| corpus | originals as individual records + packed snapshot + codes (main database) | revision-2 store (75,000 rows + record) |
|---|---:|---:|
| 100k × 128 | 20,891 ms | 16,508 ms |
| 100k × 384 | 47,359 ms | not measured (no revision leg at this size) |

This is the cost of the *comparison baseline's* storage shape as much as of the side-store: the
individual originals dominate the write, and the code record is one packed write on top (its CPU
build is 0.50 s at 100k × 128 and 5.15 s at 100k × 384 in
[quantized-candidate-pass.md](quantized-candidate-pass.md)). It is reported because a side-store
adds bytes and a write path, and neither is free; it is not a measured single-query write cost,
because the driver writes the whole corpus before any timing.

## Findings

1. **For an unfiltered read-per-query workload, the int8 code side-store with a bounded exact
   rerank is the fastest measured path**: 2.2–5.6× faster than reading a packed Float32 snapshot
   per query and 15–42× faster than the batched individual-record walk across four runs, at
   recall@10 1.000 with 100 candidates (candidate ceiling 1.000). The win is bytes read: the code
   record read is 55–59% of the warm query and 3.9× smaller than the packed Float32 record. A cold
   first query in a fresh process keeps the same ordering.
2. **For a selective predicate it is the wrong tool.** At 1% selectivity the exact path over the
   eligible originals fetched by key costs 89.8 ms against 100.2 ms for the codes (whole-block warm
   86.4 vs 101.7 ms), and wins by 7–17% in all three runs where the pair was measured (16.9% / 6.8% / 10.4%). The eligible
   set *is* the candidate set at that selectivity, so codes add a lossy ranking step and 12.6 MB of
   reads for nothing.
3. **Predicate *ordering* still matters** — `quantized-candidate-pass.md` measures predicate-after
   at 32.7 ms with recall 0.870 — but ordering is not sufficient: with a small eligible set, the
   exact eligible path is both simpler and faster.
4. **int8 codes are a storage/read lever, not a speed one.** A resident scan of the codes is no
   faster than exact Float32 (`quantized-candidate-pass.md`), so this path is for the not-resident
   case only, beside the existing opt-in packed snapshot rather than replacing it.
5. **The rerank fetch, not the arithmetic, decides whether a side-store helps.** 0.063–0.165 ms per
   batched get; 1,000 serial gets (the earlier upper bound) cost 470 ms, more than an entire packed
   Float32 read, which is why the fetch must be one transaction and the candidate budget bounded.
6. **Bounded candidates are enough.** 100 candidates reached recall@10 1.000 on every corpus and in
   every run here and in `quantized-candidate-pass.md`.

## Decision

**Choose: an opt-in int8 code side-store with a bounded exact rerank (N ≤ 300) is worth
implementing for the read-per-query path — and it must not be used for selectively filtered
queries, which should fetch the eligible originals by key and rank them exactly.** Exact Float64
rerank stays the ranking contract; the codes only order candidates, and the fetch must be batched
in one transaction.

Conditions, each measured here:

1. **Small eligible set → skip the code store.** At 1% selectivity the exact eligible path is
   89.8 ms against 100.2 ms for the codes and reaches the same recall@10. The threshold to test
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
requirement among its acceptance criteria; its filtered-query requirement reads "route to the exact
eligible path" rather than "chunk the code store". `index.js` is out of scope here.

## Boundaries

- Load average 2.96 during the published run and 2.10–8.68 across the four runs; paths were timed in
  sequence within each session, not interleaved, so the ratios are the result and the absolute
  milliseconds are contended values. The four-run table is the honest statement of how much they
  move.
- **Cold** means a fresh browser process on the same profile, a fresh connection and a query the
  warm loop never issued. The bytes were written moments earlier, so it is not disk-cold and no
  page-cache-miss claim is made. Cold observations are one sample each per configuration.
- The batched walk is a single measurement; its ratio against the side-store is supported by the
  mechanical byte difference (every record read versus one packed code record) as much as by that
  sample.
- The eligibility source in Part 2 is a stored mask record, not the library's metadata index; the
  comparison isolates the ranking paths, and no metadata-index cost is claimed from this run.
- The negative control proves each filtered leg responds to the stored mask. It does not prove that
  the *library's* eligibility lookup behaves the same way, because no such lookup is exercised here.
- Recall is measured against an exact oracle over the same resident vectors, so it isolates the
  candidate pass and the fetch from read errors and from real query distributions. The fetched
  originals were verified row-for-row against the stored vectors at both dimensions.
- Synthetic uniform corpora only; real-corpus and larger-scale real-vector work is
  `idb-vector-kuc.7`. No multi-tab, quota, eviction or cold-disk claim; one process at a time, one
  browser, and every browser this driver starts is closed on exit and on SIGTERM/SIGINT/SIGHUP.
