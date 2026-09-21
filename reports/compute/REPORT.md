# GPU, SIMD and storage: measured comparison

## Scope and status

Demo-only experiment; `index.js`, public API and Wikipedia demo unchanged.
Measured source **e40cede406fbe27a7a7cb29687c4d54e407d5010**, tracked diff empty.
Raw inputs/conditions/results: [Vulkan run](vulkan/measurement.json),
[default run](default/measurement.json). Screenshots captured, not visually reviewed.
Local real-browser button drive passed; **Pages publication/live drive awaits review
and main landing**. Expected path after landing: `/idb-vector/demo/compute/`.

## Conditions applying to every number below

Synthetic uniform LCG seed 42, **100,000 × 128 Float32** (51.2 MB), k=10.
Queries: self row7, independent seeds987/12345. Chrome **152.0.7977.82**, headless,
Linux 7.2.3-arch1-3, Ryzen **9 9955HX**, 32 logical CPUs, 98.8GB reported RAM.
GPU adapter reports **AMD / RDNA-2 / isFallbackAdapter:false**; device description
redacted/empty. `lspci` identifies **Granite Ridge [Radeon Graphics] (rev d8)**.
Vulkan run used `--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=vulkan
--disable-vulkan-surface`. Load start 5.32/6.50/4.47, end 5.80/6.56/4.51.
Fresh profile/database, not cold disk, host not isolated. Three different queries,
one run each, rotated engine order, no hidden warmup. These are **not** percentile
estimates or cross-device guarantees. See full JSON for local URLs and timestamps.

## Compute results — milliseconds, Vulkan run

| Query | Current library, including IDB | Resident JS | WASM-SIMD | WebGPU |
|---|---:|---:|---:|---:|
| Self row7 | 1020.9 | 14.9 | 7.5 | 29.5 |
| Independent987 | 935.2 | 16.8 | 2.7 | 24.4 |
| Independent12345 | 955.8 | 24.0 | 2.6 | 25.3 |

**One-time GPU corpus upload: 33.1ms**, with queue completion awaited.
Total GPU setup 46.3ms (pipeline/allocate/upload); not included in per-query figures.
WASM corpus copy 13.1ms; total fetch/compile/allocate/copy setup 18.1ms.
All query timings include full scores returned to JS, copied, and common top-k;
the library uses its own current top-k path. This is not a GPU-kernel-only benchmark.

**Every ordered top-10 matched across all four paths for all three queries**;
overlap 1.0. Scores were NOT bit-identical: max absolute error over 300,000 scored
pairs was **7.88324e-8 (WASM)** and **8.87295e-8 (GPU)** vs double-accumulator JS.
Library shared-top-k score error ≤2.22045e-16; library does not expose all scores.
The fixed synthetic sample has no observed boundary reorder. Near ties on other
corpora remain a real precision risk, not a promise of universal equality.

Default headless Chrome, with no GPU-enabling flags, returned
**`requestAdapter returned null`**. Same-source fallback run: current library
988.7/951.4/988.6ms; resident JS14.4/11.6/12.5ms; WASM8.3/2.8/2.7ms. Ordered top-k
matched there too. WebGPU availability is environment-dependent; Safari26 supports
it, so the earlier blanket “no Safari” claim was wrong.

## Storage results — milliseconds, same Vulkan run/corpus/tree

| Layout | Write incl transaction commit/stream close | Read and materialise | All floats exact |
|---|---:|---:|---|
| Individual IDB Arrays + current embedding index | 5102.6 | 1203.6 | yes |
| One packed IDB Float32Array | 73.1 | 38.5 | yes |
| One OPFS raw Float32 file | 35.4 | 13.0 | yes |

Default run read figures were1254.6/41.3/14.5ms; write5434.4/71.5/39.8ms.
One sample per layout per run; fixed order, caching/load not controlled. Records
include the current library's index and JS number Array representation; snapshots
do not. **This is a comparison of layouts, not an isolated storage-engine contest.**
Cursor read includes packing into Float32. No fsync guarantee/cold-disk claim.

- **Records:** independent row updates and IDB indexes/transactions remain available.
- **Packed IDB:** transactional snapshot, but row changes rewrite it here. Production
  needs chunking/versioning, stable key/metadata maps and invalidation across writers.
- **OPFS:** low overhead bulk bytes, but no row/metadata index or multi-file
  transaction. Requires format/dimensions/version, recovery and key mapping. This
  measures async streams/File.arrayBuffer, not worker sync-access/paged I/O.

