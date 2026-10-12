# int8 code side-store, measured end to end on the IndexedDB read path

Bead `idb-vector-kuc.9`, answering the one hypothesis
[quantized-candidate-pass.md](quantized-candidate-pass.md) left open: a compact int8 code
side-store with a **bounded exact rerank** should cut the read leg of a query that reads from
IndexedDB. That report composed the estimate from separately measured legs (~114 ms against
328 ms at 100k × 128); this one times every leg inside one query, per query, and compares it with
the two exact paths in the same run. The headline is a median of per-query leg sums, with one
whole-block single-query check at 128 dimensions (n = 1, 141.9 ms against a 126.2 ms leg sum, +12%)
— there is no whole-block corroboration at 384 dimensions.

Research only: **`index.js` is untouched by this bead** and no side-store is implemented in the
library. Reproduce with `node tools/evaluate-side-store-query.mjs` (headless Chromium, ~12 minutes
under load; writes `reports/side-store-query.json`). `IDB_KUC9_SMOKE=1` runs the same code path on
a 2,000-row corpus in seconds, which is how the driver itself is checked. The pure parts are in
`test-harness/side-store.js`, covered by `tests/unit/side-store.test.mjs` in the fast tier.

## What a single query does

Per corpus, in one fresh database: the originals are written as **100,000 individual
`{ id, embedding }` records** (`Float64Array`, the library's storage shape), the **int8 SQ8 codes
plus row norms and the affine tables** as one packed record, the eligibility mask as its own
record, and the corpus as one packed `Float32Array` for the snapshot path. Oracles are computed
from the resident vectors.

A timed side-store query is: read the code record and mask → scan the codes (`sq8Scan`) → **fetch
the top-N originals by key in a single readonly transaction** → rerank exactly in Float64
(`rerankFetched`). The packed-Float32 path (read one packed record, scan it exactly) and the
library's batched page walk over the individual records (read every record with paged `getAll`,
scan exactly) are timed in the same session for comparison.

## Conditions

Chrome 155.0.8059.39 headless, Intel Xeon Platinum 8259CL, commit `3005c4c`. **Load average
8.68 / 7.17 / 5.33 on 2 vCPUs** — the run was preempted once for the merger and requeued, and the
machine was heavily contended throughout, so absolute milliseconds here are inflated relative to
[quantized-candidate-pass.md](quantized-candidate-pass.md) (measured at load 2.06). The paths were
timed in sequence (side-store first, then the packed path, then the batched walk), not interleaved,
so the **ratios within the run** are the decision-grade part and the absolute values are not.
Sample sizes: the side-store path is n = 30 queries at 128 dimensions (3 order-rotated repetitions
× 10 queries) and n = 20 at 384 (2 × 10); the packed-Float32 path is n = 6 (2 repetitions × 3
queries); the batched record walk is n = 1, a single query, so its figure is one measurement under
load 8.68 and the ratio for it rests on the mechanical byte difference as much as on the sample.
"Cold" is the first query of the first repetition (N = 100); the N = 300 figure labelled cold is the
first N = 300 query, which follows the N = 100 legs, so it is not a cold measurement and is not
quoted as one. One process, warm page cache, no p95 claim.

## End-to-end query cost (median ms per query)

| path per query | n | 100k × 128 | 100k × 384 |
|---|---:|---:|---:|
| int8 codes + bounded rerank, N = 100 (recall@10 1.000) | 30 / 20 | **126.2** | **586.1** |
| int8 codes + bounded rerank, N = 300 (recall@10 1.000) | 30 / 20 | 166.3 | 661.8 |
| one packed Float32 record read + exact scan | 6 | 340.3 | 1528.4 |
| batched page walk over individual records + exact scan | 1 | 3101.1 | 8965.7 |

n is the number of timed queries behind each figure at 128 / 384 dimensions (the packed and batched
paths are the same n at both). The first two rows are medians of per-query leg sums; the last two
are medians of whole blocks.

