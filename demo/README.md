# Offline Wikipedia search demo

Public URL after deployment: https://paulkinlan.github.io/idb-vector/demo/

Press **Load on this device**. This explicitly downloads the runtime, model and
selected corpus, then writes passages and vectors to IndexedDB in one transaction.
No model, runtime or corpus download starts on page open. Choose 250 or 2,000 real
Wikipedia passages; this is a curated sample, not a search over all Wikipedia.

Type any English question. The **same quantized all-MiniLM-L6-v2 encoder** used to
prepare passage vectors encodes it in this browser. `VectorDB.query()` from the
unchanged library performs an exact cosine scan of the IndexedDB records. The page
shows load time, database commit time, query encoding time and search time; corpus
size, dimension, model and browser appear beside the measurements. Similarity is
not answer confidence. No ANN or relevance improvement is claimed.

## Offline boundary

After loading, **the open page** can encode previously unseen questions and search
with networking disabled. Passages/vectors are persistent IndexedDB data; model
files use Transformers.js's Cache Storage, while the live encoder/runtime is in
memory. **Reload/reopen requires networking** for the app and runtime. No service
worker is installed. Browser eviction or clearing site data removes local storage.
Wikipedia links require networking. The online indicator is `navigator.onLine`,
which is only a hint; the acceptance test separately proves an actual fetch fails.
All resources are self-hosted at the Pages repository subpath. No API key, backend,
remote inference, CDN script or external font is needed. Model restoration after
reload is another explicit Load action; it reuses committed vectors rather than
silently overwriting the database.

## Assets and attribution

- `vendor/transformers.min.js`: @xenova/transformers **2.17.2**, Apache-2.0.
- `vendor/ort-wasm-simd.wasm`: bundled ONNX Runtime Web **1.14.0**, MIT;
  single-thread WebAssembly SIMD. Browsers without SIMD are not supported.
- `models/all-MiniLM-L6-v2/`: **Xenova/all-MiniLM-L6-v2**, pinned Hugging Face
  revision `751bff37182d3f1213fa05d7196b954e230abad9`, Apache-2.0.
  Uses `onnx/model_quantized.onnx`, `config.json`, `tokenizer.json`,
  `tokenizer_config.json`. Mean pooling, normalized, 384 dimensions.
- `data/passages-*.json`: Wikipedia excerpts, **CC BY-SA 4.0**. Each result links
  the recorded source revision and contributor history. Excerpts are bounded
  character spans and may start/end mid-sentence. `data/source.json` records the
  snapshot date, selection and byte counts. No private data is included.
- `assets.json`: exact byte counts and SHA-256 checksums for distributed model,
  runtime, corpus and associated license files.

The quantized model is about 23 MB, WASM/runtime about 11 MB, and the larger
2,000-passage text/vector bundle about 4.5 MB. These deliberate, one-time downloads
allow genuinely new free-text questions without a network API. Both corpus sizes
are shipped; only the selected size downloads. The library runtime is untouched.

## Run and reproduce

```sh
node tools/wiki-demo-server.mjs
# Prints an ephemeral local URL with the same /idb-vector/ subpath as Pages.
node tests/wikipedia-demo.mjs
node tests/wikipedia-demo.mjs https://paulkinlan.github.io/idb-vector/demo/
```

Tests use the existing raw-CDP helper and a fresh Chromium profile. They click
Load, type unseen questions, assert topic retrieval and displayed scores, disable
the network, require a real fetch failure, and repeat both the same and a new
query. They also switch corpus size, reload/restore stored data, test mobile width
and clear the demo's data. JSON receipts/screenshots go to `/tmp/idb-wikipedia-demo`
(or `IDB_DEMO_EVIDENCE`). No browser-test dependency was added.

To rebuild public text and vectors (no key or paid API request):

```sh
node tools/embed-wikipedia.mjs # WITHOUT --embed: public Wikipedia text only
node tools/prepare-wikipedia-demo.mjs .cache/real-vectors/wiki-api/passages.json
```

To re-encode exactly the committed text rather than fetch current Wikipedia:

```sh
node tools/prepare-wikipedia-demo.mjs demo/data/passages-2000.json
```

The 250-passage text/vector pair is **539,594 bytes**; the 2,000-passage pair is
**4,259,714 bytes**. Model/runtime bytes are additional and shared between sizes.

Preparation runs the exact browser encoder from `encoder.js`, in batches of 16,
and saves Float32 vectors alongside attributed text. It filters missing revision
attribution from older snapshots. The source collector now retains revision IDs
across MediaWiki continuation responses. New Wikipedia revisions can change the
corpus, so the committed snapshot/checksums are the reproducible demo input.

To restore vendored dependencies, run `npm pack @xenova/transformers@2.17.2` in a
temporary directory and copy `dist/transformers.min.js`, `dist/ort-wasm-simd.wasm`
and its LICENSE from the archive. Fetch the four model files listed above from
`https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/`.
Keep the license files with them and verify `assets.json` hashes. No npm dependency
is needed to serve the demo.

## Deployment

`.github/workflows/pages.yml` publishes only `demo/`, `index.js` and
`utils/sortedarray.js`. It does not upload caches, credentials, beads or research
artifacts. GitHub Pages must use **GitHub Actions** as its source. A push to `main`
or a manual workflow dispatch deploys the staged artifact. The repository root
redirects to `./demo/`; all application asset paths are relative.
