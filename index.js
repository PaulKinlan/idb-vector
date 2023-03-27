const DB_DEFAUlTS = {
  dbName: "vectorDB",
  objectStore: "vectors",
};

async function create(vectorPath, options = DB_DEFAUlTS) {
  const { dbName, objectStore } = options;
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

function cosineSimilarity(a, b) {
  const dotProduct = a.reduce((sum, aVal, idx) => sum + aVal * b[idx], 0);
  const aMagnitude = Math.sqrt(a.reduce((sum, aVal) => sum + aVal * aVal, 0));
  const bMagnitude = Math.sqrt(b.reduce((sum, bVal) => sum + bVal * bVal, 0));
  return dotProduct / (aMagnitude * bMagnitude);
}

async function insert(object, vectorPath, options = DB_DEFAUlTS) {
  const { dbName, objectStore: objectStoreName } = options;
  const db = await create(vectorPath, options);
  const transaction = db.transaction([objectStoreName], "readwrite");
  const objectStore = transaction.objectStore(objectStoreName);
  objectStore.add(object);
}

// Return the most similar items.
async function query(
  queryVector,
  vectorPath,
  limit = 10,
  options = DB_DEFAUlTS
) {
  const { dbName, objectStore: objectStoreName } = options;

  const db = await create(vectorPath, options);
  const transaction = db.transaction([objectStoreName], "readonly");
  const objectStore = transaction.objectStore(objectStoreName);
  const request = objectStore.openCursor();

  const similarities = new SortedArray(limit, "similarity");

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const similarity = cosineSimilarity(
          queryVector,
          cursor.value[vectorPath]
        );
        similarities.insert({ object: cursor.value, similarity });
        cursor.continue();
      } else {
        // sorted already.
        resolve(similarities.slice(0, limit));
      }
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

// Nabbed from lodash
/**
 * The base implementation of `_.sortedIndex` and `_.sortedLastIndex` which
 * performs a binary search of `array` to determine the index at which `value`
 * should be inserted into `array` in order to maintain its sort order.
 *
 * @private
 * @param {Array} array The sorted array to inspect.
 * @param {*} value The value to evaluate.
 * @param {boolean} [retHighest] Specify returning the highest qualified index.
 * @returns {number} Returns the index at which `value` should be inserted
 *  into `array`.
 */

class SortedArray extends Array {
  #maxLength;
  #keyPath;

  constructor(maxLength = 0, keyPath) {
    super();
    this.#maxLength = maxLength;
    this.#keyPath = keyPath;
  }
  
  push() {
    throw new Error("Can't push on to a sorted array");
  }

  unshift() {
    throw new Error("Can't unshift on to a sorted array");
  }

  insert(value) {
    const array = this;
    const maxLength = this.#maxLength;
    let low = 0,
      high = array == null ? low : array.length;

    const accessor =
      typeof value == "object"
        ? (array, mid) => array[mid][this.#keyPath]
        : (array, mid) => array[mid];
    const resolvedValue =
      typeof value == "object" ? value[this.#keyPath] : value;

    while (low < high) {
      let mid = (low + high) >>> 1;
      let computed = accessor(array, mid);

      if ((computed !== null) & (computed >= resolvedValue)) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.splice(high, 0, value);

    if (this.length > maxLength) {
      this.pop(); // Remove the last entry to make way for the new one
    }
  }
}

export { insert, query, create };