The side-store path is **2.7× faster than reading the packed Float32 snapshot** at 100k × 128 and
2.6× at 100k × 384, and **24.6× / 15.3× faster than the batched individual-record walk** at the
same recall@10 (1.000 at both candidate budgets; candidate ceiling 1.000). The hypothesis is
confirmed, and the earlier composition was accurate: 126.2 ms measured against ~114 ms composed,
340.3 ms measured against 328.0 ms composed.

## Where the time goes

| leg (median ms) | 100k × 128 | 100k × 384 |
|---|---:|---:|
| read the code record + mask (13.2 MB / 38.8 MB packed) | 75.4 | 327.5 |
| scan the codes (keep = 300) | 48.9 | 192.2 |
| fetch N = 100 originals by key | 10.6 | 38.7 |
| fetch N = 300 originals by key | 25.4 | 101.5 |
| exact rerank of fetched rows, N = 300 | 0.1 | 0.3 |
| one query timed as a whole block, first query of the run (N = 100, n = 1) | 141.9 | 2212.1 |

Per-leg figures are medians of that leg; the end-to-end figures are medians of per-query sums, so
the legs do not add up to the end-to-end column exactly.

The **read of the code record is 55–60% of the whole query**, so this path is a read-bandwidth
trade, not an arithmetic trick — which is exactly why it wins: 13.2 MB of code record instead of
51.2 MB of packed Float32 (12.8 MB of codes plus the row norms and the affine tables), or instead
of ~102–307 MB of individually read records. The byte and time ratios agree: codes are 3.9× smaller
than the packed Float32 record and read 3.7× faster (75.4 ms against 281.7 ms). The single-whole-query
number at 128 dimensions (141.9 ms) matches the sum of the legs (126.2 ms), so the composition is
sound; at 384 dimensions the first query (2212.1 ms) is dominated by one-time effects
(higher cold read plus write flush) and is not used in the decision.

**Batching the rerank fetch is what makes the rerank affordable.** Measured here, one get costs
0.106 ms at N = 100 and 0.085 ms at N = 300 (128 dimensions), 0.387 / 0.338 ms at 384 — against the
0.47 ms per get in `quantized-candidate-pass.md`, which was 1,000 serial one-shot transactions and
is now known to be an upper bound, 4.4–5.5× the batched figure.

## Predicate-before-candidate at 1% selectivity: necessary but not sufficient

Masked codes scan and rerank 1,000 eligible rows at 100k × 128:

| leg | ms |
|---|---:|
| read the code record + mask (the whole 13.2 MB record) | 75.4 |
| masked scan (scores only the 1,000 eligible rows) | 2.0 |
| fetch N = 300 eligible candidates by key | 27.6 |
| **end-to-end (recall@10 1.000, ceiling 1.000)** | **87.0** |

Scoring is not the problem — the masked scan is 2.0 ms, because it only scores 1% of the rows. The
problem is that the **code record is packed whole**, so a 1% query still reads all 13.2 MB. (The
predicate summary records the end-to-end figure and its scan and fetch legs; its rerank is inside
that end-to-end and is not recorded separately.) The
exact eligible scan measured 0.8 ms in `quantized-candidate-pass.md`; this path is 87 ms for the
same answer. A side-store only helps a filtered query if the codes are stored in a form the
predicate can skip — per-bucket or per-page chunks, or codes for the eligible set only — otherwise
the exact scan over the eligible rows stays the better path. Predicate *ordering* is necessary
(the same measurement in `quantized-candidate-pass.md` puts predicate-after at 32.7 ms and recall
0.870) but it is not sufficient on its own.

## Revision pinning: the recall survived, the work did not

The side-store is advanced to revision 2 by deleting 25,000 rows (`id % 4 === 0`), clearing their
codes, updating the mask and writing a new record under the new revision stamp, then both
revisions are queried against the same live oracle:

