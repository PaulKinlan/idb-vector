# Vector IDB: browser baseline and a practical path beyond the limitations

## Scope and provenance

The library is an exact cosine-similarity cursor scan over an IndexedDB object store,
with a bounded sorted result array. It is not an ANN index. All three original source
files were read (`index.js`, `utils/sortedarray.js`, `test-harness/index.html`), along
with README, package metadata and publishing workflow. **Runtime library code is unchanged.**
The added demo compares experiments, not newly supported library APIs.

All performance numbers below share this condition:

- **Library:** `e346cc45c59b5d83d00f2c392afd55fd7d7902d6`.
- **Measured harness:** `1662ae6fca82ca263b9c3a7c1c4192924c18ef09`.
  The only tracked dirty file during measurement was Beads interactions metadata.
- **Browser:** headless Chromium `152.0.7977.82`, V8 `15.2.124.21`, fresh temporary profile.
- **Machine:** Linux `7.2.3-arch1-3`, AMD Ryzen 9 9955HX, 32 logical CPUs,
  98,766,901,248 bytes RAM. Shared machine, not an idle or controlled-performance host.
- **Run:** 2026-09-21 08:21:02–08:21:24 UTC; load averages start
  1.72/2.66/3.42, end 2.51/2.79/3.45.
- **Data:** deterministic LCG-generated synthetic arrays, **128 dimensions**, numeric
  components in [-1,1), category `id % 100`, query vector ID42, cosine, **k=10**.
  These are not representative text embeddings. Keys are sequential numeric keys.
- **Procedure:** actual library inserts, a transaction-completion barrier, three queries
  per method per size, rotated method order. Fresh databases by size, same browser process;
  recent writes, warm filesystem/cache possible. Not cold-start/disk latency. Timings include
  database reads, deserialization, scoring and ranking; exclude fixture construction.
- Raw timings, ordered result keys, browser details and defect observations:
  [browser-measurements.json](browser-measurements.json). Reproduce: `npm run measure`.

## 1. Advanced optimizations: start with the exact scan

Median **[min–max] milliseconds**, under the condition above:

| Records × dimensions, k | Existing cursor scan | Paged exact experiment | Observed median ratio |
|---|---:|---:|---:|
| 1,000 × 128, 10 | 14.0 [13.3–49.7] | 9.3 [8.6–10.4] | 1.51× |
| 10,000 × 128, 10 | 92.0 [91.1–129.9] | 77.7 [75.6–80.0] | 1.18× |
| 100,000 × 128, 10 | 941.6 [906.5–1024.9] | 796.3 [764.1–802.0] | 1.18× |

The candidate uses `getAll` pages of 1,000 records and computes the query norm once,
then loops over components to compute dot product and record norm. It reuses the
library's `SortedArray`. **Ordered top-10 keys match the original in all nine trials.**
These are combined changes: this run cannot attribute improvement to batching versus
arithmetic individually. Three observations are not a statistical performance guarantee.

**Proposal:** keep exact search as default; evaluate this bounded-read implementation
before a heap, ANN structure or another dependency. Cursor scans are O(N×D) scoring;
this changes constants, not that complexity. The existing result structure additionally
shifts up to k entries per scored record; with measured k=10, a heap is not yet justified.

**Costs:** each page retains up to 1,000 full records plus top-k, rather than one cursor
record; peak heap was not measured. The prototype opens a transaction per page, assumes
immutable data and derives keys from fixture IDs. A production version must preserve
arbitrary keys, missing/deleted records and snapshot consistency, not copy these assumptions.
A single read transaction with synchronously enqueued next-page requests is one option;
its browser behavior and concurrent-write semantics need tests. Workers may improve UI
responsiveness, not necessarily total latency; neither was measured here.

Library seeding under the same tree/browser/hardware, one run per size at 128D:
1k **92.4ms**, 10k **888.0ms**, 100k **9860.7ms**. Candidate-store seeding was
22.9/229.5/2862.0ms respectively, but it used 1,000-record transactions and a different
index schema. **That is not a controlled bulk-insert speedup claim.** The original creates
an index over the vector array although query never uses it; an index-free/bulk-write
comparison is needed before claiming reduced storage or write cost.

## 2. Pre-filtering: use IndexedDB's indexes for metadata, not vector distance

Same condition, category 7, exactly 1% eligible, k=10. Both experiments run against the
same separate candidate store with a category index and identical vectors/keys. This
isolates index selection from the candidate store's schema difference versus the library.
Median **[min–max] ms**:

