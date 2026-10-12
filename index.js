import { SortedArray } from "./utils/sortedarray.js";
import { createPackedSnapshot } from "./utils/packed-snapshot.js";
export { diagnose, fitWhitening } from "./utils/geometry.js";

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

// A paged read holds at most this many records at once, so it must be a positive integer for the
// memory bound it advertises to be real. `null` means the cursor path.
function assertPageSize(pageSize) {
  if (pageSize === null) {
    return null;
  }
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new RangeError(`pageSize must be a positive integer; got ${describe(pageSize)}`);
  }
  return pageSize;
}

// --- candidate selection -----------------------------------------------------------------------
// `query()` ranks every record. `queryCandidates()` ranks a candidate set chosen by the CALLER's
// own IndexedDB schema (an index name and/or an IDBKeyRange) plus an optional JS predicate. The
// library never creates, migrates or upgrades that schema: a missing index is an error that names
// the available indexes, never a silent full scan. A candidate spec that cannot narrow the read
// discloses `fullScanRequired`, because "fewer results than asked" must not be read as "no more
// matches" when the corpus was restricted.
const CANDIDATE_OPTION_KEYS = ["limit", "threshold", "index", "range", "predicate", "pageSize"];
const QUERY_OPTION_KEYS = ["limit", "threshold", "pageSize"];
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
  const { limit = 10, threshold = null, index = null, range = null, predicate = null, pageSize = null } = options;
  assertLimit(limit);
  // `threshold` is a scalar option like `limit`, not one of the candidate spec fields that document
  // null as "none": omit it for no threshold. Accepting null here would silently drop a threshold
  // that a caller computed as null by mistake (query() already refuses it), and the two entry points
  // must agree on what they accept.
  if (options.threshold !== undefined) assertThreshold(threshold);
  assertPageSize(pageSize);
  if (index !== null && (typeof index !== "string" || index.length === 0)) {
    throw new TypeError(`queryCandidates() index must be a non-empty string naming one index on the object store; got ${describe(index)}`);
  }
  if (range !== null && range instanceof IDBKeyRange === false) {
    throw new TypeError(`queryCandidates() range must be an IDBKeyRange built with IDBKeyRange.only/bound/lowerBound/upperBound; got ${describe(range)}`);
  }
  if (predicate !== null && typeof predicate !== "function") {
    throw new TypeError(`queryCandidates() predicate must be a function of one record returning a boolean; got ${describe(predicate)}`);
  }
  return { limit, threshold, pageSize, candidates: { index, range, predicate } };
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

function cosineSimilarity(a, b, aMagnitude) {
  const dotProduct = a.reduce((sum, aVal, idx) => sum + aVal * b[idx], 0);
  // `aMagnitude` is the query vector's norm, which ranking hoists out of its per-record loop:
  // recomputing it for every record is pure waste (100k records x 128 dims is millions of
  // redundant operations) and the value is identical, so scores stay bit-identical. Callers that
  // do not pass it (the packed-snapshot fallback) get the same value computed here.
  const magnitude = aMagnitude === undefined ? vectorMagnitude(a) : aMagnitude;
  const bMagnitude = Math.sqrt(b.reduce((sum, bVal) => sum + bVal * bVal, 0));
  return dotProduct / (magnitude * bMagnitude);
}

