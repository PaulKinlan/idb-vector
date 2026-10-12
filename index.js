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

function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, aVal, idx) => sum + aVal * b[idx], 0);
  const aMagnitude = Math.sqrt(a.reduce((sum, aVal) => sum + aVal * aVal, 0));
  const bMagnitude = Math.sqrt(b.reduce((sum, bVal) => sum + bVal * bVal, 0));
  return dotProduct / (aMagnitude * bMagnitude);
}

// A successful request can still be rolled back by its transaction.
function committed(transaction, request) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted"));
  });
}

async function create(options) {
  const { dbName, objectStore, vectorPath } = {
    ...DB_DEFAUlTS,
    ...options,
  };
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const store = db.createObjectStore(objectStore, { autoIncrement: true });
      store.createIndex(vectorPath, vectorPath, { unique: false });
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
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

  async insert(object) {

    if (!isRecord(object)) {
      throw new TypeError(`insert() expects a record object containing the vectorPath property '${this.#vectorPath}'; got ${describe(object)}`);
    }

    if (Object.hasOwn(object, this.#vectorPath) === false) {
      throw new TypeError(`insert() record has no '${this.#vectorPath}' property (vectorPath); add the vector before inserting`);
    }

    assertVector(object[this.#vectorPath], `insert() '${this.#vectorPath}' vector`);

    const db = await this.#db;
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

    const db = await this.#db;
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

    const db = await this.#db;
    const storeName = this.#objectStore;

    const transaction = db.transaction([storeName], "readwrite");
    const store = transaction.objectStore(storeName);

    const request = store.put(object, key);

    return committed(transaction, request);
  }

  // Return the most similar items up to [limit] items (default 10).
  async query(queryVector, options) {
    if (options !== undefined && options !== null && !isRecord(options)) {
      throw new TypeError(`query() options must be an object such as { limit: 10 }; got ${describe(options)}`);
    }

    const limit = assertLimit(options?.limit === undefined ? 10 : options.limit);

    assertVector(queryVector, "query() vector");

    const queryVectorLength = queryVector.length;

    const db = await this.#db;
    const storeName = this.#objectStore;
    const vectorPath = this.#vectorPath;

    const transaction = db.transaction([storeName], "readonly");
    const objectStore = transaction.objectStore(storeName);
    const request = objectStore.openCursor();

    const similarities = new SortedArray(limit, "similarity");

    return new Promise((resolve, reject) => {
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor === null) {
          // sorted already.
          resolve(similarities.slice(0, limit));
          return;
        }

        const record = cursor.value;
        // A record with no vector at vectorPath is not part of the corpus; the same rule an
        // IndexedDB index applies to a missing key path. A record that HAS one must be valid:
        // skipping it silently is how invalid vectors used to poison the ranking.
        if (!isRecord(record) || Object.hasOwn(record, vectorPath) === false) {
          cursor.continue();
          return;
        }

        // Length is checked before scoring: `cosineSimilarity` iterates the query vector, so a
        // LONGER stored vector would otherwise be truncated silently instead of rejected.
        const vector = record[vectorPath];
        if (!Array.isArray(vector) || vector.length !== queryVectorLength) {
          reject(storedVectorError(vectorPath, cursor.key, vector, queryVectorLength));
          return;
        }

        const similarity = cosineSimilarity(queryVector, vector);
        if (!Number.isFinite(similarity)) {
          reject(storedVectorError(vectorPath, cursor.key, vector, queryVectorLength));
          return;
        }

        similarities.insert({ object: record, key: cursor.key, similarity });
        cursor.continue();
      };

      request.onerror = (event) => {
        reject(event.target.error);
      };
    });
  }

  // Explicitly stale until refresh(); default query() remains authoritative.
  async createSnapshot(options) {
    return createPackedSnapshot(await this.#db, this.#objectStore, this.#vectorPath, options, cosineSimilarity);
  }

  get objectStore() {
    // Escape hatch.
    return this.#objectStore;
  }
}

export { VectorDB };
