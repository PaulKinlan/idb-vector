# Packed-read decision recheck — 2026-10-12

The original [packed-read measurement](packed-read.md) and [opt-in snapshot
implementation](packed-snapshot.md) are already on `main`. This is an independent
repeat of the existing focused browser experiment, not a new search path. Full
samples, browser/hardware identity, commit, and conditions are in
[packed-read-2026-10-12.json](packed-read-2026-10-12.json). Reproduce with
`node tests/packed-read.mjs` (it writes `reports/packed-read.json`; preserve the
prior report when repeating).

Headless Chromium 155 on Intel Xeon Platinum 8259CL, fresh temporary browser
profile, warm IndexedDB after committed writes, seeded 100,000 × 128 vectors.
Three order-rotated repetitions, 1,000-row `getAll` pages, and 256 serial
random gets per repetition (fresh readonly transaction per get):

| Workload | Three runs (ms, sorted) | Median (ms) |
|---|---:|---:|
| Read one packed 51.2 MB Float32Array | 112.4 / 124.6 / 512.1 | 124.6 |
| Read one packed 102.4 MB Float64Array | 348.7 / 574.9 / 3,341.7 | 574.9 |
| Read 100k individual object records | 2,917.5 / 6,255.9 / 6,436.6 | 6,255.9 |
| Resident Float64 cosine arithmetic, no top-k | 37.2 / 125.8 / 201.4 | 125.8 |
| 256 serial random single-record reads | 88.3 / 109.3 / 127.3 | 109.3 |

Across random-read repetitions, request p50 was ~0.2 ms and p95 was 0.4–0.7 ms;
the clock is quantized. The median individual-record scan was **10.9×** slower
than the median packed Float64 read, and **50.2×** slower than packed Float32.
At the median, arithmetic took ~2% of individual-record scan time, but these are
different operations and this ratio is not a profiler attribution. The first
Float32 element differs from the original JS number
(-0.5270889401435852 vs -0.527088949456811), so Float32 is **not** an
exact-score replacement for the library's Float64-valued vectors. Large spread
in packed read and arithmetic timings, VM load 5.78/3.13/1.74, and changed CPU
and Chrome relative to the 2026-09-21 run mean these are directional warm
measurements, not a stable p95 or cold-disk claim.

## Decision

**Choose (a): keep the implemented opt-in packed Float64 in-memory snapshot**
with explicit refresh, caller byte budget and live fallback; retain the default
authoritative IndexedDB scan. The measurement supports per-record read and
structured-clone overhead as a major cost at this size, and the existing
[end-to-end snapshot measurement](packed-snapshot.md) already demonstrates
41.1 ms warm snapshot vs 964.6 ms live query at 100k × 128 on a different host,
with exact keys and Float64 scores across three queries. Snapshot construction
(1,331.1 ms there) and its ~105 MB allocated packed buffers must amortize and
fit the caller's budget. A single packed-record read here is **not** a measured
snapshot query; neither measurement proves an automatic cache is appropriate.

**Do not choose (b) IVF yet:** bucket-index probing, recall, parameter tuning,
and persistence are not measured here. IVF remains the candidate if a bounded
snapshot does not fit a workload's memory budget or frequent writes make
refresh costly. **Do not choose (c) HNSW over IndexedDB yet:** 256 warm random
gets do not measure multi-hop graph traversal, construction/update cost, recall,
or cold cache behavior. The ~0.4 ms median wall cost per serial random read
(109.3/256) is an observation, not a graph latency projection. An in-memory
HNSW also needs a separate memory/build/recall comparison before adoption.
Quantization remains a memory lever, not a demonstrated query-speed gain here.
Keep cosine as the default; this experiment does not compare metrics.
