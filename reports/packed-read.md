# Packed reads: hypothesis supported, not a new default

Observed 2026-09-21 on source `5f77c81` plus `tests/packed-read.mjs` in this commit. Raw browser/version/CPU/conditions and all samples: [packed-read.json](packed-read.json). Reproduce: `node tests/packed-read.mjs`.

Fresh headless Chromium 152 profile, AMD Ryzen 9 9955HX, warm IndexedDB after committed writes; not cold disk or an isolated host. Synthetic seeded 100,000 × 128 coordinates, three rotated repetitions:

| Operation | Median ms |
|---|---:|
| Read one 51.2 MB Float32Array | 31.4 |
| Read one 102.4 MB Float64Array | 93.6 |
| Read individual JS-array records with 1000-row getAll pages | 742.9 |
| Cosine arithmetic over resident Float64Array, without top-k | 8.6 |

256 serial random record reads, each in a new readonly transaction: summed request times 13.9 / 9.8 / 9.5 ms; wall time 14.7 / 10.2 / 9.7 ms. p95 request time ~0.1 ms; p50 0–0.1 ms because the browser clock is quantized. These warm, small-record reads do **not** establish HNSW build cost, recall, cold-disk performance, or graph traversal viability.

The research's 130 ms arithmetic estimate was from another engine/workload; measured arithmetic is 8.6 ms here. Per-record reads dominate, but subtracting timings from different implementations is not an exact profiler decomposition. Packed reads support an opt-in memory cache experiment. Neither `93.6+8.6` nor the original `796` is a measured end-to-end cached query time. This experiment tests paginated reads of individual records, **not** persisted packed chunk records; it does not rule out chunked persistence.

Float32 changes values (first coordinate -0.527088949456811 → -0.5270889401435852). Existing library arrays contain JS Float64 values and are **not** normalized on write. Preserving exact scores requires Float64, twice the proposed payload memory.

## Approved implementation adjustment

Keep authoritative IDB queries as the default: other connections and the object-store escape hatch can modify the database. Add explicit opt-in packed snapshots, refresh, and a caller-provided vector-byte budget with eviction/live cursor fallback. Return keys/scores rather than pretend live metadata belongs to an old snapshot. Keep writes transaction-complete before acknowledging; no write-behind. No HNSW/IVF selection is warranted by this measurement alone.