All three temporarily coexist in this experiment. Extra memory copies are material;
no artificial library size/retention limit has been introduced.

## What held, and what did not

1. The predicted **6–51ms upload** bracket contained this **33.1ms** measurement.
   It was a prediction, not prior local evidence. This single device does not
   establish a universal bracket.
2. **GPU did not win against resident CPU.** It took24–30ms vs JS15–24ms and SIMD
   3–8ms in this implementation. There is **no GPU break-even vs SIMD here**.
   Comparing GPU against the ~1s storage-bound library alone hides the storage/layout
   change. SIMD won without a GPU, and a better tiled GPU kernel/GPU top-k might
   change the result; this experiment does not establish a GPU hardware ceiling.
3. The research's **~130ms arithmetic / ~666ms read** decomposition was an estimate
   from different sources. Resident JS here took15–24ms while cursor materialisation
   took1204ms. We did not instrument the original baseline, so its precise split
   remains unproven. Packed reads being fast supports the layout hypothesis, not
   that numerical decomposition.
4. The proposed1–2ms GPU query was not observed. No relevance, real-embedding,
   whitening, mobile, million-vector or multi-browser quality claims follow.

## Checks

`node tests/compute.mjs` and the explicit Vulkan invocation in the demo README pass
on the measured source. Real clicks, exact storage roundtrip, three-way/four-way
top-k, full-score tolerances, self match, mobile overflow, SIMD tie ordering, and a
negated-score mutant rejected by the comparison instrument. `npm test` passed on
968b3fc (before the later error-scope label/OPFS-failure tightening); no library edit.
Rebuild using `sh tools/build-cosine-wasm.sh` (clang22, SIMD128 intrinsics, no libc).
Screenshots are evidence captures, not a visual approval.

## Additional precision falsification (same runtime, after review candidate)

A deliberate near-tie corpus makes the precision caveat observable, not hypothetical.
Twelve128D rows are `[1, (12-id)*1e-6, 0, …]`; query is `[1,0,…]`.
Double-accumulator CPU returns IDs11→2; **both SIMD and GPU return IDs0→9** because
all their Float32 scores round to1 and ties sort by ID. Ordered agreement is false,
top-10 overlap **0.8**, and maximum absolute score difference is only
**7.199996e-11**. Small score error does not imply identical neighbours.

Preserved [runnable-check output](near-ties.json); the added fixture lives in
`tests/compute.mjs`. Runtime is unchanged from e40cede. Test run uses the same
Chrome152 / AMD RDNA2 Vulkan setup as above. This is an intentional numeric
edge case, not a relevance benchmark or an excuse to silently claim exact answers.
The three seeded100k queries still match; universal top-k equivalence is disproved.
`npm test` also passed after this added check. Rebuilding cosine.wasm with clang22
reproduces SHA256 `a0c8c33b448f77ed76498de4ce7a990a8a35505aa69703677dd19199a2eb7457`.

## Live GitHub Pages acceptance

Driven **https://paulkinlan.github.io/idb-vector/demo/compute/index.html** with real
Run-button input after main merged the independently reviewed candidate. Served
assets (including library and WASM binary) were individually SHA256-compared to
main **2dc41082d0c3bd4ee4177266b90a5d316504b6a1**; see
[live binding](live/served-assets.json) and [raw run](live/measurement.json).
The measurement JSON's `conditions.commit` is the **test-driver** commit fba3546,
not a claim that Pages serves that commit.

Same100k×128 synthetic corpus, Chrome152, Ryzen9955HX and AMD RDNA2 Vulkan flags
as above: GPU upload**29.7ms**, queries**27.5/23.1/25.7ms**; resident JS
**13.8/16.1/19.4ms**, SIMD**6.5/2.6/2.5ms**, existing library
**907.0/882.4/915.4ms**. All three seeded query ordered top-10s match.
Storage write/read ms: records**5210.0/1146.4**, packedIDB**69.7/38.9**,
OPFS**34.2/12.1**; exact roundtrips. Host load/browser provenance in live JSON.
The live near-tie fixture again reports overlap0.8 for both SIMD and GPU;
negated-score check rejects, narrow390px layout has no page overflow. Screenshots
captured. No visual-review claim. This closes the earlier local-only acceptance
limitation; it does not extend the result to other devices or real embeddings.
