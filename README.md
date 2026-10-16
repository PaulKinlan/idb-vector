# Vector IDB

IndexedDB as a Vector Database

## Introduction

IndexedDB as a Vector Database is a project that explores the concept of using IndexedDB as a vector database directly in the browser. It provides a simple wrapper over IndexedDB, allowing efficient storage and querying of vector data. This project was inspired by the existence of database companies that specialize in vector search and the usefulness of services like Polymath and Pinecone.

If you're unfamiliar with vector databases and their benefits, you can start by reading the article ["IndexedDB as a Vector Database"](https://paul.kinlan.me/idb-as-a-vector-database/).

## Wikipedia search demo

[Open the demo](https://paulkinlan.github.io/idb-vector/demo/): explicitly load
250 or 2,000 real Wikipedia passages into IndexedDB, type a question, then turn
the network off and search again. The local MiniLM encoder needs no API key;
load, question-encoding and database-search timings are shown separately.
The open page works offline after loading; **reload still needs networking**.
First load downloads about 35–39 MB, including the model and runtime.
See [demo documentation](demo/README.md) for attribution, reproduction and limits.

## Architecture research

[Read the HTML report](https://paulkinlan.github.io/idb-vector/research/) on
IndexedDB access patterns, HNSW, WebGPU and anisotropy. It preserves evidence
labels, citations, contradictions and missing evidence; dated publication notes
separate the original hypotheses from subsequent measurements.

Edit `research/architecture.md`, then run `npm ci && npm run build:research`.
The committed generator uses **marked 17.0.4** (a build-only development dependency);
`research/index.html` is self-contained with no runtime JavaScript or dependencies.
Publication notes and styles live in `tools/build-research.mjs`.
The Pages workflow rebuilds the report and publishes `/research/` alongside `/demo/`.
`npm run test:research` drives Chromium via the existing raw-CDP helper; add
`-- --links` to check external citations and visit representative sources.
After deployment, `RESEARCH_URL=https://paulkinlan.github.io/idb-vector/research/ npm run test:research`
checks the public page. Screenshots and a JSON receipt go to `.cache/research-evidence/`
(or `RESEARCH_EVIDENCE`).

## Usage

To use Vector IDB, you need to import the `VectorDB` class from the `idb-vector` package.

```javascript
import { VectorDB } from "idb-vector";
```

### Initialization

Create a new instance of `VectorDB` by providing the vector path.

```javascript
const db = new VectorDB({
	vectorPath: "embedding",
});
```

The `vectorPath` parameter names **one top-level property** of the stored records, and the value at that property must be an array. A dotted name such as `"nested.vector"` is refused at construction with a `TypeError`, because this library reads `record[vectorPath]` literally: it does not resolve an IndexedDB key path. Flatten the field before inserting (`{ vector: [...] }`), or write through the `objectStore` escape hatch yourself.

### Inserting Data

To insert data into the VectorDB, use the `insert` method. It returns a promise that resolves to the generated key.

```javascript
const key1 = await db.insert({
	embedding: [1, 2, 3],
	text: "ASDASINDASDASZd",
});
const key2 = await db.insert({
	embedding: [2, 3, 4],
	text: "GTFSDGRG",
});
const key3 = await db.insert({
	embedding: [73, -213, 3],
	text: "hYTRTERFR",
});
```

### Updating Data

To update existing data, use the `update` method. Provide the key of the entry to update and the updated data.

```javascript
await db.update(key2, {
	embedding: [2, 3, 4],
	text: "UPDATED",
});
```

### Deleting Data

To delete an entry from the VectorDB, use the `delete` method and provide the key.

```javascript
await db.delete(key3);
```

### Querying Data

To query the VectorDB based on vector similarity, use the `query` method. Provide the target vector and an optional configuration object. The method returns a promise that resolves to a list of entries ordered by cosine similarity.

```javascript
console.log(
	await db.query([1, 2, 3], {
		limit: 20,
	})
);
```

The `limit` option allows you to specify the maximum number of results to return.

### Contract and validation

`insert()`, `update()` and `query()` refuse invalid input **before** opening a transaction, so a
refused call writes nothing. Invalid arguments reject with a `TypeError` (a bad vector, path or
options shape) or a `RangeError` (a `limit` that is not a positive integer), and every message names
the value at fault.

- **Vectors** must be an `Array` (not a typed array) with at least one coordinate, every coordinate
a finite number, and at least one coordinate nonzero. Empty, zero, `NaN` and `Infinity` vectors are
refused: cosine similarity against a zero vector is `NaN`, and a stored `NaN` score used to rank
ahead of real matches.
- **`limit`** must be a positive integer. Omitting it — or passing `{}`, as in
`query([1, 0], {})` — means `limit: 10`, never "no limit".
- **Options are an allow-list.** `query()` accepts `limit` and `threshold` and **refuses any other
option by name** — `query(vector, { predicate: fn })` is a `TypeError`, not an unfiltered ranking.
When the refused option names a candidate source (`index`, `range` or `predicate`) the message says
to use `queryCandidates()` instead. A query that looks filtered must never silently return
unfiltered results (`idb-vector-5a8`).
- **Dimensions.** Every vector in one object store must have the same length as the vectors you query
it with. A record whose vector is present but has another length (or is otherwise invalid) makes
`query()` **reject and name that record's key**; it is never silently skipped. Fix the record or
`delete()` it, then query again.
- **Missing vectors** are treated differently from invalid ones: a record with no value at
`vectorPath` is not part of the corpus at all, which is the rule an IndexedDB index applies to a
missing key path.

Records written by another connection — or by an older version of this package — are held to the same
contract at query time, and a query that meets one reports the offending key instead of returning a
ranking built from it.

## Candidate queries: rank a set your own indexes select

`query()` always scans the whole store. When you already keep metadata indexes on your own
schema, `queryCandidates()` returns an exact top-k over the candidate set those indexes select,
and discloses what it read:

```javascript
// Your schema, your upgrade transaction: this library never creates or migrates an index.
const caller = await new Promise((resolve, reject) => {
  const request = indexedDB.open("my-app", 2);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("docs", { keyPath: "id" });
    store.createIndex("category", "category");
    store.createIndex("tenant_category", ["tenant", "category"]); // compound: lexicographic prefix
  };
  request.onsuccess = () => resolve(request.result);
});
caller.close();

const db = new VectorDB({ dbName: "my-app", objectStore: "docs", vectorPath: "embedding" });
const { results, info } = await db.queryCandidates(queryVector, {
  limit: 10,
  index: "category", // optional: an IDBIndex on your store
  range: IDBKeyRange.only("news"), // optional: an IDBKeyRange on that index
  predicate: (record) => record.published === true, // optional: JS check, applied before ranking
});
// info = { mode: "index", index: "category", range: { lower: "news", upper: "news", lowerOpen: false, upperOpen: false },
//          predicate: true, recordsRead: 41, recordsScored: 38, fullScanRequired: false, reason: null, limit: 10 }
```

- `index` and `range` are **yours**. The library opens your database at its own version and never
upgrades it; a missing index rejects with the list of available index names, never a silent scan.
A database that does not exist yet is still created at version 1 with the store and vector index.
- `range` without `index` selects a range of the store's own keys.
- `predicate` runs **before** ranking, so it cannot lose a match that a later top-k truncation
would have hidden.
- `info.fullScanRequired` is `true` exactly when the spec reads every record (no index and no
range), where a predicate cannot reduce the reads; `info.reason` says which case applies.
- A record with no value at the indexed field is absent from that index, so it is not a candidate.
Use a predicate without an index when such records must be considered. A `multiEntry` index is
refused: it visits one record once per matching entry, which would rank that record more than once.
- `recordsScored` below `recordsRead` means the predicate removed candidates; a `recordsRead` far
below the store size is the point of an index. An index or range restricts the corpus, so fewer
than `limit` results only means "fewer matches" when `fullScanRequired` is `true`.

### Eligibility, thresholds and what a candidate query promises

A candidate query answers one question exactly: **the top-k of the records its candidate spec
selected**, by cosine similarity. That is not the same claim as "the top-k of the store".

- `threshold` (a cosine similarity in `[-1, 1]`, default none) keeps only records whose similarity
is `>= threshold`. It is applied **before** truncation to `limit`, so a result set shorter than
`limit` always means the eligible set itself holds fewer than `limit` records, never that a
better-scoring eligible record was dropped. Omit it for no threshold: `null` is refused rather
than read as "no threshold" (the same rule as `limit: null`), so `query()` and `queryCandidates()`
accept the same values and a threshold a caller computed as `null` by mistake is never dropped
silently. A value outside `[-1, 1]` is refused too, instead of silently returning nothing, and an
invalid one rejects with `TypeError`/`RangeError`.
- `info.recordsScored` is that eligible count: the records that passed the predicate and the
threshold and were ranked. `results.length` is `min(limit, recordsScored)`.
- **Ties.** Records with equal similarity keep the order they were read in: store key order for a
full scan, index order for an index read. Truncation to `limit` therefore keeps the earliest-read
records of a tie group, so the same store and the same spec always produce the same top-k.
- `info.recordsRead === 0` means the candidate spec read nothing at all; `recordsRead > 0` with
`recordsScored === 0` means candidates existed and **none** of them was eligible. Those are
different answers and are reported separately.
- **Exactness scope.** `info.candidateSetComplete` is the promise field: `true` only when every
record in the store was a candidate, so the result is the **exact global eligible top-k**. With
`mode: "index"` or `mode: "store-range"` it is `false`: the result is exact only **within the
records that spec read**, because a record with no value at the indexed field, or outside the key
range, is not a candidate and the library cannot know whether a different predicate would have
accepted it. Exact reranking of a pruned candidate set is not exact global retrieval, and this
library does not label it as such. `info.fullScanRequired` states the same thing from the cost
side ("did this spec force a full read?") and is `true` under exactly the same condition today;
they are separate fields because a future bounded source may be exhaustive on purpose.
## Read strategy: cursor scan and hoisted query norm

`query()` and `queryCandidates()` read with a cursor over the object store or candidate index within a single transaction:

- **Single snapshot isolation.** Every query runs in the **one** transaction the query opened, so the
whole query sees a single consistent view: a concurrent writer on another connection cannot tear the read.
A query is not a live subscription - if you need subsequent writes to be visible, run a new query.
- **One implementation of the rules.** The cursor path applies consistent per-record rules: a record with
no vector at `vectorPath` is skipped, an invalid or wrong-dimension record is refused by key, and eligibility
(the predicate) is decided before ranking.
- **The query vector's norm is computed once per query**, not once per record. Hoisting it does not
change any result: the per-record arithmetic and its accumulation order are identical, so scores are
bit-for-bit what they were. Prior versions recomputed it for every record scored, which at 100k
records x 128 dimensions is millions of redundant operations per query.

## Optional packed snapshots (new API)

Default `query()` still scans IndexedDB and sees writes from other connections.
For repeated queries on a deliberately frozen corpus:

```javascript
// Supply your application's available packed-buffer budget; this is an example, not a limit.
const snapshot = await db.createSnapshot({ maxBytes: 128 * 1024 * 1024 });
console.log(snapshot.diagnostic); // coordinate-variance screen, with limitations
const { mode, results } = await snapshot.query([1, 2, 3], { limit: 20 });
// results contain {key, similarity}, NOT document objects; mode is "snapshot" or "live".
await snapshot.refresh(); // explicitly include intervening writes/deletes
snapshot.close(); // release packed buffers
```

Over budget, allocation failure or unsupported keys/vectors evicts the cache and uses
the live cursor without truncating valid records. Live fallback preserves string keys,
but skips missing, malformed or non-finite vectors and undefined cosine scores
instead of ranking them. Inspect `snapshot.reason` and `bytes`.
The budget covers retained packed buffers, **not all browser heap or arbitrary source
metadata**. Float64 preserves existing JS-number precision; vectors are not normalized
on write. Writes resolve after transaction completion, not merely request success.
Call `await db.close()` when finished with a `VectorDB` to release its IndexedDB
connection before deleting its database. Closing is idempotent; further operations
reject with `InvalidStateError`. An external version upgrade also closes the connection
on `versionchange`, so the application should create a new instance to use the new version.
See [format, resource bounds, evidence and caveats](reports/packed-snapshot.md).

## Optional int8 code side-store with bounded exact rerank

This opt-in, caller-owned side-store is for **non-resident, unfiltered** read-per-query workloads. It never changes `query()` or the packed snapshot path. At 100k × 128, measured code reads plus bounded rerank took 126.2 ms versus 340.3 ms for a packed Float32 snapshot; 100 candidates reached recall@10 1.000 on the measured corpora, **not a universal recall guarantee**. Int8 codes only select candidates; final similarities are computed from the original vectors in Float64. See [ADR 0001](docs/adr/0001-side-store-contract.md) for the identity and snapshot contract.

Create an out-of-line `codes` object store in your own schema upgrade. Maintain a trustworthy corpus-wide epoch in your application: every insert, update, and delete of a vector must advance that epoch (preferably in the same transaction). A constant or per-record revision is **not** an epoch provider. Supply a `getEpoch(db)` callback reading that live epoch; missing or mismatched epochs reject, never silently fall back. Never mutate the corpus without advancing it. The caller owns rebuilding the side-store after changes.

```js
const getEpoch = async (db) => readCorpusEpochFromYourMetadataStore(db);
const stats = await vectors.buildSideStore({ sideStore: 'codes', getEpoch });
const { results, info } = await vectors.querySideStore(queryVector, {
  sideStore: 'codes', getEpoch, epoch: stats.epoch,
  candidateBudget: 100, limit: 10,
});
// results contain exact { key, object, similarity }; keys are IndexedDB primary keys.
```

`candidateBudget` defaults to 300; at most that many originals are fetched in **one** readonly transaction. `eligibleKeys` may be supplied as an Array or Set of primary keys and is applied before the budget with IndexedDB key-value equivalence (including Date, array and binary keys). Record predicates and function-valued `eligibleKeys` are rejected. For selective filters, prefer exact `queryCandidates()` on indexed/eligible originals: a 1% eligible set measured 89.8 ms exact versus 100.2 ms codes. Do not claim a filtered code-store speedup from these measurements.

**Write cost:** codes add approximately one byte per dimension per row plus norms/quantization metadata and primary keys; measured per-row code updates cost 5–323 µs, while writing 100k individual original records already costs 29–48 s on the measurement VM. A resident working set showed no speedup from int8 scanning. Caller-provided epoch correctness is essential: a lying or non-atomic epoch provider cannot be validated by this library.

## Optional geometry diagnostic and whitening (new API)

```javascript
import { diagnose, fitWhitening } from "idb-vector";
const vectors = [[10, 1], [20, 2], [30, 4], [40, 3]];
console.log(diagnose(vectors)); // dominance, 1/d baseline, relative dominance, warning
const whitening = fitWhitening(vectors); // explicit opt-in; originals are untouched
const transformed = vectors.map(v => whitening.transform(v));
const transformedQuery = whitening.transform([15, 2]); // use the SAME corpus fit
const reconstructed = whitening.inverse(transformed[0]); // original, within roundoff
// Insert transformed vectors into a SEPARATE VectorDB; compare against the original DB.
```

Whitening is **off by default** and intended for experimenting with crowded embeddings,
not as a general upgrade. Removing top principal directions harmed well-spread encoders
in the cited study (cosine correlation −0.014); that is not the same intervention as
whitening and does not prove retrieval-quality gains or losses for your data. Keep the
originals and compare labelled retrieval results with whitening on/off.

The coordinate-variance warning is dimension-relative and heuristic; it cannot detect
all correlated anisotropy or tell you whether whitening will help. Unchanged rankings
do not prove isotropy. Full-covariance regularized Cholesky fitting is O(n d² + d³)
time and O(d²) extra memory: use a worker for large corpora. `regularization` defaults
to 1e-6 relative to mean variance and must be positive. No automatic fitting or mutation
of stored vectors occurs. See [details and real-corpus comparison](reports/packed-snapshot.md).

`npm run measure:packed` repeats the storage experiment; `npm run test:packed` drives
snapshot behavior, exact scores, rollback and optional whitening in Chromium.

## Browser demo and measurements

Run `npm run demo` (Node 22+) and open the loopback URL it prints. Create a synthetic
vector dataset, choose a query vector and see nearest neighbours and timings. The
experimental metadata-index comparisons do not change the library API.
No model downloads, new dependencies or fixed ports are required.

`npm test` drives the demo in installed Chromium and then runs `tests/validation.mjs`, which
drives the numeric/options/path contract (refusals, error classes and messages, no partial
writes) in the same browser, `tests/candidates.mjs`, which checks candidate queries against a
full eligible-set oracle (selectivity, range endpoints, compound keys, duplicate index keys,
missing metadata, caller-owned schemas), `tests/eligibility.mjs`, and `tests/snapshot-isolation.mjs`,
which tests snapshot isolation during queries. `npm run test:validation`, `npm run test:candidates`,
`npm run test:eligibility`, and `npm run test:isolation` run one battery each; `npm run measure:candidates`
adds the index build/write/storage measurement, which is kept out of `npm test` because it writes 40,000 records.
`npm run measure` reproduces the 1k/10k/100k browser study. See
[the analysis](reports/browser-analysis.md) for exact
trees, conditions, raw evidence, correctness findings and the Beads improvement plan.
Compact candidate passes (int8, 1-bit sign, coarse cosine buckets) and the IndexedDB read leg a
side-store would add are measured against that same exact oracle in
[the compact-pass analysis](reports/quantized-candidate-pass.md), reproducible with
`node tools/evaluate-quantized-pass.mjs`; none of them is implemented in the library. The int8
code side-store is then measured end to end as a single query — codes read, codes scanned, top-N
originals fetched by key, exact rerank — in
[the side-store query measurement](reports/side-store-query.md)
(`node tools/evaluate-side-store-query.mjs`, `IDB_KUC9_SMOKE=1` for a seconds-long version), which
is also research only. It concludes that the code store is worth having for the unfiltered
read-per-query path (2.2–5.6× faster and 3.9× fewer bytes read than a packed Float32 snapshot per
query, and 15–42× faster than a batched walk over the individual records) and that it must **not** be
used for a selectively filtered query, where fetching the eligible originals by key and ranking them
exactly is 7–17% faster and needs no code store.
The demonstration uses disposable databases and can consume significant space at 100k
vectors; see the analysis for cleanup and unverified boundaries.

## Real-vector recall suite (research only)

The separate suite compares the library's default exact scan with an **experimental
IVF index**, using GloVe word vectors with shipped neighbours and real Wikipedia API
embeddings. IVF remains research-only; optional whitening is a separate supported utility as described above.

```sh
npm run real:prepare  # ~127 MB public GloVe download; Python venv + pinned NumPy/h5py
npm run real:embed    # OPT-IN PAID OpenAI embeddings, reads OPENAI_API_KEY from environment
npm run real:measure # cached data only: real Chromium, IndexedDB, raw JSON + screenshots
```

Preparation uses Python 3 and internet access; measurement uses Node 22+ and installed
Chromium (`IDB_VECTOR_CHROME` overrides). The embedding command fetches public Wikipedia
extracts, holds out 40 queries and embeds up to 10,040 passages with
`text-embedding-3-small` at 256 dimensions. Estimated spend is capped at **$0.25 per
prepared corpus** at the documented list price. Paid requests are cached; ambiguous
failures retain a marker and are **not automatically retried**. Keys are never cached.
No API calls happen during measurement. Keep `.cache/real-vectors` to replay the same
vectors without spending again; deleting it discards that cache. Later Wikipedia/model
responses can change, so compare the recorded corpus hashes before comparing runs.

One command to replay prepared corpora: **`npm run real:measure`**. Outputs default to
`/tmp/idb-vector-real-measurements.json` and adjacent screenshots; set `IDB_REAL_REPORT`
to keep a run elsewhere. Public-only quick run after preparation:
`IDB_REAL_CORPORA=glove25-10000 npm run real:measure`. The full run includes 10k, 100k and
1,183,514 GloVe vectors plus 10k API embeddings, 40 queries per setting; allow several
minutes and temporary disk space. Every approach owns a fresh profile and ephemeral
server, and deletes only that profile on exit. This is not a cold-disk or mobile benchmark.

## Limitations and Considerations

Vector IDB is a simple wrapper over IndexedDB and serves as a starting point for using IndexedDB as a vector database. It does not include advanced optimizations, pre-filtering of the query space, or extensive post-filtering capabilities. The goal of this project is to provide a simple solution for quick integration with IndexedDB, especially for applications that already have a complex IndexedDB setup.
