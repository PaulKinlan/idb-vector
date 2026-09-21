# Opt-in packed snapshots and whitening

Implementation and runnable browser checks accompany this report. Source SHA-256s, tree/diff, observed time, browser/CPU/conditions, raw repetitions and real corpus identity are in [packed-snapshot.json](packed-snapshot.json). Read the [storage experiment first](packed-read.md).

## Final measured query results

At 2026-09-21T21:54:59.608Z, Chromium 152.0.7977.82, Ryzen 9 9955HX:

| Corpus | Default query median | Warm packed query median | Snapshot build | Allocated packed bytes |
|---|---:|---:|---:|---:|
| Real Wikipedia MiniLM, 2,000 × 384 | 50.5 ms | 3.0 ms | 62.5 ms | 6,291,456 |
| Seeded uniform, 100,000 × 128 | 964.6 ms | 41.1 ms | 1,331.1 ms | 104,857,600 |

Three distinct queries per corpus (IDs 42/43/44), not a p95 latency study. All six
results had byte-identical Float64 keys/scores in the same order (k10). Warm speedup
does not include snapshot build, which is **not free** and must amortize over queries.
The packed-read experiment's single-record read is not this snapshot's build path:
this implementation builds from existing records without migrating durable storage.

Real corpus diagnostic: dominance **0.004195295734544831**, equal-share baseline
1/384, relative dominance **1.6109935620652152**, warning null. Opt-in whitening
changed all three top-10 rankings; each retained 8 of the original 10 neighbours.
Those are overlap measurements, not proof of improvement or recall against relevance.

## API and durability

**Additive public API:** `VectorDB.createSnapshot({maxBytes})`, `diagnose(vectors)` and `fitWhitening(vectors, options)`. Existing `query()` remains an authoritative cursor scan returning `{object,key,similarity}`. Inserts/updates/deletes now resolve only after transaction completion; a successful request followed by abort rejects instead of falsely acknowledging storage.

A snapshot query returns **`{mode, results: [{key, similarity}]}`**, intentionally without document metadata. Its vectors are frozen until `refresh()`. Other connections, inserts, deletes and updates do not silently refresh it. Budget failure evicts the entire packed cache and returns to a live cursor query; **no rows are dropped**. Every query labels the path used. `mode`, `reason`, `bytes`, `diagnostic` and `formatVersion` are inspectable; `close()` releases the packed buffers and disables the snapshot (not the parent database connection).

Only numeric IDB keys and dense finite numeric vectors are packed. Unsupported keys/vectors fall back to the original live scoring path. Different vector lengths retain existing length eligibility. Snapshot query input must be finite numeric coordinates. Malformed stored data may still fail in the legacy live path; this is not a comprehensive validation rewrite.

## Resource bound and format

No automatic device RAM guess, hard corpus limit, or write-behind. The caller provides `maxBytes`, based on its own available memory. This bounds **retained packed buffers**, not total browser heap: IDB deserializes one record at a time, diagnostic moments retain O(d) mean/variance, block descriptors and top-k results also consume memory. Arbitrarily large individual source records and caller-requested k cannot be made free. Refresh evicts the old cache before building a replacement.

Version 1 is an **in-memory layout**, not a persisted database migration or portable file API. Each record is native Float64 `[numericKey, dimension, ...coordinates]`; block `used` counts Float64 elements; no record spans blocks. Finite original JS numbers survive exactly. Blocks are at most 1 MiB unless one record itself requires more, and never exceed the remaining caller budget. The block size avoids reallocating/copying a growing 100 MB buffer; it is an allocation granularity, not a corpus-size cap or a claimed optimum. ArrayBuffer allocation failure also evicts to the live path. No new durable serialization is introduced: existing IndexedDB schema version 1 and structured-clone records remain authoritative.

On the measured 100k×128 fixture, encoded data requires 104,000,000 bytes (102,400,000 vector bytes plus 1,600,000 key/length bytes). The test grants that amount plus one block of padding; inspect `allocatedBytes` in the raw report for actual allocation. Above the budget, the fallback is whole-cache eviction, **not chunked persistent paging**. This is the smallest safe implementation of the requested resource bound.

## What was actually verified

Real Chromium and real IndexedDB: byte-for-byte Float64 keys/scores including order, three queries each over committed 2,000×384 Wikipedia MiniLM vectors and 100,000×128 seeded vectors. Same scorer/records, k10, warm IDB, alternating order. Build cost is recorded separately from warm queries. The source geometry diagnostic is computed once per snapshot refresh, not once per query.

The checks also drive external writes, stale-before-refresh/live-default-after-write, budget eviction without truncation, nonnumeric-key fallback, close, insert/update/delete transaction rollback, full-covariance whitening, inverse reconstruction, rank-deficient fitting with regularization, invalid inputs and a low-dimensional isotropic non-warning. Screenshot [packed-snapshot.png](screenshots/packed-snapshot.png) captures the browser's textual outcomes; it was not visually inspected. Negative-control failures are preserved in [packed-negative-controls.txt](packed-negative-controls.txt).

Whitening is compared on the real corpus in separate original/transformed databases, using the **same fit for corpus and queries**. Top-k overlap is recorded, not called recall or quality improvement. No held-out relevance labels, mobile memory limits, GPU/WASM, persisted packed pages, HNSW/IVF, or cold-disk measurements were added.

## Geometry caveats

`dominance` is max coordinate variance / total coordinate variance. Equal-share variance is `1/d`; `relativeDominance` is dominance × d. The warning requires both >0.01 and >2× equal share. The dimension-relative guard is an explicit heuristic, **not** a threshold established by the cited paper. It prevents low-dimensional isotropic corpora (e.g. 25D, dominance ≈0.04) being automatically branded crowded. Constant corpora report null dominance; mixed-dimension diagnostics report their limitation.

Coordinate variance misses correlated anisotropy. A high value invites a comparison, never automatic preprocessing. Unchanged rankings do not prove isotropy. The real MiniLM diagnostic and transformed top-k results are in the raw artifact.

`fitWhitening` performs full-covariance Cholesky whitening with a positive ridge (default 1e-6 times mean variance). It does **not** merely standardize dimensions or remove top PCs. The fit exposes `transform` and `inverse`; neither mutates inputs. Fitting costs O(n d² + d³), with O(d²) extra memory, and should run in a worker for large corpora. Rank-deficient matrices are regularized; constant or numerically invalid inputs refuse. Keep the fit alive and reuse it; serialization of fitted transforms is not part of this change.

Whitening is off by default. It is an experiment for crowded embeddings, not a general improvement. The referenced research reports a 0.014 cosine-correlation drop when projecting out top directions in well-spread encoders; **that intervention is not identical to this whitening transform**, and its pairwise-correlation evidence is not retrieval recall evidence. Developers must compare their own held-out retrieval results. Original vectors and original default behavior remain available at all times.
