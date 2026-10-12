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

// --- candidate selection -----------------------------------------------------------------------
// `query()` ranks every record. `queryCandidates()` ranks a candidate set chosen by the CALLER's
// own IndexedDB schema (an index name and/or an IDBKeyRange) plus an optional JS predicate. The
// library never creates, migrates or upgrades that schema: a missing index is an error that names
// the available indexes, never a silent full scan. A candidate spec that cannot narrow the read
// discloses `fullScanRequired`, because "fewer results than asked" must not be read as "no more
// matches" when the corpus was restricted.
const CANDIDATE_OPTION_KEYS = ["limit", "index", "range", "predicate"];
const NO_CANDIDATES = { index: null, range: null, predicate: null };

function normalizeCandidateOptions(options) {
  if (options === undefined || options === null) return { limit: 10, candidates: { ...NO_CANDIDATES } };
  if (!isRecord(options)) {
    throw new TypeError(`queryCandidates() options must be an object such as { index: "category", range: IDBKeyRange.only(7) }; got ${describe(options)}`);
  }
  for (const key of Object.keys(options)) {
    if (CANDIDATE_OPTION_KEYS.includes(key) === false) {
      throw new TypeError(`queryCandidates() option ${describe(key)} is not supported; supported options are ${CANDIDATE_OPTION_KEYS.join(", ")}`);
    }
  }
  const { limit = 10, index = null, range = null, predicate = null } = options;
  assertLimit(limit);
  if (index !== null && (typeof index !== "string" || index.length === 0)) {
    throw new TypeError(`queryCandidates() index must be a non-empty string naming one index on the object store; got ${describe(index)}`);
  }
  if (range !== null && range instanceof IDBKeyRange === false) {
    throw new TypeError(`queryCandidates() range must be an IDBKeyRange built with IDBKeyRange.only/bound/lowerBound/upperBound; got ${describe(range)}`);
  }
  if (predicate !== null && typeof predicate !== "function") {
    throw new TypeError(`queryCandidates() predicate must be a function of one record returning a boolean; got ${describe(predicate)}`);
  }
  return { limit, candidates: { index, range, predicate } };
}

// Resolves a candidate spec against the caller's store. The store-dependent check lives here
// because index names can only be read from a store handle.
function selectCandidates(store, { index, range, predicate }, storeName) {
  if (index !== null && store.indexNames.contains(index) === false) {
    const available = Array.from(store.indexNames);
    throw new TypeError(`queryCandidates() index ${describe(index)} is not on object store '${storeName}'; available indexes: ${available.length ? available.join(", ") : "none"}. Create it in your own upgrade transaction: this library never migrates an application schema.`);
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

function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, aVal, idx) => sum + aVal * b[idx], 0);
  const aMagnitude = Math.sqrt(a.reduce((sum, aVal) => sum + aVal * aVal, 0));
  const bMagnitude = Math.sqrt(b.reduce((sum, bVal) => sum + bVal * bVal, 0));
  return dotProduct / (aMagnitude * bMagnitude);
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

  // Return the most similar items up to [limit] items (default 10).
  async query(queryVector, options) {
    if (options !== undefined && options !== null && !isRecord(options)) {
      throw new TypeError(`query() options must be an object such as { limit: 10 }; got ${describe(options)}`);
    }

    const limit = assertLimit(options?.limit === undefined ? 10 : options.limit);

    assertVector(queryVector, "query() vector");

    return (await this.#rank(queryVector, limit, NO_CANDIDATES)).results;
  }

  // Exact ranking over a candidate set the caller selects from THEIR schema, with disclosure of
  // what was read. See README.md, "Candidate queries".
  async queryCandidates(queryVector, options) {
    const { limit, candidates } = normalizeCandidateOptions(options);

    assertVector(queryVector, "queryCandidates() vector");

    return this.#rank(queryVector, limit, candidates);
  }

  // `candidates` names the record source: `{ index: null, range: null, predicate: null }` is the
  // full exact scan that query() uses. Returns `{ results, info }`; query() drops `info`.
  async #rank(queryVector, limit, candidates) {
    const db = await this.#connection();
    const storeName = this.#objectStore;
    const vectorPath = this.#vectorPath;
    const queryVectorLength = queryVector.length;

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

        const similarity = cosineSimilarity(queryVector, vector);
        if (!Number.isFinite(similarity)) {
          reject(storedVectorError(vectorPath, key, vector, queryVectorLength));
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
    return createPackedSnapshot(await this.#connection(), this.#objectStore, this.#vectorPath, options, cosineSimilarity);
  }

  get objectStore() {
    // Escape hatch.
    return this.#objectStore;
  }
}

export { VectorDB };
