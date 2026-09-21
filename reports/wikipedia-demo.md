# Wikipedia demo acceptance

## Local candidate, 2026-09-21

Independent review and GitHub Pages publication are pending at this checkpoint.
`wikipedia-demo-local.json` records the raw run; screenshots are in
`screenshots/wikipedia/`. No claim of a deployed acceptance run yet.

Conditions: Linux headless Chromium 152, fresh browser profile, loopback server
using `/idb-vector/demo/index.html`, shared Ryzen host, warm filesystem, quantized
all-MiniLM-L6-v2, 384 dimensions, single-thread WASM, exact cosine IndexedDB scan,
5 results. These are single observations, not percentiles or cold-internet timings.

| Corpus | Load total | Database commit | Question encoding | IndexedDB search |
|---|---:|---:|---:|---:|
| 250 passages, initial load | 364 ms | 15 ms | 19.3 ms | 10.0 ms |
| 250 passages, network disabled, same question | — | — | 6.2 ms | 17.4 ms |
| 2,000 passages, same page/model already loaded | 142 ms | 107 ms | 6.0 ms | 56.1 ms |

The typed question “How do plants turn sunlight into food?” returned
**Photosynthesis** first. Network was disabled through CDP; an uncached fetch
really failed. The same question returned identical ranks and scores; a **new**
offline question about the ground shaking returned **Earthquake**. This is local
query encoding, not precomputed answers or keyword lookup.

Acceptance also verified no runtime/model/corpus download before the Load click,
failed offline corpus replacement preserves the smaller committed corpus, switching
to 2,000 records, reload and explicit model restoration, clearing IndexedDB/model
cache, no third-party resources, and no horizontal overflow at 390/844 CSS pixels.
Reload is deliberately **not** promised offline; there is no service worker.

## Checks

- `npm test`: existing browser baseline PASS.
- `node tests/wikipedia-demo.mjs`: PASS including the offline/restore/clear drives.
- `node --check demo/app.js` and preparation tool: PASS; `git diff --check`: PASS.
- New source collector run: **10,040/10,040** passages have numeric revision/page
  IDs, across 167 articles. No `--embed`, no paid API calls. Retaining page info
  across MediaWiki continuation fixed missing revision IDs in the older snapshot.
- Negative check in a separate copied tree (`/tmp/idb-wiki-mutant-L1pdBI`): changed
  `vectorDB.query(vector, …)` to `vectorDB.query(vector.map(x => -x), …)`.
  The same runnable browser test exited **1**, failing the photosynthesis retrieval
  assertion (normal tree exits **0**). It detects a broken scoring input.

## Data and boundaries

Wikipedia text/vector bytes: **539,594** for 250 passages; **4,259,714** for 2,000.
Runtime/model are about 34 MB additional, intentionally downloaded only on click.
Checksums and exact per-file sizes: `demo/assets.json`. Both corpus and user
questions use the exact same quantized model. CC BY-SA source revision/history
links are visible per result; the model and runtime license files are included.

This does not change the library runtime or evaluate the packed-read/ANN hypothesis
in `idb-vector-wfp`. It is a working small-corpus demo, not proof of million-vector
capacity or semantic recall. The earlier 1.18M benchmark timeout remains an
unresolved failure, not a demonstrated browser limit.

## Storage follow-up (`a883317`)

`wikipedia-demo-storage-check.txt` records the full passing drive with an injected
synchronous `DataCloneError` at vector write 51, after clear and partial writes
were queued. The test restores the real method, types/submits the original query
again and compares its separately returned titles/scores with the pre-failure
baseline. The existing corpus remains queryable, not merely present in metadata.
The negative control removes `tx.abort()` in a separate copied tree and the same
check fails on the changed result set: `wikipedia-demo-storage-mutant.txt`, exit 1.
The earlier sign-negation control is retained in `wikipedia-demo-ranking-mutant.txt`.

The inherited `2743029` real-vector harness also passed a bounded **10,000-row,
25-dimensional GloVe** run, library + IVF (40 held-out queries per setting).
Exact search and full-probe IVF both had recall 1; narrow probes trade recall for
latency. `wikipedia-demo-real-vector-check.{txt,json}` preserves this separate run.
It is not a Wikipedia-demo benchmark, million-row acceptance or a capacity limit.
