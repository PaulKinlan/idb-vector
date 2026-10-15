# Real-vector IndexedDB recall: GloVe and Wikipedia embeddings

## Scope and reproducibility

Machine evidence: [`real-glove-2026-10-15.json`](real-glove-2026-10-15.json) and [`real-wiki-2026-10-15.json`](real-wiki-2026-10-15.json). These are actual headless Chromium 155 / IndexedDB drives, not in-memory simulations. The driver in `tests/real-vectors.mjs` used `IDB_REAL_CORPORA=glove25-10000,glove25-100000,glove25-1183514` and `IDB_REAL_REPORT=reports/real-glove-2026-10-15.json`; the browser code is `test-harness/real-vectors.js`. Browser before/after screenshots are the matching `glove25-*-{library,ivf}-{before,after}.png` files in this directory, except there is **no full-size IVF after screenshot** because that run timed out. Each JSON retains raw query-level measurements, manifest hashes, oracle outputs, run conditions, and disk observations. The separate Wikipedia run used `IDB_REAL_CORPORA=wiki-api-10000` and `IDB_REAL_REPORT=reports/real-wiki-2026-10-15.json`; its screenshots are `wiki-api-10000-{library,ivf}-{before,after}.png`.

The corpus is the SHA-256-pinned `glove-25-angular.hdf5` from ANN Benchmarks (`51004cb0ae962159f0db507a51fec2b395de14b166f55976c89f16bd2f8b6391`). The 40 official test vectors are held out; train prefixes of 10,000 and 100,000 rows are **slices**, not synthetic vectors. Independent NumPy float64 exhaustive cosine truth is recomputed against each slice, never taken by truncating the source's full-corpus neighbours. For the full 1,183,514-row corpus, all 40 source neighbour sets agree with recomputed truth (minimum set recall 1.0; maximum source angular-distance discrepancy 1.43e-8, under the 2e-6 tolerance). For the slices, the source's full-corpus neighbours are **not** claimed to be slice ground truth. The browser asserts the exact cursor and full-probe IVF results against the independent oracle; the negative control deliberately supplies disjoint IDs and requires the recall assertion to fail.

Both approaches bulk-load 1,000 records per native IndexedDB transaction. `library` queries the unchanged `VectorDB.query` cursor implementation; experimental IVF lives entirely in the harness, uses 64 offline-trained spherical-k-means cells with an IndexedDB `cell` index, probes 1/4/16/64 buckets and exact-cosine reranks. Its offline training plus assignment time is included in the total-build column, not in per-query latency. These are not equivalent indexes: the library schema retains its vector-array index and IVF replaces it with a cell index. Results reflect this comparison, not a claim about an index-only disk footprint or `VectorDB.insert` throughput.

Host: 2 logical Xeon Platinum 8259CL CPUs, 8.32 GB RAM, Linux 6.12.93; start load averages 1.91/1.67/0.79. Each method/corpus uses a fresh Chromium profile. Readings are warm/recent-write, on a shared machine, not cold-cache or controlled repeated trials. Each p50/p95 is over **40 distinct held-out queries** (nearest-rank percentiles); probe order rotates by query. Disk is actual Chromium `Default/IndexedDB` files after one second idle with the browser open, including records, indexes and log residue; it is not an index-only or compacted measurement. Download/checksum time is excluded from build time.

## GloVe results

All reported recall values are set recall@10 against the independently recomputed slice/full truth; tie-aware recall matches these numbers. Latencies and build times are milliseconds, disk is logical MB (decimal). `IVF total build` adds offline training/assignment to browser build. `Candidates` is the mean number of vectors visited per query. Each row has 40 measured queries.

| Rows | Method / probes | p50 ms | p95 ms | Recall@10 | Candidates | Browser build ms | Total build ms | IndexedDB MB |
|---:|:---|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | Exact cursor | 257.8 | 1385.5 | 1.0000 | 10,000 | 1508.2 | 1508.2 | 5.75 |
| 10,000 | IVF / 1 | 7.1 | 14.8 | 0.5775 | 216.4 | 884.2 | 1361.9 | 3.50 |
| 10,000 | IVF / 4 | 31.2 | 69.3 | 0.8475 | 723.3 | 884.2 | 1361.9 | 3.50 |
| 10,000 | IVF / 16 | 106.6 | 282.6 | 0.9875 | 2,649.8 | 884.2 | 1361.9 | 3.50 |
| 10,000 | IVF / 64 | 437.0 | 1220.1 | 1.0000 | 10,000 | 884.2 | 1361.9 | 3.50 |
| 100,000 | Exact cursor | 1843.3 | 3330.7 | 1.0000 | 100,000 | 20966.7 | 20966.7 | 69.89 |
| 100,000 | IVF / 1 | 68.8 | 173.8 | 0.5900 | 1,866.3 | 18819.4 | 19135.2 | 46.21 |
| 100,000 | IVF / 4 | 438.0 | 1249.0 | 0.9175 | 7,080.3 | 18819.4 | 19135.2 | 46.21 |
| 100,000 | IVF / 16 | 1307.9 | 2682.5 | 0.9925 | 26,427.3 | 18819.4 | 19135.2 | 46.21 |
| 100,000 | IVF / 64 | 5176.4 | 11355.0 | 1.0000 | 100,000 | 18819.4 | 19135.2 | 46.21 |
| 1,183,514 | Exact cursor | 22949.3 | 46604.1 | 1.0000 | 1,183,514 | 348973.1 | 348973.1 | 478.11 |
| 1,183,514 | IVF | — | — | — | — | — | — | — |