| Records × dimensions | Exact paged predicate scan | Exact category-index read | Records visited: scan → index |
|---|---:|---:|---:|
| 1,000 × 128 | 7.9 [7.5–8.9] | 0.2 [0.1–2.0] | 1,000 → 10 |
| 10,000 × 128 | 68.8 [68.0–71.8] | 1.0 [0.9–2.1] | 10,000 → 100 |
| 100,000 × 128 | 735.1 [729.5–900.5] | 13.5 [13.5–13.5] | 100,000 → 1,000 |

**Ordered eligible top-10 keys match in all nine trials.** The 100k observed median
ratio is 54.45× versus scanning that candidate store, for this highly selective filter.
The category-index experiment retrieves all matches in one call: bounded to at most
1,000 here, **not safe to assume for a general broad filter**. A production index cursor
must page duplicate index keys using both index key and primary key, or stream them.

What the platform supports:

- Equality/range selection using an object-store key or an `IDBIndex` plus `IDBKeyRange`.
  An index cursor or `getAll` can select candidates *before* full-vector scoring.
- Compound keys provide lexicographic ordering: useful for tenant/category followed by
  a range dimension when the leading fields are constrained. They are not a general
  multidimensional predicate planner. Missing/non-indexable metadata is omitted from
  indexes; the API must define its treatment.
- Multi-entry indexes can help tag membership. Multi-index AND intersections and OR
  unions/deduplication are application work; the browser does not plan arbitrary joins.
- Partitioning by tenant/category can use compound index prefixes or separate stores.
  Existing application schema/migrations should remain caller-owned. Do not create a
  store per ad-hoc filter: object-store changes require version upgrades.
- IndexedDB **cannot** sort a cursor by cosine/dot product, use a JS predicate as an
  index comparator, or treat its lexicographic vector-array index as a nearest-neighbour
  index. Non-indexable predicates still require candidate reads and application checks.

**Proposal:** accept a caller-owned database/store and optional index/key range, plus a
predicate fallback. Do not silently upgrade an application's complex schema. Today the
library opens version 1 and only creates the store in `onupgradeneeded`; its getter returns
only the store *name*, not a database connection. Compatibility with existing version>1
schemas has not been browser-tested in this slice and must be a new acceptance case.

**Costs:** schema upgrade, an index entry per record, update/delete maintenance and possible
blocked upgrades. Storage amplification, index build time isolated from writes, varying
selectivity and multi-index intersections were not measured. Those are required before
promising the 1% result for other applications.

### Quantized pre-pass / approximate indexes

Not implemented or timed: no ANN speed or recall claim follows from this experiment.
A compact side store (int8 quantization, sign bits, or coarse buckets) could reduce
candidate-read payload, then fetch originals and rerank. Merely appending quantized bytes
to the same full-vector record does not avoid deserializing that record. IDB can index a
bucket ID; it cannot natively rank arbitrary quantized distances.

For 128D, raw numeric payload arithmetic is 1,024 bytes at float64 versus 128 int8 bytes
plus scale metadata, **not measured IndexedDB disk savings**. Sign hashing, quantization
and bucket pruning all need measured eligible-set recall; reranking does not restore
omitted neighbours. Additional costs: versioned side-index lifecycle, atomic updates,
rebuilds, memory and storage. Defer HNSW/PQ selection until a real embedding corpus,
dimension sweep, candidate budgets and mobile measurements demonstrate a need beyond
exact metadata-indexed search. This is a research bead, not a claimed fix.

## 3. Post-filtering: make the requested result set correct first

Same condition, all three corpus sizes ×128D, ID42, category7, k10, all nine trials:
**filtering the global top 10 afterwards returns 0**, whereas ranking eligible records
returns **10**. Recall relative to the exact eligible top 10 is **0/10**. The demo also
lets users query a vector within category7; then a self-match can survive while other
eligible neighbours are still lost. The negative control is real, not a mocked response.

**Proposal:** define eligibility before top-k. An index narrows the domain; arbitrary
predicates run before ranking the retained items. For exact search, scan every eligible
candidate (or use a proven bound) and apply score thresholds consistently. Return fewer
than k only when the defined eligible set/threshold truly contains fewer.

