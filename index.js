import { SortedArray } from "./utils/sortedarray.js";
import { createPackedSnapshot } from "./utils/packed-snapshot.js";
import { buildCodeRecord, scanSideStore, rerankCandidates } from "./utils/side-store.js";
export { diagnose, fitWhitening } from "./utils/geometry.js";
export { buildCodeRecord, scanSideStore, rerankCandidates } from "./utils/side-store.js";

const DB_DEFAUlTS = {
  dbName: "vectorDB",
  objectStore: "vectors"
};

// Argument validation. Contract, documented in README.md:
//   * vectorPath names ONE top-level property. Dotted strings and IDB key-path arrays are refused
//     at construction because this library reads `record[vectorPath]` literally; silently creating
//     an index for a path it cannot read is worse than refusing the name.
//   * a vector is a non-empty Array of finite numbers with at least one nonzero coordinate, because
//     cosine similarity against a zero vector is NaN and would rank ahead of real matches.
//   * limit is a positive safe integer, and missing options mean limit 10 (not "no limit").
function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `an Array of length ${value.length}`;
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertVectorPath(vectorPath) {
  if (typeof vectorPath !== "string" || vectorPath.length === 0) {
    throw new TypeError(`vectorPath must be a non-empty string naming one top-level property; got ${describe(vectorPath)}`);
  }
  if (vectorPath.includes(".")) {
    throw new TypeError(`vectorPath must name one top-level property; ${describe(vectorPath)} contains '.', which this library does not treat as a key path. Store the vector under a top-level property (for example vectorPath: "vector") or use the objectStore escape hatch directly.`);
  }
}

function assertVector(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an Array of finite numbers; got ${describe(value)}`);
  }
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty; a vector needs at least one coordinate`);
  }
  for (let index = 0; index < value.length; index++) {
    const coordinate = value[index];
    if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) {
      throw new TypeError(`${label} coordinate ${index} must be a finite number; got ${describe(coordinate)}`);
    }
  }
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== 0) return value;
  }
  throw new TypeError(`${label} must not be all zeros; cosine similarity against a zero vector is undefined (NaN)`);
}

function assertLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive integer; got ${describe(limit)}`);
  }
  return limit;
}

// A similarity threshold is applied BEFORE top-k truncation, so a result set shorter than `limit`
// always means the eligible set itself holds fewer than `limit` records. Cosine similarity lies in
// [-1, 1], so a threshold outside that range could only ever empty the result silently.
function assertThreshold(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`threshold must be a finite number; got ${describe(value)}`);
  }
  if (value < -1 || value > 1) {
    throw new RangeError(`threshold must be a cosine similarity between -1 and 1; got ${describe(value)}`);
  }
  return value;
}

// --- candidate selection -----------------------------------------------------------------------
// `query()` ranks every record. `queryCandidates()` ranks a candidate set chosen by the CALLER's
// own IndexedDB schema (an index name and/or an IDBKeyRange) plus an optional JS predicate. The
// library never creates, migrates or upgrades that schema: a missing index is an error that names
// the available indexes, never a silent full scan. A candidate spec that cannot narrow the read
// discloses `fullScanRequired`, because "fewer results than asked" must not be read as "no more
// matches" when the corpus was restricted.
const CANDIDATE_OPTION_KEYS = ["limit", "threshold", "index", "range", "predicate"];
const QUERY_OPTION_KEYS = ["limit", "threshold"];
const SIDE_STORE_BUILD_OPTION_KEYS = ["sideStore", "key", "epoch", "getEpoch", "revision"];
const SIDE_STORE_QUERY_OPTION_KEYS = ["sideStore", "key", "epoch", "getEpoch", "candidateBudget", "limit", "threshold", "predicate", "eligibleKeys", "codeRecord", "revision"];
const SIDE_STORE_FACTORY_OPTION_KEYS = ["sideStore", "key", "epoch", "revision", "candidateBudget", "getEpoch"];
function assertSideStoreOptions(method, options, allowed) {
  if (!isRecord(options)) throw new TypeError(`${method}() options must be an object; got ${describe(options)}`);
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw new TypeError(`${method}() option ${describe(key)} is not supported; supported options are ${allowed.join(", ")}`);
    }
  }
}
const NO_CANDIDATES = { index: null, range: null, predicate: null };

function normalizeCandidateOptions(options) {
  if (options === undefined || options === null) return { limit: 10, threshold: null, candidates: { ...NO_CANDIDATES } };
  if (!isRecord(options)) {
    throw new TypeError(`queryCandidates() options must be an object such as { index: "category", threshold: 0.5 }; got ${describe(options)}`);
  }
  for (const key of Object.keys(options)) {
    if (CANDIDATE_OPTION_KEYS.includes(key) === false) {
      throw new TypeError(`queryCandidates() option ${describe(key)} is not supported; supported options are ${CANDIDATE_OPTION_KEYS.join(", ")}`);
    }
  }
  const { limit = 10, threshold = null, index = null, range = null, predicate = null } = options;
  assertLimit(limit);
  // `threshold` is a scalar option like `limit`, not one of the candidate spec fields that document
  // null as "none": omit it for no threshold. Accepting null here would silently drop a threshold
  // that a caller computed as null by mistake (query() already refuses it), and the two entry points
  // must agree on what they accept.
  if (options.threshold !== undefined) assertThreshold(threshold);
  if (index !== null && (typeof index !== "string" || index.length === 0)) {
    throw new TypeError(`queryCandidates() index must be a non-empty string naming one index on the object store; got ${describe(index)}`);
  }
  if (range !== null && range instanceof IDBKeyRange === false) {
    throw new TypeError(`queryCandidates() range must be an IDBKeyRange built with IDBKeyRange.only/bound/lowerBound/upperBound; got ${describe(range)}`);
  }
  if (predicate !== null && typeof predicate !== "function") {
    throw new TypeError(`queryCandidates() predicate must be a function of one record returning a boolean; got ${describe(predicate)}`);
  }
  return { limit, threshold, candidates: { index, range, predicate } };
}

// Resolves a candidate spec against the caller's store. The store-dependent check lives here
// because index names can only be read from a store handle.
function selectCandidates(store, { index, range, predicate }, storeName) {
  if (index !== null && store.indexNames.contains(index) === false) {
    const available = Array.from(store.indexNames);
    throw new TypeError(`queryCandidates() index ${describe(index)} is not on object store '${storeName}'; available indexes: ${available.length ? available.join(", ") : "none"}. Create it in your own upgrade transaction: this library never migrates an application schema.`);
  }
  // A multiEntry index visits one record once per matching array element, so the same record would
  // be ranked several times and consume several of the `limit` slots. Refuse it rather than return
  // a silently duplicated ranking.
  if (index !== null && store.index(index).multiEntry) {
    throw new TypeError(`queryCandidates() index ${describe(index)} is a multiEntry index, which visits one record once per matching entry and would rank the same record more than once; use a single-valued index, or select with the predicate option over the store instead`);
  }
  const mode = index !== null ? "index" : range !== null ? "store-range" : "full-scan";
  return {
    index,
    range,
    predicate,
    mode,
    fullScanRequired: mode === "full-scan",
    reason: mode !== "full-scan" ? null : predicate !== null
      ? "predicate without an index or key range: every record in the store is read"
      : "no index or key range: every record in the store is read",
  };
}

// A stored vector can only be recognised as invalid once scoring is not finite, so the happy scan
// path pays nothing for this diagnosis; it runs once, on the record that failed.
function storedVectorError(vectorPath, key, vector, queryVectorLength) {
  const where = `stored vectorPath '${vectorPath}' for key ${JSON.stringify(key)}`;
  const fix = "Delete or re-insert that record, then query again.";
  if (!Array.isArray(vector)) {
    return new TypeError(`${where} must be an Array of finite numbers; got ${describe(vector)}. ${fix}`);
  }
  if (vector.length === 0) {
    return new TypeError(`${where} is empty; a vector needs at least one coordinate. ${fix}`);
  }
  if (vector.length !== queryVectorLength) {
    return new TypeError(`${where} has ${vector.length} coordinates but the query vector has ${queryVectorLength}; every vector in one object store must share one dimension. Re-insert it with ${queryVectorLength} coordinates, or delete it, then query again.`);
  }
  for (let index = 0; index < vector.length; index++) {
    if (typeof vector[index] !== "number" || !Number.isFinite(vector[index])) {
      return new TypeError(`${where} coordinate ${index} is ${describe(vector[index])}, not a finite number; it produces a NaN similarity that would rank ahead of real matches. ${fix}`);
    }
  }
  if (vector.every(coordinate => coordinate === 0)) {
    return new TypeError(`${where} is all zeros; cosine similarity against a zero vector is undefined (NaN). ${fix}`);
  }
  return new TypeError(`${where} overflows cosine similarity: every coordinate is finite but the score is not. Scale that vector to a sane magnitude or delete it, then query again.`);
}

// A caller-owned object store can use an IN-LINE key (`keyPath`). IndexedDB then rejects a key
// argument to put(): the record carries its own key. The value the caller names must be the one
// the record holds, or update() would silently write a different record than the caller asked for.
function keyPathValue(record, keyPath) {
  const paths = Array.isArray(keyPath) ? keyPath : [keyPath];
  const values = paths.map(path => path.split(".").reduce(
    (value, name) => (value === null || value === undefined ? undefined : value[name]), record));
  return Array.isArray(keyPath) ? values : values[0];
}

function sameKey(a, b) {
  try {
    return indexedDB.cmp(a, b) === 0;
  } catch {
    return false;
  }
}

function updateRequest(store, key, object) {
  const keyPath = store.keyPath;
  if (keyPath === null) return store.put(object, key);
  const carried = keyPathValue(object, keyPath);
  if (carried === undefined) {
    throw new TypeError(`update() record has no value at this store's in-line keyPath ${JSON.stringify(keyPath)}; the store takes the key from the record itself`);
  }
  if (sameKey(carried, key) === false) {
    throw new TypeError(`update() key ${JSON.stringify(key)} does not match the value this store's in-line keyPath ${JSON.stringify(keyPath)} carries (${JSON.stringify(carried)}); the store writes the key the record carries`);
  }
  return store.put(object);
}

