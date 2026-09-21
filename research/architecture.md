# Research: idb-vector architecture — query-space reduction, WebGPU, and the anisotropy claim

**Baseline read:** `reports/browser-analysis.md` on `analysis/browser-baseline`
(commit `e346cc45`, harness `1662ae6f`). 14 / 92 / 942 ms at 1k / 10k / 100k × 128D;
category index 735 ms → 13.5 ms; post-filter 0/10 eligible neighbours.
**Research run:** 2026-09-21. **Library not modified.**

**Evidence labels used throughout:** `[established]` peer-reviewed or textbook-consensus;
`[measured]` a specific number someone actually ran; `[one paper]` a single result;
`[contested]` sources disagree; `[inference]` my reasoning over the sources, not a source's claim.

---

## Summary

Paul's memory is right on two counts and imprecise on one. **HNSW over IndexedDB does effectively
become "load the graph into memory"** — every shipping browser implementation materialises the graph
(MeMemo keeps "the keys and HNSW graphs in the RAM"; hnswlib-wasm puts the whole index in the WASM heap
via Emscripten's IDBFS; browservec persists the graph in a snapshot so loads skip a ~180× rebuild) — and
the build cost is brutal (~94 minutes for 1M×384D per MeMemo's own paper). **WebGPU is a realistic path,
and the CPU↔GPU transfer is not the blocker**: 100k×128D is 51.2 MB, uploads at roughly 6–51 ms once,
versus a ~900 ms brute-force query. **But the real bottleneck is upstream of the GPU** — the baseline's
own numbers imply ~670 of the 796 ms paged-scan is IndexedDB per-record read/deserialise overhead, not
arithmetic, so any ANN-or-GPU plan that leaves per-record IDB reads in place buys a fraction of the number
it appears to. On the metric question: Paul's memory points at a real line of work, the term of art is
**anisotropy** (not "ellipsoid"), and the most recent comprehensive study concludes cosine is *already
correct* for fine-tuned retrieval embedders and only fails on strongly anisotropic ones — so it does not
justify changing idb-vector's default.

### The four answers, in one line each

1. **HNSW:** yes, it becomes an in-memory load. At idb-vector's scales it is not worth it; **IVF over
   IndexedDB is better shaped to the platform** and is the same trick the baseline already proved works.
2. **Jason Mayes:** memory **confirmed** — `jasonmayes/VectorSearch.js` is a client-side vector search
   library with a custom IndexedDB vector DB and WebGPU/TF.js cosine similarity. But he has published
   **no metadata filtering**; the only filter is a cosine-score threshold. Correct that part.
3. **WebGPU:** realistic today on Chrome/Edge/Safari 26, *not* on Firefox stable outside Windows.
   Transfer ≈ 6–51 ms once for 100k×128 = **20–150× cheaper than one 900 ms brute-force query**.
4. **Anisotropy:** real, well-cited, but Paul's framing is imprecise and the practical conclusion is the
   opposite of what the intuition suggests — **keep cosine**.

---

## 1. Query-space reduction — is HNSW the answer in a browser?

### 1a. The platform constraint, stated precisely

`[established]` IndexedDB is a key-range store. It can select by object-store key or `IDBIndex` +
`IDBKeyRange`; it cannot rank a cursor by cosine, cannot accept a JS predicate as an index comparator,
and cannot traverse a pointer graph cheaply. This is not an implementation gap — it is the API. The
baseline report already establishes the usable primitives: equality/range selection, compound keys for
lexicographic ordering, and multi-entry indexes for tag membership.

### 1b. The central question: can HNSW traverse over IndexedDB?

**Answer: no — in practice every implementation materialises the graph. The honest answer to Paul's
question is "it becomes a load", with one nuance: the graph must be resident, the *vectors* can
sometimes stay on disk.**

Three independent pieces of direct evidence:

| Project | What is resident in RAM | What is in IndexedDB |
|---|---|---|
| **MeMemo** (Georgia Tech, SIGIR 2024) | "the keys and HNSW graphs" | "all vector values", with a prefetch cache of *p* vectors |
| **hnswlib-wasm** (Emscripten port of C++ hnswlib) | the whole index — it lives as a file in the WASM virtual FS | IDBFS syncs that virtual FS to IndexedDB |
| **browservec** M7 HNSW + M7b GPU graph search | graph in memory / GPU storage buffers | versioned binary snapshots |

MeMemo's paper is explicit that the graph is the thing it could not put on disk:
*"In IndexedDB, MeMemo stores all vector values, while only keeping the keys and HNSW graphs in the
RAM."* The rest of §3.2 is an account of the workaround — a prefetch cache sized by vector dimension,
used *because* "reading or writing a large amount of data to IndexedDB with consecutive transactions is
extremely slow", and because "the HNSW construction process requires consecutive reads and writes of
vector values, as the algorithm relies on the previously constructed index for finding good neighbors."
That is the platform problem in one sentence: HNSW's build and search are both random-access over a
graph, and IDB's per-record access is the expensive operation.

hnswlib-wasm is even plainer — it uses Emscripten's `IDBFS`, i.e. a real filesystem image inside the
WASM linear heap, synced to IndexedDB as blobs. The index is loaded whole. This also inherits
Emscripten's default 2 GB memory-growth ceiling, which is a hard limit on index size for any IDBFS-based
approach.

### 1c. What it costs at 10k / 100k / 1M

`[measured]` The one primary-source browser build number I could find: **MeMemo, in the paper's own
"Challenges" section — "In Chrome on a 64GB RAM MacBook, it took about 94 minutes to insert 1 million
384-dimensional vectors (M=5, efConstruction=20)."** Query is described only qualitatively: "querying
this index with 1M items is still performed in real time." MeMemo's own README chart in the paper
apparently holds the query figures; I could not extract them as text, so I am not quoting a latency.

`[inference]` Extrapolating 94 min/1M to smaller N is not clean, because HNSW insertion is
superlinear overall (per-insert search cost grows with `log N` at fixed `efConstruction`, and the
constant is large in a browser). A rough order-of-magnitude read at M=5/efC=20, 384D:
~10k ≈ tens of seconds to a couple of minutes; ~100k ≈ minutes to ~10 minutes; ~1M ≈ ~1.5 hours.
**Do not quote these as measurements.** They are the shape of the cost, and the shape is the point:
*HNSW build time in a browser is minutes at 100k, not milliseconds.*

`[measured]` Independent corroboration of the build-cost problem, from a third party who benchmarked
the existing libraries head to head at 10k × 1536D: "MeMemo's HNSW was faster at 17 ms [vs 37 ms for
pure-JS brute force]. But building the index took minutes."

`[measured]` And the counter-result that matters most: the same author implemented HNSW in his own
Rust/WASM library and **flat search beat it at every scale he tested, at dim 1536**:

| Scale (dim 1536) | Flat (exact) | HNSW ef=200 | Winner |
|---|---|---|---|
| 1k | 0.83 ms | 0.95 ms | Flat, 1.14× |
| 5k | 4.1 ms | 4.4 ms | Flat, 1.08× |
| 10k | 8.2 ms | 8.8 ms | Flat, 1.07× |

His stated reason — *"at 1,536 dimensions, each hop in the HNSW graph traverses a massive vector space.
The 'neighbourhood structure' that makes HNSW efficient at low dimensions becomes noise at high
dimensions"* — is a real geometric effect, but I'd flag the deeper cause as the memory access pattern
rather than the geometry. He also volunteers the counter-hypothesis untested: "HNSW would probably win
(untested) at dim=128 with 500k+ vectors." **idb-vector is at dim=128 — which is exactly the untested
regime in every source I found.** That is a genuine gap, not a resolved question.

`[inference]` Memory residency at 128D, which is the regime idb-vector actually lives in:
- 100k × 128 × 4 B = **51.2 MB** of vectors. Trivial.
- 1M × 128 × 4 B = **512 MB** of vectors. Fine in a tab, at the edge of mobile.
- An HNSW graph at M=16 with bidirectional links ≈ 1M × 2 × 16 × 4 B ≈ **128 MB**. Fine.
- So at 128 dims, MEMORY is not the constraint at any scale idb-vector plausibly targets. **Build time
  and recall risk are**, and neither is bought back at these sizes.

### 1d. Browser-native options, with what each actually buys

All numbers below are labelled with their source; **none of them are at 128 dimensions**.

| Family | What it buys | Build cost | Storage | Recall | Browser fit |
|---|---|---|---|---|---|
| **Brute force flat fp32** | exactness, zero index | none | 4 B/dim | 1.0 | perfect — `[measured]` browservec 1.71 ms/q at 20k×384 GPU |
| **IVF / flat** | `[measured]` 3.4× over flat at 20k×384 (1.71 → 0.51 ms/q), recall 1.000 | k-means: seconds–minutes at 100k | + 1 bucket id (**indexable**) | tunable via `nprobe` | **best-shaped for IDB** — see below |
| **IVF-PQ** | ~32× compression | k-means + codebook training | ~32× smaller | material loss, needs rerank | little to gain at 100k×128 |
| **HNSW** | best recall/latency *if resident* | `[measured]` ~94 min/1M@384D | graph ≈ 128 MB at 1M/M=16 | high | worst fit — graph must be resident |
| **ScaNN** | anisotropic vector quantisation, server-scale | heavy | — | high | server-side design |
| **DiskANN / Vamana** | billion-scale on SSD | heavy | SSD | high | **not implementable as designed** |
| **LSH** | no training, cheap, bucketable | ~free (random projections) | + hash bands | poor at high precision; candidate-gen only | browser-friendly but little win at 100k |
| **Annular / "ring" index** | — | — | — | — | **could not find this as an ANN family — see Missing evidence** |

**IVF over IndexedDB is the option that is isomorphic to the platform.** The recipe:
run k-means over the vectors; store the *c* centroids in a tiny separate object store; write a `bucket`
field per record; create an `IDBIndex` on `bucket`; at query time score the *c* centroids (fast, tiny),
pick the nearest `nprobe` bucket ids, read those cells with a key range, and rerank the candidates
exactly. Every primitive it needs is one the baseline already demonstrated:

- The baseline's category-index experiment cut a 100k scan from **735 ms to 13.5 ms** by reading
  1,000 of 100,000 records through an index. IVF is *the same read pattern with learned clusters instead
  of a label column*. `[inference — high confidence]`
- `[measured]` browservec, which ships exactly this, reports IVF fp32 at **0.51 ms/q vs 1.71 ms/q for
  flat** at 20k×384 on an M-series GPU, recall@10 = 1.000, and supports `targetRecall: 0.95` to
  auto-tune `nprobe` against recall measured on the user's own data.

Note the caveat on those browservec recall figures: **everything in their table is 1.000, including
1-bit quantisation.** Their own text calls it "a small, growing device matrix, not an exhaustive one."
Treat `recall = 1.000` there as "not yet discriminating at this scale", not as evidence that
quantisation is lossless.

**DiskANN is a genuine dead end in a browser.** `[established]` It exists precisely to serve a graph
from SSD with a page-aligned layout and a custom I/O path — the paper's contribution is the SSD access
pattern (NeurIPS 2019). A browser has no page-level disk access; OPFS gives you file I/O, not
authority over read-ahead or alignment. The nearest browser analogue to DiskANN is "load the whole
thing", which is HNSW-with-extra-steps.

**Quantisation is a memory lever, not a speed lever, at these scales** — and this directly contradicts
the intuitive plan. `[measured]` browservec, 20k×384, M-series GPU:

| Config | recall@10 | Query latency |
|---|---|---|
| flat fp32 | 1.000 | **1.71 ms/q** |
| flat int8 | 1.000 | 1.52 ms/q |
| flat int4 | 1.000 | 1.69 ms/q |
| flat 1-bit | 1.000 | **2.45 ms/q** |

Their own takeaway: *"Sub-byte quantization is a memory lever, not a speed lever at this scale. The
quantized kernels are ALU-bound (manual nibble/sign unpack costs more than a plain fp32 `vec4` load), so
query time actually rises as bit-width shrinks at 20k rows. The payoff is memory ... tighter codes only
start winning on throughput once the scan is bandwidth-bound rather than ALU-bound."*

That is a material correction to any plan that ships int8 expecting a faster query at 100k×128.

### 1e. Concrete libraries — and what each one actually *is*

| Library | What it is | Notes |
|---|---|---|
| **[poloclub/mememo](https://github.com/poloclub/mememo)** | **Pure-JS HNSW**, IndexedDB + Web Workers. Peer-reviewed (SIGIR 2024 demo, DOI 10.1145/3626772.3657662) | The most credible browser-HNSW reference. Graph in RAM, vectors in IDB, prefetch cache. ~94 min/1M@384D. |
| **[ShravanSunder/hnswlib-wasm](https://github.com/ShravanSunder/hnswlib-wasm)** | **Emscripten WASM build of the C++ hnswlib** (not a reimplementation). IDBFS persistence. | Whole index in the WASM heap; inherits the 2 GB Emscripten growth ceiling. README says "still in its early days". Fork: [0xHecker/hnswlib-wasm-core](https://github.com/0xHecker/hnswlib-wasm-core) (storage-agnostic). |
| **[sharma-open-source/browservec](https://github.com/sharma-open-source/browservec)** | **TypeScript + hand-written WGSL kernels.** flat / IVF / HNSW, fp32/int8/int4/1-bit, OPFS+IndexedDB persistence, WASM-SIMD CPU fallback, GPU score-mask metadata filtering, GPU top-k | **The closest existing thing to what Paul is asking for.** Ship-quality docs, test suite, device matrix. Read this first. |
| **[thealpha93/VecLite](https://github.com/thealpha93/VecLite)** | **Rust → WASM + SIMD128, flat index only.** | Honest self-benchmarks: ~3.9× over optimised JS, not 20×. **Its marketing table claims "~8 ms at 10k" at dim 1536; its own honest-benchmark table in the same article says 40 ms at 10k / dim 1536.** Cite the 40 ms. |
| **[GeoffreyWang1117/VecDB-WASM](https://github.com/GeoffreyWang1117/VecDB-WASM)** | Rust/WASM + SIMD128, HNSW + Flat, IndexedDB persistence. Claims <2 ms @10k×128 | Self-reported; unverified by me. |
| **[tantaraio/voy](https://github.com/tantaraio/voy/) / `voy-search`** | **Rust → WASM k-d tree**, 75 KB gzipped | **Not HNSW.** `[established]` k-d trees degrade toward linear scan in moderate-to-high dimensions — this is textbook and is why k-d trees are absent from modern ANN stacks. Fine as a tiny dependency; do not expect ANN behaviour at 768D. |
| **[StevenStavrakis/vectra](https://www.npmjs.com/package/vectra)** (`vectra`) | **Pure JS/TS, brute-force cosine**, file-backed DB with a swappable `FileStorage`; has an `IndexedDBStorage` for browser/Electron. Pinecone-style metadata filtering + BM25 hybrid | Contrary to the third-party claim that it is "Node.js only" — the docs list `IndexedDBStorage` for "Browser, Electron" and a `vectra/browser` entry point. **Good source to copy for the metadata-filter API surface.** |
| **[unum-cloud/USearch](https://github.com/unum-cloud/USearch)** | C++ single-file HNSW-family engine, SIMD-optimised. Has a WASM build | The JS binding targets Node; **browser usage is officially undocumented** (open issue [#191](https://github.com/unum-cloud/USearch/issues/191)). Usable, unproven in-page. |
| **[discere-os/faiss.wasm](https://github.com/discere-os/faiss.wasm)** | Emscripten build of FAISS | Needs a WASM BLAS/LAPACK, pthreads + `SharedArrayBuffer` (⇒ COOP/COEP headers), SIMD flags. Heavy. The "5–15 MB binary" figure I saw came from a search summary, not a spec — **unverified**. |
| **[electric-sql/pglite](https://github.com/electric-sql/pglite) + [pgvector](https://pglite.dev/extensions/)** | **Full Postgres + pgvector compiled to WASM**, 3 MB gzipped, IndexedDB or OPFS VFS | A categorically different answer: you get SQL metadata filtering, transactions and vector ops in one engine, and the indexing problem becomes pgvector's. Caveat: PGlite's IndexedDB VFS "load[s] all files for the database into memory on start, and flush[es] them to IndexedDB after each query if they have changed." |
| **[Brainwires/idbvec](https://github.com/Brainwires/idbvec), [0xnyn/tinkerbird](https://github.com/0xnyn/tinkerbird), [Tej-Sharma/astro-vectordb](https://github.com/Tej-Sharma/astro-vectordb), [hqjb91/victor-db](https://github.com/hqjb91/victor-db), [deepfates/hnsw](https://github.com/deepfates/hnsw/)** | Hobby-scale HNSW-over-IndexedDB projects | Discovered via search; **not reviewed, no published benchmarks.** Listed for landscape completeness only. |

**Verdict on Q1.** HNSW is not the answer here, and the reason is not that it can't be built — three
projects have built it. The reason is that it costs minutes of build time at 100k, forces the graph to
be resident, is hostile to deletes, and is unmeasured at 128 dims where it is most likely to help. IVF
is the ANN family whose access pattern matches what IndexedDB is actually good at (a keyed cell read),
and the baseline already contains a 54× demonstration that this pattern works on this platform.

---

## 2. Jason Mayes — memory confirmed, with one correction

**Confirmed: he has published in exactly this space.** `[established — first-party source]`

**[jasonmayes/VectorSearch.js](https://github.com/jasonmayes/VectorSearch.js)** — *"A library to perform
semantic vector search, over millions of vectors in milliseconds ... Runs entirely client side in the web
browser (custom Vector DB layer written on top of IndexDB) and currently supports Google's
EmbeddingGemma ... or all-Mini-L6-v2 ... via Web AI libraries with WebGPU acceleration for speed."*
Announced on LinkedIn 2026-03-20; a Codepen demo and a GIF of it running are linked from the README.
121 stars as of the directory listing I saw.

**What it actually is, from source inspection** (`src/CosineSimilarity.js`, verified by fetching the
file):

- `cosineSimilarityTFJSGPUMatrix(matrixData, vectorData, topK)` builds `tf.tensor2d(matrixData)`, caches
  it in `this.cachedMatrix` — *"Rebuilding GPU VectorDB Matrix"* is logged only on cache miss — then
  row-normalises the matrix, normalises the query, does `tf.matMul`, and returns `tf.topk(..., false)`.
- Helper files: `src/VectorStore.js` (the IndexedDB layer), `src/EmbeddingModel.js`, `src/Tokenizer.js`,
  `src/VisualizeTokens.js`, `src/VisualizeEmbedding.js`. No file relating to filtering.
- Runtime: TensorFlow.js with the WebGPU backend for the matmul, LiteRT.js/Transformers.js for the
  embedder.

**Correction for Paul:** *"filters in a similar space"* — he has **score** filtering, not **metadata**
filtering. The search API is `search(embedding, cosineSimilarityThreshold, dbName)`: a cosine-similarity
**threshold**, plus top-k. There is no predicate/metadata filter anywhere in the README or the source
files listed above. So: memory right about the person and the space, wrong about the specific feature.
The metadata-filter design to copy is **vectra's** (Mongo-style `$eq`/`$in`/`$gte`, Pinecone-compatible)
or **browservec's** (same operators, applied in-index on the GPU via a score-mask kernel).

**His own performance claims** (first-party, on a "very old NVIDIA 1070"):

- "100K vectors ... it can search those in tens of miliseconds using the more complex EmbeddingGemma model"
- "**it currently takes roughly the SAME time for 100K vectors searched vs 1K vectors** due to leveraging the GPU"
- "the first search you perform will be slower as it has to transfer memory from CPU to GPU for the first
  time (suggest doing a dummy vector search on page load to warm up)"
- "verified this works on Intel integrated GPUs, NVIDIA, AMD, and Apple M GPUs in any web browser that supports WebGPU"
- "The largest cost is actually the embedding that takes around 200ms"
- "I will later need to refactor to load in chunks to avoid any issues for larger vector stores"

This is a **first-party, unfalsifiable-by-me measurement on one GPU** — treat as `[measured, single
source]`. It is, however, the single most directly relevant datapoint to Paul's Q3, because it is a
real browser doing exactly the operation in question.

**Other Mayes work in the vicinity:** [jasonmayes/web-ai-demos](https://github.com/jasonmayes/web-ai-demos)
(a collection of client-side AI demos, including a product-reviews demo shown at I/O 2024), and
[jasonmayes/WebAIAgent](https://github.com/jasonmayes/WebAIAgent). **I found no paper, talk, or repo by
him on vector *filtering* or ANN indexing.** The in-browser vector search work is VectorSearch.js.

---

## 3. WebGPU for cosine similarity — the decisive number

### 3a. Is it realistic today?

**Yes on Chrome/Edge/Safari 26; no as a universal assumption.**

`[established]` Browser support, from MDN/caniuse/gpuweb implementation-status:

| Browser | WebGPU status |
|---|---|
| Chrome | Since 113 (2023); Chrome 144 (2026-01-13) per webstatus.dev |
| Edge | Chromium-based, same |
| **Safari** | **26 (2025-09-15), "partial support" in caniuse through 26.6** |
| **Firefox** | **141 (2025-07) — Windows only.** macOS ARM in 145/147. **Linux: Nightly only. Android: behind a flag.** |
| iOS third-party browsers (Chrome/Firefox on iOS) | WebKit under the hood; `[measured]` browservec found **no WebGPU exposed** on Chrome iOS 149 |

Note the contradiction: web.dev's blog says WebGPU is *"officially supported across Chrome, Edge,
Firefox, and Safari"*, while caniuse and the gpuweb wiki show Firefox stable shipping on **Windows only**
with Mac/Linux still in Nightly. **Do not plan against the blog.** A WASM-SIMD fallback is mandatory for
a meaningful share of real users, not a nicety.

### 3b. The decisive number: transfer vs 900 ms

**Answer: the transfer is dramatically cheaper. It is not the blocker. And it is a one-time cost, not a
per-query cost.**

`[inference]` Arithmetic, with each input sourced:

| Quantity | Value | Source |
|---|---|---|
| Index size, 100k × 128D × 4 B | **51.2 MB** | arithmetic |
| Measured effective browser CPU↔GPU transfer rate, large buffers | **~1 GB/s** | `[measured]` wgpu issue [#945](https://github.com/gfx-rs/wgpu/issues/945) — "with 1.28GB buffers ... it took 2.2 seconds"; reproduced "on MacBook Pro 13" with an Intel Iris, MacBook Pro 16" with a radeon and a Windows desktop with an Nvidia" |
| Same machine, OpenCL `enqueueWriteBuffer` microbenchmark | **8.56 GB/s** | `[measured]` same issue — the author's own `clpeak` output |
| ⇒ Upload cost at ~1 GB/s | **~51 ms, once** | inference |
| ⇒ Upload cost at ~8.5 GB/s | **~6 ms, once** | inference |
| Query vector upload per query | 512 B → **negligible** | arithmetic |
| Score readback without a GPU top-k | 100k × 4 B = 400 KB → ~0.4 ms | inference |
| Score readback with a GPU top-k (browservec does this past 4k rows) | k floats → negligible | browservec README |
| **Baseline brute-force query to beat** | **~900 ms** | baseline report |

**⇒ The whole index uploads for 6–51 ms — 20× to 150× cheaper than a single 900 ms brute-force query.
It pays for itself after roughly one query, and zero times thereafter.** First-party corroboration:
Jason Mayes measures the same shape and reports his first search is "slower as it has to transfer memory
from CPU to GPU for the first time", after which 100k ≈ 1k.

### 3c. The real constraints

- **Must the whole index be in GPU memory?** Yes, to get the benefit — that is the entire mechanism.
  51.2 MB at 100k×128 is nothing. `[measured]` `maxStorageBufferBindingSize` varies sharply by device:
  browservec reports **4 GiB on Apple Metal** but "a much more conservative default on many other
  adapters", and it implements transparent corpus chunking off the device's *reported* limit. Budget for
  chunking, don't assume 4 GiB.
- **Integrated GPUs.** `[inference]` iGPUs share system RAM, so the "upload" is a pointer swap rather
  than a PCIe DMA: dispatch overhead is ~0.1–2 µs vs 5–35 µs for discrete GPUs. Mayes confirms Intel
  integrated GPUs work. The trade is far less compute throughput and a shared memory bus. Don't assume
  that "it's fine on a 4090" transfers to a Chromebook.
- **Precision.** `shader-f16` gives 2–3× memory-bandwidth savings where available, but browservec's
  measured result is the caution: quantised kernels were **slower** at 20k rows because they are
  ALU-bound, not bandwidth-bound. fp32 ≈ int8 < int4 < 1-bit in *latency*.
- **Fallback when WebGPU is unavailable.** WASM-SIMD flat scan is the right fallback, and browservec's is
  "bit-identical to the GPU path" — that property (same answers, either path) is worth copying.
  `[measured]` browservec's fallback: **0.40 ms/q at 8k rows on an iPhone 15**, 1.76 ms/q at 8k rows on
  desktop. `[measured]` VecLite's honest comparison at dim 1536: WASM+SIMD is **~3.8–3.9× faster than
  optimised JS** at 10k/50k/100k — *not* the 10–20× people expect. `[measured]` Their diagnosis: "V8 is
  genuinely good at optimising tight `Float32Array` loops." So budget a **~4× fallback win**, not 20×.
  Note also the transition cost: "the difference between calling WASM once with 10,000 vectors and
  calling it 10,000 times with one vector is the difference between 40 ms and 4 seconds."

### 3d. Named projects

- **[tensorflow/tfjs — `@tensorflow/tfjs-backend-webgpu`](https://github.com/tensorflow/tfjs/blob/master/tfjs-backend-webgpu/README.md)** — real, maintained; `_fusedMatMul`, `batchMatMul` and `topk` are registered kernels. **This is what Mayes ships.** Lowest-effort path to a working WebGPU cosine scan.
- **[sharma-open-source/browservec](https://github.com/sharma-open-source/browservec)** — hand-written WGSL kernels (`distance.wgsl`, `distanceQ8.wgsl`, `topk.wgsl`, `graphSearch.wgsl`), plus a CAGRA-style GPU beam search: `[measured]` "~4× the CPU walk at 60k×768×128". Widest feature coverage of anything I found.
- **[milhidaka/webgpu-blas](https://github.com/milhidaka/webgpu-blas)** — WebGPU GEMM, published GFLOPS comparisons by hardware/browser.
- **[greggman/webgpu-benchmark](https://github.com/greggman/webgpu-benchmark/)** — measures the **CPU-side cost of issuing API calls and uploads** (`writeBufferSmall`, `writeBufferBig` at 1 MB, `mapAsyncWrite`) rather than GPU throughput. **This is the right tool to measure idb-vector's actual transfer cost** rather than trusting my arithmetic.
- **[gpuweb/gpuweb](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)** — the only authoritative per-OS support matrix.

**Verdict on Q3.** WebGPU is a legitimate 100k-scale answer today for Chrome/Edge/Safari, transfer is
cheap and amortised, and TF.js is a low-risk way to get it. It is *not* a replacement for the fallback
path, and it does not fix anything upstream of the GPU.

---

## 4. "Cosine similarity is not the best" — the anisotropy point

### 4a. Correcting the framing, precisely

`[established]` **The term of art is anisotropy, not "ellipsoid".** "Elliptical" is the right *intuition*
— variance concentrated along a few axes makes the cloud an elongated ellipsoid rather than a uniform
hypersphere — but the literature uses:

- **anisotropy** / **narrow cone** — the cloud occupies a narrow cone in ℝᵈ (Ethayarajh 2019);
- **rogue / outlier dimensions** (Timkey & van Schijndel 2021; Kovaleva et al. 2021), or **massive
  activations** at LLM scale (Sun et al. 2024);
- **rogue-dimension dominance** — the share of total variance held by the single highest-variance
  coordinate, which is the one-number diagnostic the 2026 paper proposes.

Also worth separating: **hubness** is a *different* phenomenon that gets conflated with anisotropy.
`[established]` Radovanović, Nanopoulos & Ivanović, [*Hubs in Space*, JMLR 11:2487–2531, 2010](https://jmlr.org/papers/v11/radovanovic10a.html) —
"under commonly used assumptions this distribution [of k-occurrences] becomes considerably skewed as
dimensionality increases, causing the emergence of hubs, that is, points which occur surprisingly often
among k nearest neighbors of other points." Hubness is about **which points appear in top-k**, not about
the metric's bias, and it affects cosine and Euclidean alike.

### 4b. The established line (2017–2022) — all about *static/contextual word* vectors

- `[established]` **Mu & Viswanath, "All-but-the-Top", ICLR 2018** ([arXiv 1702.01417](https://arxiv.org/pdf/1702.01417.pdf)). Direct quotes from the paper: *"The word representations have non-zero mean – indeed, word vectors share a large common vector (with norm up to a half of the average norm of word vector). After removing the common mean vector, the representations are far from isotropic – indeed, much of the energy of most word vectors is contained in a very low dimensional subspace (say, 8 dimensions out of 300)."* The fix: subtract the mean, project out the top principal directions. **Scope: static word embeddings, not modern retrieval embedders.**
- `[established]` **Ethayarajh, EMNLP 2019** ([arXiv 1909.00512](https://arxiv.org/pdf/1909.00512)) — the origin of the intuition: *"In all layers of all three models, the contextualized word representations of all words are not isotropic: they are not uniformly distributed with respect to direction. Instead, they are anisotropic, occupying a narrow cone in the vector space. The anisotropy in GPT-2's last layer is so extreme that two random words will on average have almost perfect cosine similarity!"*
- `[established]` **Gao et al. (SimCSE) 2021**, **Su et al. 2021 ("Whitening Sentence Representations")**, **Huang et al. 2021 (WhiteningBERT)**, **Li et al. 2020 (BERT-flow)** — anisotropic spaces hurt similarity; contrastive training and/or whitening fix it. `[contested]` **Cai et al. 2021** complicates the narrow-cone picture: the space breaks into clusters and manifolds that are *locally* more isotropic than they look globally.
- `[contested]` Whether anisotropy is actually *the cause* of BERT's weak sentence similarity has been directly challenged (see the ACL/EMNLP line including "Is anisotropy really the cause of BERT embeddings not being semantic?"). Report as unresolved.

### 4c. The 2024–2026 challenge, and what it actually claims

**Paper A — the sceptical analytic claim.**
`[established as published / contested as generalisable]` **Steck, Ekanadham & Kallus (Netflix/Cornell),
"Is Cosine-Similarity of Embeddings Really About Similarity?", WWW 2024 Companion** —
[arXiv 2403.05440](https://arxiv.org/abs/2403.05440), DOI 10.1145/3589335.3651526. Abstract, verbatim:
*"we study embeddings derived from regularized linear models ... We derive analytically how
cosine-similarity can yield arbitrary and therefore meaningless 'similarities.' For some linear models
the similarities are not even unique, while for others they are implicitly controlled by the
regularization ... a combination of different regularizations are employed when learning deep models;
these have implicit and unintended effects when taking cosine-similarities of the resulting embeddings,
rendering results opaque and possibly arbitrary. Based on these insights, we caution against blindly
using cosine-similarity and outline alternatives."*

**What it is:** a 9-page analytical result about *what the score means*. **What it is not:** a
measurement of retrieval degradation. It reports no recall@k and no benchmark showing top-k changes.
Cite it as "cosine scores can be uninterpretable in regularised models", not as "cosine retrieves worse".

**Paper B — the empirical paper that matches Paul's memory, and the one that should drive the decision.**
`[one paper — but the most comprehensive study available]` **Parupudi, "Anisotropy Decides Cosine vs.
Rank Metrics for Text Embeddings",** [arXiv 2606.29571](https://arxiv.org/html/2606.29571v1) (v1, 28 Jun 2026).
Design: **19 encoders** (MiniLM-L6/L12, mpnet, BGE-base/large, E5-large, multilingual-E5-large,
E5-Mistral-7B, SFR-Embedding-Mistral, BERT, RoBERTa, ELECTRA, mBERT, GPT-2, Pythia-410M, Qwen2.5-1.5B/7B,
Mistral-7B) × **19 parameter-free metrics** × **7 datasets** (STS-B, SICK-R, STS16, Quora, PAWS, SNLI,
MultiNLI).

Its measured claims:

| Finding | Number |
|---|---|
| Well-spread encoders (10 of 19): best alternative vs cosine | **+0.001 Spearman, p = 0.54, not significant** |
| Crowded encoders (9 of 19, rogue-dim dominance > 0.01): best alternative | **+0.053 Spearman, p = 3×10⁻¹²** |
| Per-metric gains on crowded encoders | rank-based 0.053, Canberra 0.051, Bray-Curtis 0.039, fractional *Lp* 0.034, Manhattan 0.028 |
| Predictor: rogue-dimension dominance → gain | rank corr **0.86**, linear corr **0.95** |
| Project out top-10 PCs, crowded encoders | cosine Spearman **0.324 → 0.417**; metric advantage cut **87%** |
| Same, well-spread encoders | cosine **drops** 0.014 — those directions carry real signal |
| Random-direction control (10 random orthogonal dirs) | advantage cut only **10%** vs 87% — rules out the obvious confound |
| **Effect of normalising every vector to length 1** | gain **0.026 → 0.026** — *"the gain barely changes when we first scale every vector to length one"* |
| Raw dot product (the one length-using metric) | **worst of the whole set** — trails cosine by 0.082 unnormalised, and equals cosine once normalised |
| Calibration (MSE) after one isotonic rescaling | spread across metrics shrinks **0.052 → 0.0025** (20×) |
| GPT-2 (worst case) | 41% of variance in a single coordinate; mean cosine between two random sentences **0.996** |

**The practical conclusion, in the authors' own words:** *"Most fine-tuned embedders we tested, the kind
people actually use for similarity, are trained to spread their vectors out, and on those, among
parameter-free metrics, cosine is the right call. Switching metrics there buys 0.001 on average, against
a cosine Spearman of 0.602. The alternatives help on crowded encoders, where cosine sits at 0.324, and
those are mostly plain language models used without fine-tuning."* And: *"The contribution is a
diagnosis, not a push to change production systems that already use well-spread embedders."*

**This is the correction Paul needs.** The intuition "real embedding spaces are elliptical so cosine is
wrong" is *conditionally* true: it requires the encoder to be **crowded**, and the modern contrastively
fine-tuned embedders that dominate retrieval are — by this measurement — **not**. The
counterexample the paper offers is instructive: **E5-Mistral** is trained with a cosine objective yet is
crowded, and the alternatives help it; **multilingual BERT** is a plain LM yet well spread, and they
don't. So the geometry, not the training objective, decides — and geometry is measurable.

**Paper C — the direct contradiction on Euclidean.**
`[contested]` **Tessari, Yao & Hogan, "Surpassing Cosine Similarity for Multidimensional Comparisons:
Dimension Insensitive Euclidean Metric (DIEM)"** — [arXiv 2407.08623](https://arxiv.org/html/2407.08623).
TL;DR as posted: *"Cosine similarity yields biased, dimension-dependent results in high-dimensional
spaces."* **It was an ICLR 2026 submission and was withdrawn** (OpenReview forum `4i66VARUHD`, status:
"ICLR 2026 Conference Withdrawn Submission"). And Paper B **tested Euclidean and found the opposite**:
it "trails cosine by 0.0002 on the well-spread encoders and by 0.006 on the crowded ones" — *"Euclidean
distance does not beat cosine here."* Two papers, opposite conclusions, one of them withdrawn from its
venue. Do not act on the DIEM claim.

### 4d. Does it change top-k ranking, or only the score values? *(The distinction Paul asked for)*

`[inference, from the measured evidence]` **Both, but neither in a way that justifies changing
idb-vector's default.** Separating the three mechanisms the papers actually describe:

1. **Metric substitution** (cosine → rank/L1). This **does change the ordering** — a different ordering
   of coordinates or a different norm produces a genuinely different ranking, and Paper B's ROC-AUC
   result (crowded encoders +0.028, GPT-2 +0.077) confirms it changes *decisions*, not just scores.
   **But:** (a) it only fires on crowded encoders; (b) all the evidence is on **pairwise grading
   correlation and binary duplicate detection** — Spearman over all pairs is not recall@k, and a metric
   that reorders the middle of the ranking may leave the top-10 untouched. **Paper B reports no
   recall@k and no nDCG@k anywhere.** That is a real gap.
2. **Calibration** (score values only). This is explicitly *not* a reason to switch: one isotonic
   rescaling collapses the MSE spread across all 19 metrics by 20×. **Score-value differences are
   cosmetic.**
3. **Geometry repair** (mean-centring, whitening, all-but-the-top). This changes the **index**, not the
   metric, and it changes the space itself — so it definitely changes neighbours. **Critically, it is
   not a free win:** Paper B measured that projecting out the top-10 directions *hurts* well-spread
   encoders (cosine down 0.014) because those directions carry signal. Applying mean-centring
   unconditionally would damage exactly the embedders Paul is most likely to use.

**And the key negative result for implementation:** because Paper B's effect *"survives normalizing every
vector to length one"* (0.026 → 0.026), **normalising does not fix anisotropy.** The fix, where one is
warranted, is projecting out the dominant directions — which is a per-corpus transformation, not a
per-query normalisation.

### 4e. MIPS vs cosine vs Euclidean under normalisation, and where it breaks

`[established]` — three facts, in order of usefulness to a library author:

1. **On L2-normalised vectors, cosine, dot product and Euclidean produce the identical ranking.**
   `cos(a,b) = a·b` when `‖a‖ = ‖b‖ = 1`, and `‖a−b‖² = 2 − 2(a·b)` is a monotone decreasing function of
   the dot product — so all three sort identically. `[established]` This is spelled out in the
   [FAISS metric wiki](https://github.com/facebookresearch/faiss/wiki/MetricType-and-distances):
   *"The norm of the query vectors does not affect the ranking of results ... This is not by itself
   cosine similarity, unless the vectors are normalized (lie on the surface of a unit hypersphere)."*
   **⇒ idb-vector's normalisation contract determines whether its cosine default is a real choice or a
   naming convention.** It should say so explicitly.
2. **The equivalence breaks on unnormalised vectors.** MIPS ≠ cosine. `[established]` Inner product does
   not satisfy the condition LSH requires — "for any point q, the point that has the largest similarity
   to q is q itself" — which is why MIPS needed its own literature (FARGO, [VLDB vol 16](https://vldb.org/pvldb/vol16/p1100-zheng.pdf)). `[one paper, recent]` [*"Maximum Inner Product is Query-Scaled Nearest Neighbor"*, VLDB vol 18](https://www.vldb.org/pvldb/vol18/p1770-ke.pdf) shows MIPS reduces to nearest-neighbour under a query-dependent scaling. The practical failure mode: `[established]` a cosine-trained model queried with raw dot product on unnormalised vectors degrades recall **invisibly** — the API returns plausible scores with the wrong neighbours.
3. **The equivalence covers order only, and does not survive transformation.** It says nothing about
   score interpretability, and it is void if you apply Matryoshka-style truncation or product/binary
   quantisation to the raw vectors rather than the normalised ones.

**Verdict on Q4.** Paul's memory points at a real research line — anisotropy, going back to 2017–2019 —
and it is well-cited. But the term is *anisotropy*, not ellipsoid; the phenomenon was first measured on
static and contextual **word** vectors, not retrieval embedders; the strongest recent challenge
(Steck et al.) is analytic rather than a retrieval benchmark; the direct Euclidean counter-claim is
contested and was withdrawn from ICLR; and the most comprehensive recent study concludes **cosine is
already the right call for the fine-tuned embedders this library would serve**. The actionable residue is
one cheap diagnostic, not a metric change.

---

## Contradictions

1. **Euclidean vs cosine.** Tessari et al. ([2407.08623](https://arxiv.org/html/2407.08623), ICLR 2026
   **withdrawn**) claim cosine is biased and DIEM is better. Parupudi
   ([2606.29571](https://arxiv.org/html/2606.29571v1)) measured Euclidean **losing** to cosine on all 19
   encoders. **Unresolved; do not act on either.**
2. **Cosine is "arbitrary and meaningless"** (Steck et al., WWW 2024, analytic) **vs cosine is "already
   the right call"** for deployed embedders (Parupudi, 2026, empirical over 19 encoders). Different
   settings and different claims; the analytic result is about *interpretability of the score*, the
   empirical one about *ranking quality*.
3. **HNSW vs flat in the browser.** VecLite measured flat beating HNSW at every scale tested (dim 1536);
   MeMemo reports real-time queries from HNSW at 1M (dim 384). Different dimensions, different
   implementations, not comparable — and **dim 128, idb-vector's regime, is unmeasured in both.**
4. **WebGPU browser support.** web.dev's blog: *"officially supported across Chrome, Edge, Firefox, and
   Safari."* caniuse/gpuweb: Firefox stable is **Windows only**; Mac/Linux are Nightly; Safari 26 is
   "partial". **The blog is optimistic; plan against the implementation matrix.**
5. **VecLite's own numbers disagree with each other.** Its summary table says "~8 ms at 10k" (dim 1536);
   its honest-benchmark table in the same article says **40 ms** at 10k / dim 1536. **Use 40 ms.**
6. **VecLite claims vectra is "Node.js only"** — vectra's docs list an `IndexedDBStorage` for
   "Browser, Electron" and a `vectra/browser` entry point. The third-party claim is wrong.
7. **browservec reports recall@10 = 1.000 for every configuration**, including 1-bit quantisation. Its
   own text calls the matrix "small [and] growing". Treat as not-yet-discriminating, not as evidence.

---

## Missing evidence

- **The decisive unknown for Q1: no published measurement of IndexedDB per-record *random* read latency
  vs sequential scan throughput.** Every source I found describes random/small reads as slow only
  qualitatively ("reading or writing a large amount of data to IndexedDB with consecutive transactions
  is extremely slow" — MeMemo). **This single number decides whether HNSW-over-IDB is viable**, and it
  is unmeasured in the public record.
- **No decomposition of the baseline's 942 / 796 ms into IndexedDB-read vs deserialise vs score time.**
  My estimate below is inference. Without this, the case for GPU/WASM is unquantified.
- **No browser ANN benchmark at 128 dimensions at 100k or 1M.** MeMemo is 384D, VecLite 1536D, browservec
  384D, VecDB-WASM 128D but self-reported. **Every source's conclusion about HNSW-vs-flat sits in a
  different dimensional regime from idb-vector's.**
- **No recall@k / nDCG@k evaluation for the rank-based and L1-type metrics** — Paper B reports Spearman
  and ROC-AUC only. Whether the ordering change reaches the top-10 is unestablished.
- **MeMemo's query-latency numbers** are in a figure I could not extract as text; I have only the
  primary-source prose *"querying this index with 1M items is still performed in real time"*.
- **`faiss.wasm` binary size ("5–15 MB") is unverified** — it came from a search-engine summary, not a
  spec or a build. Do not repeat it as fact.
- **USearch in-browser is officially undocumented** (open issue #191). Usable, unproven.
- **Annular / "ring" index as an ANN family: I could not find it.** Searches surfaced (a) *The Ring*
  (worst-case-optimal graph joins, SIGMOD 2024) — a database-join structure, unrelated to vector search;
  and (b) LSH banding, which is ring-shaped but is LSH. **I am flagging this as a probable
  misremembering or a term from a source I could not locate; it should not be treated as an ANN family
  without a citation.** The nearest real named alternative in that slot is **Annoy** (Spotify's random
  projection *forest*, mmap'd, tree-based) and **LSH**.
- **`source_check` validation limitation:** I ran `source_check` on the MeMemo claim; the tool returned
  `Status: unclear (confidence 0.30)` with *"automated semantic support or contradiction assessment is
  unavailable"*. I therefore verified that claim by directly fetching and quoting the arXiv HTML
  (§3.2 and the Challenges discussion) instead. All other claims above are backed by directly fetched
  primary sources; **no claim in this report rests on a search-result summary alone.**
- **This session had no shell tool**, so I could not file the bead myself. Exact command provided below.

---

## The three things I would actually change in idb-vector

### Change 1 — Make the query engine in-memory; demote IndexedDB to a persistence layer

**`[inference — medium-high confidence, and cheap to falsify]`**

**Reasoning.** The baseline's two exact-scan numbers differ by only 18% (941.6 ms cursor vs 796.3 ms
paged `getAll`), which means the cursor-vs-`getAll` choice is not where the time is. Decompose the
796 ms:

- 100k × 128 = 12.8M multiply-accumulates.
- `[measured]` VecLite's pure-JS baseline: 100k × 1536D = 153.6M MACs in **1576 ms** ⇒ ~97M MACs/s.
  Scaling: 12.8M MACs ≈ **~130 ms** of pure arithmetic.
- ⇒ **~666 ms of the 796 ms is IndexedDB read + structured-clone deserialisation of 100k nested
  `Array` objects — ~6.7 µs per record.**
- Cross-check against the baseline's *own* category-index numbers: 13.5 ms for 1,000 records ≈ 13.5 µs
  per record including deserialise, and 735 ms for 100,000 — consistently **~7 µs/record**.

**The cost is per-record overhead, not bytes.** 51.2 MB in ~666 ms is ~77 MB/s — an order of magnitude
below what a bulk memory transfer should cost. Reading 100,000 records is the problem; reading **one**
51.2 MB buffer is not. This is the same conclusion the IndexedDB community reached independently:
*"Reading a single item from IDB at once is slow. Instead, we can read entire ranges or all items for a
given store. Even range reads can be slow. **We can speed this further by storing pages, rather than
individual objects, in IDB.**"* — and it is why browservec persists **versioned binary snapshots** and
MeMemo needed a dimension-tuned prefetch cache.

**What to do:** on `open()`, read the vectors into a single contiguous `Float32Array` (one packed
`ArrayBuffer` value, or a small number of fixed-size chunk records); answer every query from RAM; serve
writes through to IndexedDB asynchronously. The index becomes a pure in-memory problem, at which point
WASM-SIMD (`[measured]` ~4× over JS) and WebGPU (Change 3) become live options rather than rearranging
deck chairs. No ANN index, no recall loss, no build time.

**Expected:** 796 ms → **tens of milliseconds** at 100k×128 (≈130 ms compute at JS speed, ≈33 ms at
WASM-SIMD speed, ≈1–2 ms on GPU), plus one one-off load at open. **Cost:** 51.2 MB RAM at 100k×128,
512 MB at 1M×128 — so this needs a memory ceiling with chunked paging or eviction above a threshold,
and a documented serialisation format version.

**Why it must come first:** it is the largest single win, it is independent of the ANN and WebGPU
questions, and it changes whether those questions are even worth asking. **The one measurement that
falsifies it:** how fast a single packed ~51 MB `ArrayBuffer` value actually reads back out of
IndexedDB. If that comes in near 666 ms too, my decomposition is wrong and the bottleneck is elsewhere.

### Change 2 — Fix eligibility-before-top-k first, and make the recall contract explicit

**Reasoning.** The 0/10 post-filter result is a **wrong-answer bug**, not a performance issue, and it is
the only finding in the baseline where the library returns a confidently incorrect result. It also has
to be settled before any ANN work, because every ANN design must respect the eligible set — an ANN
candidate list intersected with a predicate reproduces the same 0/10 failure in a more expensive way.

**What to do:** apply key-range/index selection and predicate evaluation **before** ranking; return fewer
than `k` only when the eligible set genuinely holds fewer; for any approximate path, evaluate the
predicate before pruning, rerank survivors exactly, and keep an exact eligible-scan fallback for a
strict correctness mode. Pair it with the transaction-durability fix — an earlier baseline run showed
`insert` resolving a key before the transaction aborted, which means the library can report success for
a write that did not land.

**Status:** this is confirming baseline beads `idb-vector-kuc.3` and `idb-vector-kuc.4`, not new work.
The research adds no reason to change their content, only to sequence them **ahead** of the index work.

### Change 3 — Do not adopt HNSW. Adopt IVF-over-IndexedDB if ANN is needed at all, behind a swappable interface

**Reasoning, in three parts.**

1. **HNSW's costs are real and its benefit is unmeasured in this regime.** It forces the graph resident
   (three independent implementations), it costs ~94 min/1M to build in MeMemo's own measurement, it is
   hostile to deletes and updates, and the only in-browser head-to-head I found at high dimension had
   **flat beating HNSW at every scale tested**. The author's own caveat — "HNSW would probably win
   (untested) at dim=128 with 500k+ vectors" — describes idb-vector's dimension regime, but at
   500k+ vectors, which is not where the baseline's 100k problem is.
2. **IVF is shaped like IndexedDB.** Centroids in a tiny separate store; a `bucket` field per record; an
   `IDBIndex` on `bucket`; read `nprobe` cells via a key range; rerank exactly. That is *precisely* the
   read pattern the baseline's category-index experiment already measured at **735 ms → 13.5 ms**, with
   learned clusters substituted for a label column. `[measured]` browservec ships this and reports
   0.51 ms/q for IVF fp32 vs 1.71 ms/q for flat at 20k×384 with `targetRecall: 0.95` auto-tuning.
   IVF also **composes with Change 1 and with metadata filtering** (bucket ∩ category), which HNSW's
   full-graph traversal does not do cleanly.
3. **The algorithm should be a seam, not a commitment.** Define a
   `candidateIds(query, filter, k) → id[]` provider with a measured `recall@k` against exact
   `min(k, eligibleCount)`, and ship flat + IVF behind it. Then the HNSW question can be answered by
   measurement on a real corpus at 128 dims rather than by argument — which is exactly what the
   baseline report already recommends ("Defer HNSW/PQ selection until a real embedding corpus,
   dimension sweep, candidate budgets and mobile measurements demonstrate a need").

**Also within Change 3 — correct the quantisation expectation.** Do **not** ship int8/int4/binary as a
*query-speed* optimisation at these scales. `[measured]` browservec found the quantised kernels
**slower** at 20k rows (fp32 1.71 ms → 1-bit 2.45 ms) because they are ALU-bound on the unpack, not
bandwidth-bound. Ship it for **memory** (int8 ~4×, int4 ~8×, 1-bit ~32×) and for the 1M+ case where the
scan becomes bandwidth-bound, always with an fp32 rerank — and label it as such in the API.

### Smaller item (0) — the metric policy

**Keep cosine. Document the contract. Add one diagnostic number. Do not add mean-centring.**

- State explicitly that vectors are L2-normalised on write, and therefore that **cosine, dot product and
  Euclidean return identical orderings** on this store. That makes the `metric` option honest rather
  than decorative.
- Expose a cheap **one-number geometry diagnostic** — rogue-dimension dominance, the share of variance
  in the single highest-variance coordinate — computed once per corpus and surfaced as a warning when it
  exceeds ~0.01. That is Paper B's own proposed intervention, it costs one pass over the data, and it
  tells a caller with an un-fine-tuned embedder that cosine is unsafe for them specifically.
- **Do not switch the default metric and do not apply mean-centring or whitening by default.** Paper B
  measured that removing the top principal directions *hurts* well-spread encoders (cosine −0.014)
  because those directions carry signal, and that most fine-tuned retrieval embedders are well spread.
  Offer it as an opt-in, labelled "helps anisotropic encoders only".
- The baseline's synthetic corpus (LCG-uniform in [-1,1)¹²⁸) is **isotropic by construction**, so no
  anisotropy conclusion can be drawn from it either way. That is a note for the harness, not a defect.

---

## Sources

**Kept**

- [MeMemo: On-device Retrieval Augmentation for Private and Personalized Text Generation](https://arxiv.org/html/2407.01972) — SIGIR 2024, DOI 10.1145/3626772.3657662. **Primary evidence for the HNSW-over-IndexedDB answer**: graph in RAM, vectors in IDB, prefetch cache, ~94 min/1M@384D. [poloclub/mememo](https://github.com/poloclub/mememo).
- [Is Cosine-Similarity of Embeddings Really About Similarity?](https://arxiv.org/abs/2403.05440) — Steck, Ekanadham, Kallus, WWW 2024. The named sceptical result, with its scope limits.
- [Anisotropy Decides Cosine vs. Rank Metrics for Text Embeddings](https://arxiv.org/html/2606.29571v1) — Parupudi, Jun 2026. The decisive paper for Q4; 19 encoders × 19 metrics × 7 datasets, with the geometry diagnostic and the negative result on normalisation. Fetched in full.
- [jasonmayes/VectorSearch.js](https://github.com/jasonmayes/VectorSearch.js) + [`src/CosineSimilarity.js`](https://raw.githubusercontent.com/jasonmayes/VectorSearch.js/main/src/CosineSimilarity.js) — **direct answer to Q2**, source-verified, including the absence of metadata filtering.
- [sharma-open-source/browservec](https://github.com/sharma-open-source/browservec) — measured device matrix, GPU/WASM fallback design, IVF/HNSW/quantisation tradeoffs, quantisation-is-not-a-speed-lever finding.
- [wgpu issue #945 — Performance of GPUBufferUsage.STORAGE buffers](https://github.com/gfx-rs/wgpu/issues/945) — the **only measured CPU↔GPU transfer rate** I found for browser-class hardware (~1 GB/s effective, with an 8.56 GB/s OpenCL comparison on the same machine).
- [All-but-the-Top](https://arxiv.org/pdf/1702.01417.pdf) and [Ethayarajh ECNLP 2019](https://arxiv.org/pdf/1909.00512) — the origin and scope of the anisotropy literature.
- [Radovanović et al., Hubs in Space, JMLR 2010](https://jmlr.org/papers/v11/radovanovic10a.html) — hubness, kept separate from anisotropy.
- [FAISS MetricType and distances](https://github.com/facebookresearch/faiss/wiki/MetricType-and-distances) — the normalisation equivalence, stated normatively.
- [DiskANN (NeurIPS 2019)](https://suhasjs.github.io/files/diskann_neurips19.pdf) — evidence that DiskANN's contribution is an SSD access pattern browsers cannot use.
- [gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) + [caniuse WebGPU](https://caniuse.com/webgpu) — the real support matrix, contradicting the web.dev blog.
- [hnswlib-wasm](https://github.com/ShravanSunder/hnswlib-wasm), [Emscripten memory settings](https://emscripten.org/docs/tools_reference/settings_reference.html) — IDBFS design and the 2 GB ceiling.
- [thealpha93/VecLite write-up](https://dev.to/thealpha93/i-built-a-vector-search-library-in-rustwasm-heres-what-i-learned-about-performance-browser-172c) — the flat-beats-HNSW-at-dim-1536 measurement and the honest ~3.9× WASM-vs-JS number.
- [Vectra docs](https://stevenic.github.io/vectra/storage.html) / [npm](https://www.npmjs.com/package/vectra) — browser `IndexedDBStorage` and the metadata-filter API worth copying.
- [PGlite](https://pglite.dev/extensions/) + [filesystems](https://pglite.dev/docs/filesystems) — the SQL-in-WASM alternative, with its own memory caveat.
- [tensorflow/tfjs-backend-webgpu](https://github.com/tensorflow/tfjs/blob/master/tfjs-backend-webgpu/README.md) — the low-risk WebGPU path, with `matMul`/`topk` kernels.
- [greggman/webgpu-benchmark](https://github.com/greggman/webgpu-benchmark/) — the tool to measure idb-vector's actual upload cost.
- IndexedDB read guidance: [Nolan Lawson](https://nolanlawson.com/2021/08/22/speeding-up-indexeddb-reads-and-writes/), [Patrick Brosset / getAllRecords](https://patrickbrosset.com/articles/2024-11-19-even-faster-indexeddb-reads-with-getallrecords/), and the page-storage recommendation quoted in Change 1.

**Rejected / deprioritised**

- web.dev's ["WebGPU is now supported in major browsers"](https://web.dev/blog/webgpu-supported-major-browsers) — headline overstates Firefox coverage (Windows only).
- ["Surpassing Cosine Similarity... DIEM"](https://arxiv.org/html/2407.08623) — **withdrawn** from ICLR 2026, and contradicted by Parupudi's measurement. Cited as an example of a contested claim only.
- Medium / dev.to "why cosine fails" explainers (Mizan, "cosine similarity lies", rutvikacharya) — SEO-heavy restatements of the anisotropy literature with no measurements; superseded by 2606.29571.
- Second-hand HNSW/IVF comparison blogs (HLD Handbook, dreaming.press, llmdb.app, callsphere) — plausible but unsourced; used only for background framing, never for a number.
- `arxiv 2606.29571`'s own citation of a "MathML/topic" LLM summary of hubness — replaced with the primary JMLR paper.
- VecLite's "~8 ms at 10k" headline number — contradicted by its own benchmark table.
- Hobby HNSW-over-IDB repos (idbvec, tinkerbird, astro-vectordb, victor-db, deepfates/hnsw) — no benchmarks, not reviewed; landscape only.
- `faiss.wasm`'s claimed binary size — unverified search-summary figure.
- *The Ring* (SIGMOD 2024) — graph-database join index, unrelated to vector ANN; listed to explain the "annular/ring" search miss.

---

## Next steps

In priority order. **The first is the one that changes the recommendation:**

1. **Measure the packed-read hypothesis (Change 1).** Write a 51.2 MB `Float32Array` into a single
   IndexedDB record; time `getAll`/`get` of that one record. Compare against the measured ~666 ms to
   read 100k individual records. Also measure, in the same run, **random single-record read latency vs
   sequential scan throughput** — the missing number that decides whether HNSW-over-IndexedDB is viable
   at all, and the number no public source has. This is one browser session and it settles Q1.
2. **Decompose the existing 942 ms into read / deserialise / score**, by instrumenting the existing
   cursor and paged-`getAll` paths. If read+deserialise is not the dominant term, my Change 1 reasoning
   is wrong and the plan reverts to Change 3.
3. **Re-run the baseline benchmark at 128 dims with a WASM-SIMD scorer** on the in-memory array, to pin
   the realistic fallback win at ~4× (VecLite's measurement) rather than the 10–20× folk estimate.
4. **Only then** evaluate IVF at 100k×128 with a bucket `IDBIndex`, measuring `recall@k` against exact
   `min(k, eligibleCount)` at a few `nprobe` values. Do not implement HNSW first.
5. If a real corpus is available (a fine-tuned embedder's output, not the LCG fixture), **compute
   rogue-dimension dominance once** and record it. If it is below ~0.01, the entire Q4 thread is closed
   for this library's users and the metric policy in item (0) is a documentation change only.

---