For approximate retrieval, evaluate predicate constraints before pruning where possible;
exact-rerank surviving vectors, refill adaptively, and provide a full eligible-scan fallback
when exactness is requested. A fixed oversampling factor cannot guarantee k eligible
results or recall, especially when filter and similarity correlate adversely. Reranking
corrects scores among candidates, **not recall outside them**. Diversity/group quotas or
other rerankers change the objective and must be labelled separately from nearest neighbours.

Measure recall@k against **exact top min(k, eligibleCount)** for each query/filter, with
ties defined and empty eligibility reported separately. Include correlated/adversarial
filters, candidate budget, latency and storage overhead. The extra exact fallback costs
up to the measured full eligible scan; approximate quality/performance is currently unknown.

## Correctness blockers found while driving the browser

Same original library tree and Chromium/hardware as above; observations in raw JSON:

- **Acknowledgement before durability:** an actual transaction aborted after add-request
  success; `insert` nevertheless resolved key 4, abort was confirmed, and a subsequent query
  did not contain key 4. Resolve mutations on transaction completion, reject abort/error.
  Update/delete share the request-success pattern by source inspection, not driven aborts.
- **Invalid vectors poison ranking:** zero and Infinity vectors were accepted; scores were
  `[NaN, NaN, 1]`. Validate finite components/nonzero magnitude and define dimension policy.
- **Partial query options:** `query([1,0], {})` returned zero results rather than default ten.
- **Path mismatch:** insertion of `{nested:{vector:[1,0]}}` for `vectorPath:'nested.vector'`
  rejected. README says property path; implementation reads a literal top-level property.
- **Connection lifecycle:** no close API; demo requests database deletion but it may remain
  blocked by the library connection until page closure. A crashed tab/aborted seed can leave
  demo databases behind; clear this origin's site data to reclaim them. No unrelated DBs touched.

## Beads and suggested order

Project database initialized in this repository; no journal-private data imported.

| Bead | Work |
|---|---|
| `idb-vector-u4o` | This baseline, analysis and interactive demo; independent review pending |
| `idb-vector-kuc` | Epic: practical exact-search/filtering improvements |
| `idb-vector-kuc.1` | Bounded exact reads + hoisted norm; snapshot/arbitrary-key tests |
| `idb-vector-kuc.2` | Caller-owned schemas and index/key-range selection |
| `idb-vector-kuc.3` | Eligibility-before-top-k and honest approximate recall |
| `idb-vector-kuc.4` | Transaction-completion acknowledgement and connection lifecycle |
| `idb-vector-kuc.5` | Numeric/options validation and explicit path/dimension contract |
| `idb-vector-kuc.6` | Quantized candidate-pass research with real recall/cost evidence |

Each improvement bead has evidence, proposal and a driveable acceptance condition.
Fix transaction and numeric correctness first; then exact filtering/schema integration,
then benchmark-driven scan improvements. Quantization/ANN is deliberately later.

## Try it / reproduce

Node 22+ (tested with Node 24), installed Chromium/Chrome. **No new dependencies.**

```sh
npm run demo          # prints its own ephemeral loopback URL; open it
npm test              # fresh browser: real clicks, changed query, category results,
                      # 360/390/430 and landscape layout checks
npm run measure       # above checks plus 1k/10k/100k runs and defect observations
```

Set `IDB_VECTOR_CHROME` to a nonstandard Chromium executable. The measurement command
writes `/tmp/idb-vector-measurements.json` by default (`IDB_VECTOR_REPORT` overrides it).
Screenshots: `/tmp/idb-vector-before.png`, `/tmp/idb-vector-after.png`,
`/tmp/idb-vector-landscape.png`. Each run owns its server, ephemeral port, temporary browser
profile and synthetic databases. It does not touch Paul's other test surfaces.

UI checks exercise dataset creation, ID42 self-match, changing query to ID7, native category
selection and visible results. They are not a mobile-device speed or screen-reader audit.
The benchmark exercises the same experiment module directly through CDP.

## Unverified boundaries

No Safari/Firefox/physical phone; no real embeddings, cold disk, background-tab throttling,
worker responsiveness, peak heap or disk quota measurement. No approximation implemented,
no recall claim beyond this synthetic exact dataset. No concurrent writers, arbitrary-key
production paging, tie/adversarial-vector suite, tenant authorization or multi-index planner.
No production API fixes shipped, no npm release, no public deployment and no main merge.
Independent review is required before branch publication. Existing `npm test` was a no-op;
it is now the real browser smoke check, not an exhaustive library conformance suite.