function cosineSimilarity(a, b, aMagnitude, bMagnitude) {
  const dotProduct = a.reduce((sum, aVal, idx) => sum + aVal * b[idx], 0);
  // `aMagnitude` is the query vector's norm, which ranking hoists out of its per-record loop:
  // recomputing it for every record is pure waste (100k records x 128 dims is millions of
  // redundant operations) and the value is identical, so scores stay bit-identical. Callers that
  // do not pass it (the packed-snapshot fallback) get the same value computed here.
  const magnitude = aMagnitude === undefined ? vectorMagnitude(a, "Query vector") : aMagnitude;
  // `bMagnitude` is the same deal for the record: the ranking loop measures it so it can refuse an
  // unrepresentable record by key (idb-vector-cfr), and passes it in here rather than paying for the
  // same reduce twice. Deliberately NOT vectorMagnitude() for the record - this runs inside the
  // cursor's onsuccess handler, where a throw escapes the surrounding promise and hangs the caller
  // instead of rejecting it; a record that cannot be scored must reach the caller through
  // storedVectorError(), which names its key (idb-vector-utq review).
  const recordMagnitude = bMagnitude === undefined
    ? Math.sqrt(b.reduce((sum, bVal) => sum + bVal * bVal, 0))
    : bMagnitude;
  return dotProduct / (magnitude * recordMagnitude);
}

// Cosine similarity is scale-invariant, but the intermediates are not: squaring the coordinates
// overflows Float64 for any |coordinate| above ~1.34e154 (sqrt(Number.MAX_VALUE)). The magnitude then
// became Infinity, every score collapsed to finite/Infinity = 0, and an unscoreable query looked
// like an all-tie corpus - insertion order returned as a confident ranking (idb-vector-utq).
//
// Only ever called from an async method body or from assertScoreableQuery(), NEVER from a cursor
// callback: a throw inside an IndexedDB event handler escapes the surrounding promise and hangs the
// query rather than rejecting it, so the refusal happens at the API boundary before the scan starts
// (see assertScoreableQuery) and the record side keeps reporting through storedVectorError().
function vectorMagnitude(vector, label = "Vector") {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude)) {
    const reason = Number.isNaN(magnitude)
      ? "a coordinate is not a finite number"
      : "a coordinate above ~1.34e154 overflows Float64";
    throw new TypeError(`${label} has a non-finite L2 magnitude (${magnitude}): ${reason}, so every cosine score would collapse to 0. Normalize the vector first.`);
  }
  return magnitude;
}

