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

The `vectorPath` parameter specifies the property path in the JSON documents where the vector is stored. The vector should be represented as an array.

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

## Browser demo and measurements

Run `npm run demo` (Node 22+) and open the loopback URL it prints. Create a synthetic
vector dataset, choose a query vector and see nearest neighbours and timings. The
experimental metadata-index and paged-scan comparisons do not change the library API.
No model downloads, new dependencies or fixed ports are required.

`npm test` drives the demo in installed Chromium; `npm run measure` reproduces the
1k/10k/100k browser study. See [the analysis](reports/browser-analysis.md) for exact
trees, conditions, raw evidence, correctness findings and the Beads improvement plan.
The demonstration uses disposable databases and can consume significant space at 100k
vectors; see the analysis for cleanup and unverified boundaries.

## Real-vector recall suite (research only)

The separate suite compares the unchanged library's exact scan with an **experimental
IVF index**, using GloVe word vectors with shipped neighbours and real Wikipedia API
embeddings. Neither IVF nor preprocessing is a supported runtime API.

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