| revision queried | recall@10 | dead rows hit by the fetch |
|---|---:|---:|
| current (revision 2, mask applied) | 1.000 | 0 |
| stale (revision 1, 300 candidates) | 1.000 | 772 of 3,000 candidate slots |

Recall did **not** drop at these parameters: with 300 candidates against 25% churn the rerank
simply skips the missing rows and 225 live candidates still contain the true top-10. What the stale
revision costs here is work — 772 fetches (about 26% of the 3,000 candidate slots) returned
nothing, so roughly 6.5 ms of the ~25 ms per-query fetch was spent on rows that no longer exist,
and each of those is a real read. So a stale side-store is not automatically *wrong*, it is silently *wasteful*, and how far it
degrades depends on the candidate budget relative to churn — which is why a query must still pin
one revision and reject a record it did not ask for, rather than relying on the rerank to clean up.
`tests/unit/side-store.test.mjs` pins the contract that makes that enforceable: rows the pinned
revision no longer has are skipped, never scored as zero, and a wrong-width row is refused loudly
rather than silently ranked.

## Write cost (same run, contended)

| corpus | writing 100,000 individual originals + the packed record + codes |
|---|---:|
| 100k × 128 (102.4 MB of records) | 28,978 ms |
| 100k × 384 (307.2 MB of records) | 48,171 ms |

This is the cost of the *comparison baseline's* storage shape as much as of the side-store: the
individual originals dominate the write, and the code record is one packed write on top (its CPU
build is 0.50 s at 100k × 128 and 5.15 s at 100k × 384 in
[quantized-candidate-pass.md](quantized-candidate-pass.md)). It is reported because a side-store
adds bytes and a write path, and neither is free; it is not a measured write single-query cost,
because the driver writes the whole corpus before any timing.

## Decision

**The measured hypothesis holds for a workload that reads from IndexedDB per query: an int8 code
side-store with a bounded exact rerank (100–300 candidates) is worth implementing as an opt-in
path.** On this evidence it is 2.6–2.7× faster than reading a packed Float32 snapshot per query and
13.5–24.6× faster than the batched individual-record walk, at recall@10 1.000 and a candidate
ceiling of 1.000 on both corpora. Exact rerank stays the ranking contract; the codes only order
candidates, and the rerank fetch must be batched in one transaction (that is what makes it cheap).

Two conditions come with it, both measured here:

1. **A filtered query does not benefit** while the code record is packed whole: 87.0 ms for a 1%
   selection, against 0.8 ms for the exact eligible scan, because the whole 13.2 MB record is read
   regardless. Chunking or predigesting the code store for the predicate is a prerequisite, not a
   follow-up optimisation.
2. **A resident workload does not benefit at all.** `quantized-candidate-pass.md` measured int8
   codes scanning no faster than exact Float32; this path wins by reading fewer bytes from
   IndexedDB, so it is for the not-resident case only, and it must sit beside the existing opt-in
   packed snapshot rather than replace it.

Implementation is filed as `idb-vector-kuc.10`, with those two conditions and the batched-fetch
requirement among its acceptance criteria. `index.js` is out of scope here (another lane owns that
file while the paging path is removed).

## Boundaries

- Load average 8.68 during the measured run; the paths were timed in sequence within one session,
  so treat the ratios as the result and the absolute milliseconds as contended values. The
  two-run agreement with the independently composed estimate in `quantized-candidate-pass.md` is
  what makes the conclusion robust.
- Recall is measured against an exact oracle over the same resident vectors, so it isolates the
  candidate pass and the fetch from read errors and from real query distributions. Candidate code
  bytes and the fetch were verified row-for-row against the stored vectors (all four sampled rows
  matched bit for bit at both dimensions).
- Synthetic uniform corpora only; the real-corpus and larger-scale real-vector work is
  `idb-vector-kuc.7`. No multi-tab, quota, eviction or cold-disk claim; one process, one browser.
- The side-store read leg was not measured for adversarial or clustered corpora, where
  `quantized-candidate-pass.md` shows 1-bit codes become competitive.