// A query this library cannot score must be refused BEFORE the database is opened: a refusal that
// needs a cursor is a refusal a caller can miss, and the unit tier has no IndexedDB to prove it with.
// assertVector() already covers shape, finiteness and the all-zero vector; this adds the magnitude
// the scoring arithmetic actually needs (see vectorMagnitude).
function assertScoreableQuery(vector, label) {
  assertVector(vector, label);
  const magnitude = vectorMagnitude(vector, label);
  // assertVector() already refused an all-zero vector, so a zero magnitude here can only mean the
  // SQUARES underflowed: every coordinate below ~2.2e-162 (the square root of the smallest f64
  // subnormal) squares to 0. Scoring with it gave dot / (0 * recordNorm) = Infinity, which #rank then
  // reported as the STORED record overflowing - blaming a healthy record for the query's fault
  // (idb-vector-aya). Refuse the query instead, as the overflow case already does.
  if (magnitude === 0) {
    throw new TypeError(`${label} has an L2 magnitude that underflows Float64 (0): every coordinate is below ~2.2e-162, so its squares vanish and every cosine score would be Infinity, blaming healthy stored records. Normalize or scale the query first.`);
  }
  return vector;
}

// The write boundary (insert()/update()) enforces the same scoreability the query boundary does
// (idb-vector-1d3): a vector that cannot be scored must never reach the store, because every query
// that scans it rejects WHOLESALE through storedVectorError() - one write would make the whole
// store unqueryable, and insert() used to accept the same vector again, so the store could not
// even heal itself by re-inserting a repaired record. Overflow (any |coordinate| above ~1.34e154)
// is refused by vectorMagnitude(); the underflow case (every coordinate below ~2.2e-162 squares to
// 0, so the score would be dot / (norm * 0) = Infinity) needs its own refusal, exactly as
// assertScoreableQuery does for the query side. Runs before the transaction opens, so a refused
// write stores nothing.
function assertScoreableStoredVector(vector, label) {
  assertVector(vector, label);
  const magnitude = vectorMagnitude(vector, label);
  if (magnitude === 0) {
    throw new TypeError(`${label} has an L2 magnitude that underflows Float64 (0): every coordinate is below ~2.2e-162, so its squares vanish and every cosine score against it would be Infinity. Normalize or scale the vector before storing it.`);
  }
  return vector;
}

// A successful request can still be rolled back by its transaction.
function committed(transaction, request) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(request.result), { once: true });
    transaction.addEventListener("abort", () => reject(
      transaction.error ?? request.error ?? new DOMException("Transaction aborted", "AbortError")
    ), { once: true });
  });
}