function vectorMagnitude(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

// A read request whose own result is all that matters; the paged read issues these two at a time
// inside one transaction, so they share its snapshot.
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

  async insert(object) {

    if (!isRecord(object)) {
      throw new TypeError(`insert() expects a record object containing the vectorPath property '${this.#vectorPath}'; got ${describe(object)}`);
    }

    if (Object.hasOwn(object, this.#vectorPath) === false) {
      throw new TypeError(`insert() record has no '${this.#vectorPath}' property (vectorPath); add the vector before inserting`);
    }

    assertVector(object[this.#vectorPath], `insert() '${this.#vectorPath}' vector`);

    const db = await this.#connection();
    const storeName = this.#objectStore;

    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);

    const request = store.add(object);
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

    assertVector(object[this.#vectorPath], `update() '${this.#vectorPath}' vector`);

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
      throw new TypeError(`query() option ${describe(key)} is not supported; query() options are ${QUERY_OPTION_KEYS.join(" and ")}.${candidateHint}`);
    }

    const limit = assertLimit(options?.limit === undefined ? 10 : options.limit);
    const threshold = options?.threshold === undefined ? null : assertThreshold(options.threshold);
    const pageSize = assertPageSize(options?.pageSize === undefined ? null : options.pageSize);

    assertVector(queryVector, "query() vector");

    return (await this.#rank(queryVector, limit, NO_CANDIDATES, threshold, pageSize)).results;
  }

  // Exact ranking over a candidate set the caller selects from THEIR schema, with disclosure of
  // what was read. See README.md, "Candidate queries".
  async queryCandidates(queryVector, options) {
    const { limit, threshold, pageSize, candidates } = normalizeCandidateOptions(options);

    assertVector(queryVector, "queryCandidates() vector");

    return this.#rank(queryVector, limit, candidates, threshold, pageSize);
  }

  // `candidates` names the record source: `{ index: null, range: null, predicate: null }` is the
  // full exact scan that query() uses. Returns `{ results, info }`; query() drops `info`.
  async #rank(queryVector, limit, candidates, threshold, pageSize) {
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

    // A paged read resumes from the last key it read, which is exact only when keys are unique. An
    // index can repeat one key across records, and a key range would have to be intersected with
    // every page bound, so both keep the cursor path rather than risk skipping a record.
    if (pageSize !== null && selection.mode !== "full-scan") {
      throw new TypeError(`pageSize cannot be combined with an index or a key range (mode ${selection.mode}): a paged read resumes from the last key it read, which is exact only for a whole-store scan, where every key is unique. Omit pageSize to use the cursor path.`);
    }

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
      readMode: pageSize === null ? "cursor" : "paged",
      pageSize,
      recordsRead: 0,
      recordsScored: 0,
      fullScanRequired: selection.fullScanRequired,
      reason: selection.reason,
      limit,
    };

    // ONE implementation of the per-record rules for BOTH read strategies, so a paged read cannot
    // drift from the cursor read: a record with no vector at vectorPath is not part of the corpus
    // (the rule an IndexedDB index applies to a missing key path), a record that HAS one must be
    // valid, and eligibility is decided BEFORE ranking so a predicate cannot silently lose a match
    // that a later top-k truncation would have hidden.
    const consider = (key, record) => {
      info.recordsRead += 1;
      if (!isRecord(record) || Object.hasOwn(record, vectorPath) === false) {
        return;
      }

      if (selection.predicate !== null) {
        let eligible;
        try {
          eligible = selection.predicate(record);
        } catch (error) {
          throw new Error(`queryCandidates() predicate threw for key ${JSON.stringify(key)}: ${error.message}`);
        }
        if (!eligible) {
          return;
        }
      }

      // Length is checked before scoring: `cosineSimilarity` iterates the query vector, so a
      // LONGER stored vector would otherwise be truncated silently instead of rejected.
      const vector = record[vectorPath];
      if (!Array.isArray(vector) || vector.length !== queryVectorLength) {
        throw storedVectorError(vectorPath, key, vector, queryVectorLength);
      }

      const similarity = cosineSimilarity(queryVector, vector, queryMagnitude);
      if (!Number.isFinite(similarity)) {
        throw storedVectorError(vectorPath, key, vector, queryVectorLength);
      }

      // Threshold BEFORE truncation: dropping low scores afterwards would leave fewer than `limit`
      // results while more eligible records existed. It is applied here, in the one place both read
      // strategies share, so a paged read cannot bypass it.
      if (threshold !== null && similarity < threshold) {
        return;
      }

      info.recordsScored += 1;
      similarities.insert({ object: record, key, similarity });
    };

    if (pageSize === null) {
      return new Promise((resolve, reject) => {
        const source = selection.index === null ? store : store.index(selection.index);
        const request = source.openCursor(selection.range);

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor === null) {
            // sorted already.
            resolve({ results: similarities.slice(0, limit), info });
            return;
          }

          // An index cursor's `key` is the index key; the record key is `primaryKey`.
          const key = selection.index === null ? cursor.key : cursor.primaryKey;
          try {
            consider(key, cursor.value);
          } catch (error) {
            reject(error);
            return;
          }
          cursor.continue();
        };

        request.onerror = (event) => {
          reject(event.target.error);
        };
      });
    }

    // Paged read: every page runs in the ONE transaction opened above, so the whole query sees a
    // single snapshot and a writer on another connection cannot tear the scan (the prototype this
    // came from opened a transaction per page). It resumes from the last key it read with an
    // exclusive lower bound, which is valid for numbers, strings, dates and array keys alike,
    // rather than assuming numeric keys can be incremented. At most `pageSize` records are held at
    // one time.
    let resume = null;
    for (;;) {
      const range = resume === null ? null : IDBKeyRange.lowerBound(resume, true);
      const [keys, records] = await Promise.all([
        requestResult(store.getAllKeys(range, pageSize)),
        requestResult(store.getAll(range, pageSize)),
      ]);
      if (records.length !== keys.length) {
        throw new Error(`paged read read ${keys.length} keys and ${records.length} records in one transaction; refusing to rank a torn page`);
      }
      if (keys.length === 0) {
        break;
      }
      for (let index = 0; index < keys.length; index += 1) {
        consider(keys[index], records[index]);
      }
      if (keys.length < pageSize) {
        break;
      }
      resume = keys[keys.length - 1];
    }

    return { results: similarities.slice(0, limit), info };
  }

  // Explicitly stale until refresh(); default query() remains authoritative.
  async createSnapshot(options) {
    return createPackedSnapshot(await this.#connection(), this.#objectStore, this.#vectorPath, options, cosineSimilarity);
  }

  get objectStore() {
    // Escape hatch.
    return this.#objectStore;
  }
}

export { VectorDB };