**Incomplete full-size IVF:** Its browser run began after the successful 1,183,514-row exact run but did not finish within the driver's 1,800-second `waitFor` bound. The gate exited 1 after 3,748 seconds, so the partial JSON has five successful runs, no final `finishedAt`, and no full-size IVF measurement/disk reading. The corresponding before screenshot only proves the page was opened. Do not extrapolate 100k recall/latency to 1.18M or call the entire gate a pass. A bounded, separately designed full-size experiment is follow-up work; rerunning the unchanged 30-minute timeout is not validation.

## Anisotropy diagnostic

The norm of the **mean of unit-normalized training vectors** is 0.4310/0.4320/0.4312 for 10k/100k/full. Subtracting the **raw training-vector mean** from both training and held-out queries before normalization changes the original-vs-centered top-10 sets: mean overlaps are 0.7700/0.7575/0.7875, respectively. This is a rank-sensitivity diagnostic, not a relevance improvement: there are no relevance labels and the centered oracle is not used for the main recall figures. Per-query overlaps and both truth lists are in the manifest embedded in the JSON.

## Wikipedia API embeddings

The approved, opt-in `tools/embed-wikipedia.mjs --embed` run retrieved public Wikipedia article extracts (167 attributed articles, 10,040 distinct 200–600-character passages), then embedded them via `text-embedding-3-small` at **256 dimensions**. Forty passage embeddings were held out as queries; 10,000 remained as training vectors. The script's preflight cap is **$0.25 estimated**, with cached batches and no automatic retries on ambiguous billed requests. The provider reported **949,845 tokens**, yielding **$0.0189969 estimated** at the recorded $0.02/million-token published rate; this is not a billing invoice. The cache source identity SHA-256 is `47513db5051c5469f2efb3948ad0af8bc336e8318645e98bcc2c0175c4431bd4`, vector SHA-256 is `e1626d9c3819085e277397d6004bdac90e13f9e9a15f25e39d895c8a1281349c`, retrieved 2026-10-15T22:46:01Z. The evidence JSON contains the article titles, URLs, page/revision IDs for CC BY-SA 4.0 attribution but neither Wikipedia passage text nor credentials. Wikipedia itself supplies **no ground truth** for this embedding set: NumPy independently recomputed exact float64 cosine neighbours across the 10,000 candidates.

Both methods completed in real IndexedDB with the same 40 held-out queries and the same schema/build/disk conditions described above. These are text embeddings, **not** the GloVe word vectors in the earlier table. Each row has 40 queries; the Wikipedia browser gate passed with two completed runs.

| Rows | Method / probes | p50 ms | p95 ms | Recall@10 | Candidates | Browser build ms | Total build ms | IndexedDB MB |
|---:|:---|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | Exact cursor | 396.6 | 667.9 | 1.0000 | 10,000 | 3647.9 | 3647.9 | 46.80 |
| 10,000 | IVF / 1 | 14.6 | 29.5 | 0.7475 | 241.4 | 1293.9 | 1594.5 | 25.07 |
| 10,000 | IVF / 4 | 56.4 | 113.6 | 0.9450 | 906.2 | 1293.9 | 1594.5 | 25.07 |
| 10,000 | IVF / 16 | 169.2 | 302.2 | 0.9975 | 3,148.8 | 1293.9 | 1594.5 | 25.07 |
| 10,000 | IVF / 64 | 595.2 | 873.2 | 1.0000 | 10,000 | 1293.9 | 1594.5 | 25.07 |

The mean unit-vector norm is **0.3434**. Subtracting the raw training mean from both candidates and queries before normalization gives mean original-vs-centered top-10 set overlap **0.9525**; 14/40 sets changed. This is rank sensitivity only, **not** a relevance gain. Per-query values and centered truth are in the Wikipedia manifest in the JSON.