async function create(options) {
  const { dbName, objectStore, vectorPath } = {
    ...DB_DEFAUlTS,
    ...options,
  };
  return new Promise((resolve, reject) => {
    // No explicit version: an existing application schema is opened AT ITS OWN VERSION and never
    // upgraded by this library. A database that does not exist yet is created at version 1, where
    // this store and index are added. Opening at version 1 would throw VersionError instead.
    const request = indexedDB.open(dbName);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const store = db.createObjectStore(objectStore, { autoIncrement: true });
      store.createIndex(vectorPath, vectorPath, { unique: false });
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      // A newer schema cannot be opened while this instance holds its connection.
      db.addEventListener("versionchange", () => db.close());
      if (db.objectStoreNames.contains(objectStore) === false) {
        const stores = Array.from(db.objectStoreNames);
        db.close();
        reject(new Error(`objectStore '${objectStore}' is not in database '${dbName}' (version ${db.version}; stores: ${stores.length ? stores.join(", ") : "none"}). This library never adds a store to an existing schema: create it in your own upgrade transaction, or use a fresh dbName.`));
        return;
      }
      resolve(db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

class VectorDB {
  #objectStore;
  #vectorPath;
  #db;
  #closed = false;

  constructor(options) {
    const { dbName, objectStore, vectorPath } = {
      ...DB_DEFAUlTS,
      ...options,
    };

    if (!dbName) {
      // Note only used in create()
      throw new Error("dbName is required");
    }

    if (!objectStore) {
      throw new Error("objectStore is required");
    }

    assertVectorPath(vectorPath);

    this.#objectStore = objectStore;
    this.#vectorPath = vectorPath;

    this.#db = create(options);
  }

  // Release this instance's connection, including when open() is still pending.
  async close() {
    this.#closed = true;
    (await this.#db).close();
  }

  async #connection() {
    if (this.#closed) throw new DOMException("VectorDB is closed", "InvalidStateError");
    const db = await this.#db;
    if (this.#closed) throw new DOMException("VectorDB is closed", "InvalidStateError");
    return db;
  }

  async insert(object, key) {

    if (!isRecord(object)) {
      throw new TypeError(`insert() expects a record object containing the vectorPath property '${this.#vectorPath}'; got ${describe(object)}`);
    }

    if (Object.hasOwn(object, this.#vectorPath) === false) {
      throw new TypeError(`insert() record has no '${this.#vectorPath}' property (vectorPath); add the vector before inserting`);
    }

    assertScoreableStoredVector(object[this.#vectorPath], `insert() '${this.#vectorPath}' vector`);

    const db = await this.#connection();
    const storeName = this.#objectStore;

    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);

    const request = key !== undefined ? store.add(object, key) : store.add(object);
    return committed(transaction, request);
  }

  async delete(key) {

    if (key == null) {
      throw new Error(`Unable to delete object without a key`)
    }

    const db = await this.#connection();
    const storeName = this.#objectStore;

    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);

    const request = store.delete(key);

    return committed(transaction, request);
  }

  async update(key, object) {

    if (key == null) {
      throw new Error(`Unable to update object without a key`)
    }

    if (!isRecord(object)) {
      throw new TypeError(`update() expects a record object containing the vectorPath property '${this.#vectorPath}'; got ${describe(object)}`);
    }

    if (Object.hasOwn(object, this.#vectorPath) === false) {
      throw new TypeError(`update() record has no '${this.#vectorPath}' property (vectorPath); add the vector before updating`);
    }

    assertScoreableStoredVector(object[this.#vectorPath], `update() '${this.#vectorPath}' vector`);

    const db = await this.#connection();
    const storeName = this.#objectStore;

    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);

    const request = updateRequest(store, key, object);

    return committed(transaction, request);
  }

  // Return the most similar items up to [limit] items (default 10), optionally above [threshold].
  async query(queryVector, options) {
    if (options !== undefined && options !== null && !isRecord(options)) {
      throw new TypeError(`query() options must be an object such as { limit: 10 }; got ${describe(options)}`);
    }

    // query() accepts an allow-list. Ignoring an unknown key is how a caller ends up believing they
    // filtered a query that never was: `query(vector, { predicate: fn })` would return an unfiltered
    // ranking that looks filtered.
    for (const key of Object.keys(options ?? {})) {
      if (QUERY_OPTION_KEYS.includes(key)) continue;
      const candidateHint = CANDIDATE_OPTION_KEYS.includes(key)
        ? " Use queryCandidates() to select candidates with an index, key range or predicate."
        : "";
      throw new TypeError(`query() option ${describe(key)} is not supported; query() options are ${QUERY_OPTION_KEYS.join(", ")}.${candidateHint}`);
    }

    const limit = assertLimit(options?.limit === undefined ? 10 : options.limit);
    const threshold = options?.threshold === undefined ? null : assertThreshold(options.threshold);

    assertScoreableQuery(queryVector, "query() vector");

    return (await this.#rank(queryVector, limit, NO_CANDIDATES, threshold)).results;
  }

  // Exact ranking over a candidate set the caller selects from THEIR schema, with disclosure of
  // what was read. See README.md, "Candidate queries".
  async queryCandidates(queryVector, options) {
    const { limit, threshold, candidates } = normalizeCandidateOptions(options);

    assertScoreableQuery(queryVector, "queryCandidates() vector");

    return this.#rank(queryVector, limit, candidates, threshold);
  }

  // `candidates` names the record source: `{ index: null, range: null, predicate: null }` is the
  // full exact scan that query() uses. Returns `{ results, info }`; query() drops `info`.
  async #rank(queryVector, limit, candidates, threshold) {
    const db = await this.#connection();
    const storeName = this.#objectStore;
    const vectorPath = this.#vectorPath;
    const queryVectorLength = queryVector.length;
    // Hoisted once per query instead of once per record: `cosineSimilarity` used to recompute the
    // query vector's norm for every record it scored. The per-record arithmetic and its
    // accumulation order are unchanged, so every score stays bit-identical.
    const queryMagnitude = vectorMagnitude(queryVector);

    const transaction = db.transaction([storeName], "readonly");
    const store = transaction.objectStore(storeName);
    const selection = selectCandidates(store, candidates, storeName);
    const source = selection.index === null ? store : store.index(selection.index);
    const request = source.openCursor(selection.range);

    const similarities = new SortedArray(limit, "similarity");
    const info = {
      mode: selection.mode,
      index: selection.index,
      range: selection.range === null ? null : {
        lower: selection.range.lower ?? null,
        upper: selection.range.upper ?? null,
        lowerOpen: selection.range.lowerOpen,
        upperOpen: selection.range.upperOpen,
      },
      predicate: selection.predicate !== null,
      threshold,
      // The promise, not the cost: true only when every record in the store was a candidate, so the
      // returned top-k is the exact global eligible top-k. `fullScanRequired` states whether the
      // spec forced that read; today the two are true under the same condition, and they are
      // separate fields because a future bounded source may be exhaustive on purpose (kuc.6).
      candidateSetComplete: selection.fullScanRequired === true,
      recordsRead: 0,
      recordsScored: 0,
      fullScanRequired: selection.fullScanRequired,
      reason: selection.reason,
      limit,
    };

    return new Promise((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor === null) {
          // sorted already.
          resolve({ results: similarities.slice(0, limit), info });
          return;
        }

        info.recordsRead += 1;
        // An index cursor's `key` is the index key; the record key is `primaryKey`.
        const key = selection.index === null ? cursor.key : cursor.primaryKey;
        const record = cursor.value;
        // A record with no vector at vectorPath is not part of the corpus; the same rule an
        // IndexedDB index applies to a missing key path. A record that HAS one must be valid:
        // skipping it silently is how invalid vectors used to poison the ranking.
        if (!isRecord(record) || Object.hasOwn(record, vectorPath) === false) {
          cursor.continue();
          return;
        }

        // Eligibility is decided BEFORE ranking, so a predicate cannot silently lose a match that
        // a later top-k truncation would have hidden.
        if (selection.predicate !== null) {
          let eligible;
          try {
            eligible = selection.predicate(record);
          } catch (error) {
            reject(new Error(`queryCandidates() predicate threw for key ${JSON.stringify(key)}: ${error.message}`));
            return;
          }
          if (!eligible) {
            cursor.continue();
            return;
          }
        }

        // Length is checked before scoring: `cosineSimilarity` iterates the query vector, so a
        // LONGER stored vector would otherwise be truncated silently instead of rejected.
        const vector = record[vectorPath];
        if (!Array.isArray(vector) || vector.length !== queryVectorLength) {
          reject(storedVectorError(vectorPath, key, vector, queryVectorLength));
          return;
        }

        // Measure the record here, once, for two reasons: cosineSimilarity needs the value anyway (it
        // is passed in below, so the arithmetic is the same reduce moved, not an extra pass), and a
        // record whose squared magnitude overflows Float64 - any |coordinate| above ~1.34e154 - would
        // otherwise be scored 0, because finite/Infinity = 0 is FINITE and slips past the check below
        // (idb-vector-cfr). Reject by key through storedVectorError(); never throw here.
        const recordMagnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        if (!Number.isFinite(recordMagnitude)) {
          reject(storedVectorError(vectorPath, key, vector, queryVectorLength));
          return;
        }
        const similarity = cosineSimilarity(queryVector, vector, queryMagnitude, recordMagnitude);
        if (!Number.isFinite(similarity)) {
          reject(storedVectorError(vectorPath, key, vector, queryVectorLength));
          return;
        }

        // Threshold before truncation: dropping low scores afterwards would leave fewer than `limit`
        // results while more eligible records existed.
        if (threshold !== null && similarity < threshold) {
          cursor.continue();
          return;
        }

        info.recordsScored += 1;
        similarities.insert({ object: record, key, similarity });
        cursor.continue();
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  // Explicitly stale until refresh(); default query() remains authoritative.
  async createSnapshot(options) {
    // The snapshot's own query() is a query entry point too, and both of its paths can mis-score an
    // unscoreable query: snapshot mode zero-scores every record silently, and live mode used to throw
    // inside the cursor callback (idb-vector-2yi). Hand it the same boundary validator query() uses so
    // there is one refusal and one message to maintain.
    return createPackedSnapshot(await this.#connection(), this.#objectStore, this.#vectorPath, options, cosineSimilarity, assertScoreableQuery);
  }

  // Opt-in int8 code side-store with bounded exact rerank (read-per-query path, ADR 0001).
  // Caller-owned, never default, never silently built.
  // Codes order candidates only; final scores come from an exact Float64 rerank of fetched originals.
  // Recommended for unfiltered non-resident workloads; selective filtered queries should use queryCandidates().
  async buildSideStore(options = {}) {
    assertSideStoreOptions("buildSideStore", options, SIDE_STORE_BUILD_OPTION_KEYS);
    const {
      sideStore = "codes",
      key = "code_record",
      epoch = null,
      getEpoch = null,
      revision = null,
    } = options;

    if (typeof getEpoch !== "function") {
      throw new TypeError(
        "buildSideStore() requires a trustworthy corpus-wide epoch mechanism (ADR 0001 Invariant 8). Pass { getEpoch: async (db) => epoch }."
      );
    }

    const db = await this.#connection();
    const sourceStoreName = this.#objectStore;
    const vectorPath = this.#vectorPath;

    const currentEpoch = await getEpoch(db);
    if (currentEpoch === undefined || currentEpoch === null) {
      throw new TypeError("getEpoch() must return a trustworthy non-null epoch (ADR 0001 Invariant 8)");
    }

    const targetEpoch = epoch ?? revision ?? currentEpoch;
    if (targetEpoch !== currentEpoch) {
      throw new Error(
        `Store-wide epoch mismatch on build: getEpoch returned ${currentEpoch}, expected ${targetEpoch} (ADR 0001 Invariant 7)`
      );
    }

    const records = [];
    const keys = [];
    const t0 = performance.now();

    await new Promise((resolve, reject) => {
      const tx = db.transaction([sourceStoreName], "readonly");
      const store = tx.objectStore(sourceStoreName);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (cursor.value && Object.hasOwn(cursor.value, vectorPath)) {
          records.push(cursor.value);
          keys.push(cursor.primaryKey); // Exact IndexedDB primary key (ADR 0001 Invariants 1-6)
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

    const codeRecord = buildCodeRecord(records, {
      epoch: targetEpoch,
      vectorPath,
      keys,
    });
    // The source cursor and side-store write use separate transactions. Refuse an
    // epoch change during the scan rather than publishing a mixed snapshot.
    if (await getEpoch(db) !== targetEpoch) {
      throw new Error("Store-wide epoch mismatch during side-store build");
    }

    await new Promise((resolve, reject) => {
      const tx = db.transaction([sideStore], "readwrite");
      const store = tx.objectStore(sideStore);
      store.put(codeRecord, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Side-store write aborted'));
    });

    const writeMs = performance.now() - t0;
    return {
      epoch: targetEpoch,
      revision: targetEpoch,
      count: codeRecord.count,
      dims: codeRecord.dims,
      bytes: codeRecord.bytes,
      writeMs,
    };
  }

  async querySideStore(queryVector, options = {}) {
    assertScoreableQuery(queryVector, "querySideStore() vector");
    assertSideStoreOptions("querySideStore", options, SIDE_STORE_QUERY_OPTION_KEYS);
    const {
      sideStore = "codes",
      key = "code_record",
      epoch = null,
      getEpoch = null,
      candidateBudget = 300,
      limit = 10,
      threshold = null,
      predicate = null,
      eligibleKeys = null,
      codeRecord: suppliedRecord = null,
      revision = null,
    } = options;

    // Invariant 9: Predicate Rejection — arbitrary record predicates are forbidden (ADR 0001 Invariant 9)
    if (predicate !== null && predicate !== undefined) {
      throw new TypeError(
        "querySideStore() does not support record predicates: arbitrary record predicates are forbidden in side-store queries to prevent late-filter truncation (ADR 0001 Invariant 9). Pre-filter candidate keys with eligibleKeys, or use queryCandidates({ predicate }) for exact scan filtering."
      );
    }

    const pinnedEpoch = epoch ?? revision;
    // Invariant 8: Store-wide Revision Pinning required
    if (pinnedEpoch === null || pinnedEpoch === undefined) {
      throw new TypeError("querySideStore() requires a pinned epoch/revision (ADR 0001 Invariant 8). Pass { epoch }.");
    }

    // Invariant 8: Corpus-wide epoch provider is mandatory
    if (typeof getEpoch !== "function") {
      throw new TypeError(
        "querySideStore() requires a trustworthy corpus-wide epoch mechanism (ADR 0001 Invariant 8). Pass { getEpoch: async (db) => epoch }."
      );
    }
    if (!Number.isSafeInteger(candidateBudget) || candidateBudget <= 0) {
      throw new RangeError(`candidateBudget must be a positive integer; got ${describe(candidateBudget)}`);
    }
    assertLimit(limit);
    // `threshold` is a scalar option like `limit`, not a field that documents null as "none":
    // omit it for no threshold. Read the CALLER's option, because the destructuring default above
    // already turned an omitted threshold into null. Accepting an explicit null here would silently
    // drop a threshold a caller computed as null by mistake (query() and queryCandidates() both
    // refuse it), and this read path must agree with them on what it accepts.
    if (options.threshold !== undefined) assertThreshold(threshold);

    const db = await this.#connection();
    const sourceStoreName = this.#objectStore;
    const vectorPath = this.#vectorPath;

    // 1. Read code record from side-store (unless supplied)
    let codeRecord = suppliedRecord;
    if (!codeRecord) {
      codeRecord = await new Promise((resolve, reject) => {
        const tx = db.transaction([sideStore], "readonly");
        const store = tx.objectStore(sideStore);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    if (!codeRecord) {
      throw new Error(`side-store record not found at key ${JSON.stringify(key)} in object store "${sideStore}"`);
    }

    // Invariant 8: Missing store-wide epoch on record is rejected
    if (codeRecord.epoch === undefined || codeRecord.epoch === null) {
      throw new Error("Side-store record lacks a trustworthy corpus-wide revision (ADR 0001 Invariant 8)");
    }

    // Invariant 7: Query pinned epoch must match side-store record epoch
    if (codeRecord.epoch !== pinnedEpoch) {
      throw new Error(
        `Store-wide epoch mismatch: query pinned epoch ${pinnedEpoch}, but side-store was built at epoch ${codeRecord.epoch} (ADR 0001 Invariant 7)`
      );
    }

    // Invariant 7: Verify store-wide epoch against current main store via mandatory getEpoch
    const storeEpoch = await getEpoch(db);
    if (storeEpoch === undefined || storeEpoch === null) {
      throw new TypeError("getEpoch() must return a trustworthy non-null epoch (ADR 0001 Invariant 8)");
    }
    if (storeEpoch !== codeRecord.epoch || storeEpoch !== pinnedEpoch) {
      throw new Error(
        `Store-wide epoch mismatch: main store epoch has advanced to ${storeEpoch}, but query pinned epoch is ${pinnedEpoch} and side-store epoch is ${codeRecord.epoch} (ADR 0001 Invariant 7)`
      );
    }

    // Invariants 10 & 11: Scan candidates with eligibleKeys pre-filtering before candidate budget
    const candidates = scanSideStore(codeRecord, queryVector, candidateBudget, eligibleKeys);
    const candidateKeys = candidates.map(c => c.key);

    // Invariant 12: Candidate Budget Bounds — fetch count never exceeds candidateBudget
    if (candidateKeys.length > candidateBudget) {
      throw new Error(`Candidate selection exceeded candidateBudget: ${candidateKeys.length} > ${candidateBudget}`);
    }

    // 4. Fetch the top-N originals BY EXACT PRIMARY KEY in ONE transaction
    const fetchedRecords = await new Promise((resolve, reject) => {
      const tx = db.transaction([sourceStoreName], "readonly");
      const store = tx.objectStore(sourceStoreName);
      const count = candidateKeys.length;
      if (count === 0) {
        resolve([]);
        return;
      }
      const results = new Array(count);
      let settled = 0;
      for (let i = 0; i < count; i++) {
        const req = store.get(candidateKeys[i]);
        req.onsuccess = () => {
          results[i] = req.result;
          settled++;
          if (settled === count) resolve(results);
        };
        req.onerror = () => reject(req.error);
      }
    });

    // The epoch read and candidate fetch use separate transactions. Recheck after
    // the fetch so a mutation between them cannot silently return stale results.
    if (await getEpoch(db) !== pinnedEpoch) {
      throw new Error("Store-wide epoch mismatch during side-store query");
    }

    // 5. Exact Float64 rerank of fetched originals
    // Enforces 0 dead rows and preserves exact IndexedDB primary keys (ADR 0001 Invariants 1-6)
    const results = rerankCandidates(
      fetchedRecords,
      vectorPath,
      queryVector,
      limit,
      threshold,
      candidateKeys,
    );

    const info = {
      mode: "side-store",
      epoch: codeRecord.epoch,
      revision: codeRecord.epoch,
      candidateBudget,
      recordsRead: codeRecord.count,
      candidatesScored: candidates.length,
      recordsFetched: fetchedRecords.length,
      limit,
      threshold,
    };

    return { results, info };
  }

  async createSideStore(options = {}) {
    assertSideStoreOptions("createSideStore", options, SIDE_STORE_FACTORY_OPTION_KEYS);
    const {
      sideStore = "codes",
      key = "code_record",
      epoch = options.revision ?? null,
      candidateBudget = 300,
      getEpoch = null,
    } = options;

    return {
      build: (buildOpts) => this.buildSideStore({ sideStore, key, epoch, getEpoch, ...buildOpts }),
      query: (queryVector, queryOpts) => this.querySideStore(queryVector, { sideStore, key, epoch, getEpoch, candidateBudget, ...queryOpts }),
    };
  }

  get objectStore() {
    // Escape hatch.
    return this.#objectStore;
  }
}

export { VectorDB };
