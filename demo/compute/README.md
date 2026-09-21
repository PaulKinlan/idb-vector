# Cosine compute and storage lab

Open `demo/compute/index.html`. Press **Run comparison**: nothing is loaded until then.
No runtime dependencies, API keys or library API changes. This is a measurement/demo,
not a production storage or GPU backend. The Wikipedia demo is unchanged.

## Reproduce

```
sh tools/build-cosine-wasm.sh    # clang with wasm32 + SIMD128; shipped binary also included
node tests/compute.mjs          # fresh-profile Chromium; default hardware selection
COMPUTE_BROWSER_ARGS='["--enable-unsafe-webgpu","--enable-features=Vulkan","--use-angle=vulkan","--disable-vulkan-surface"]' COMPUTE_OUTPUT=/tmp/compute-vulkan node tests/compute.mjs
COMPUTE_URL=https://paulkinlan.github.io/idb-vector/demo/compute/index.html node tests/compute.mjs
```

The flags are an explicit *test condition*, not a browser setting users must change.
Safari 26 has WebGPU support; capability detection, not a browser-name blacklist,
chooses whether GPU measurements are possible. Missing GPU or SIMD is displayed by
name/error, never disguised as a measurement of that engine.

## Comparison contract

- Exact same Float32 input values, synthetic uniform LCG seed 42, default 100k × 128
  (51,200,000 bytes per packed copy). Current library receives lossless JS Arrays of
  those Float32 values. No semantic relevance/anisotropy claim follows from this data.
- Three queries: corpus row 7, then independent LCG seeds 987 and 12345. Each query
  runs once per available engine with order rotated. No hidden warmup, no medians
  from mixed query samples, no claim about cold OS caches or an idle machine.
- **Library:** unchanged `VectorDB.query`, its current cosine implementation,
  IndexedDB cursor, own top-k. Same database as the storage measurement.
- **Packed JS:** in-memory exact cosine, double accumulators, common JS top-k.
- **WASM-SIMD:** C source + reproducible clang build, actual SIMD128 intrinsics,
  Float32 cosine, common JS top-k. Full corpus copied once into linear memory;
  copy and total setup (fetch/compile/allocate/copy) recorded separately.
- **WebGPU:** WGSL matrix-vector cosine, one invocation per row; four-channel
  accumulation, Float32 inputs/outputs; common JS top-k after full score readback.
  Corpus upload timing starts at `queue.writeBuffer` and ends at
  `queue.onSubmittedWorkDone`. Pipeline compilation/allocation are in total setup,
  not upload. Query timing includes query upload, dispatch, mapping, score readback,
  score copying and top-k. It is end-to-end wall time, **not a GPU timestamp**.
- Every query shows actual ordered top-k IDs, overlap and maximum absolute score
  error over every corpus score for compute engines. The unchanged library only
  exposes top-k; its error comparison is limited to shared returned neighbours.
  CPU and GPU are **not promised bit-identical**. FP rounding and near ties can
  change ranking; the UI reports disagreement rather than rounding it away.
- No GPU top-k, buffer chunking, batching or tuned matrix tiling. Device buffer limits
  produce an explicit refusal, not partial answers. A slow kernel is a result about
  this implementation/device, not a limit on WebGPU.

## Storage: what the numbers include

One write and one read per layout, in a fresh randomly named database/file. All
floats are compared after each read. Writes await transaction completion or stream
close. Reads include materialisation. Timings do not isolate disk, structured clone
and allocation. Writes are not forced physical-media fsync measurements.

| Layout | Semantics and complexity |
|---|---|
| Individual IDB records | Same Array-valued records and embedding index as today's library; one write transaction; cursor read packs into Float32. Per-row mutation and metadata indexes remain possible. Larger representation/index and record overhead. |
| Packed IDB snapshot | One Float32Array value, one transaction. Fast bulk restore; replacing one row means replacing the snapshot here. Chunking, versioning, key/metadata mapping and invalidation need design before production. |
| OPFS snapshot | Raw Float32 bytes via async writable stream and File.arrayBuffer. No metadata/key index, dimension/version header, multi-file transaction or recovery protocol. Whole-file replacement here; worker sync-access/paged I/O are different experiments. |

The records use JS number Arrays and an index; snapshots use typed Float32 bytes.
Thus this compares **actual layout choices**, not equal physical byte volumes or
an isolated IDB-vs-filesystem syscall. OS caching, host load and origin storage quota
matter. Persisting a whole corpus in memory/GPU costs extra copies. No artificial
retention/size cap is added to the library. Temporary OPFS files are removed after
running. IDB deletion is queued until page closure because VectorDB has no close API.

## Hypotheses, not facts

The earlier research's 6–51ms upload and 666/130ms IDB/scoring split were cross-source
estimates. This lab tests the former directly; it measures read/materialisation and
scoring separately but **does not prove that exact historical decomposition**.
GPU break-even must be compared against *resident CPU*, not just an IDB query that
also pays storage overhead. Faster storage alone is not evidence for a new API.

Raw measurements and host/tree provenance are kept under `reports/compute/` in the
source repository. Tests drive the Run button, assert actual neighbour agreement,
exercise a negated-score mutant, capture screenshots (not interpreted by the agent),
and check narrow-screen overflow. Independent visual review remains separate.
