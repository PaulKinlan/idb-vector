const DB_DEFAUlTS = {
  dbName: 'vectorDB',
  objectStore: 'vectors'
};

async function create(options = DB_DEFAUlTS) {
  const { dbName, objectStore } = options;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      db.createObjectStore(objectStore, { keyPath: 'id', autoIncrement: true });
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

async function insert(vector, options = DB_DEFAUlTS) {
  const { dbName, objectStore } = options;
  const db = await create(options);
  const transaction = db.transaction([objectStore], 'readwrite');
  const objectStore = transaction.objectStore('vectors');
  objectStore.add({ vector });
}

// Return the most similar items.
async function query(queryVector, limit = 10, options = DB_DEFAUlTS) {
  const { dbName, objectStore } = options;
  
  const db = await create(options);
  const transaction = db.transaction([objectStore], 'readonly');
  const objectStore = transaction.objectStore(objectStore);
  const request = objectStore.openCursor();

  const similarities = new SortedArray(limit);

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const similarity = cosineSimilarity(queryVector, cursor.value.vector);
        similarities.push({ id: cursor.value.id, similarity });
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
  
  #maxLength

  constructor(maxLength = 0) {
    super();
    this.#maxLength = maxLength;
    
  }
  push() {
    throw new Error("Can't push on to a sorted array")
  }

  insert(value) {
    console.log(`Adding ${value}`);
    const array = this;
    const maxLength = this.#maxLength;
    const halfMaxLength = maxLength / 2;
    let low = 0,
      high = (array == null) ? low : array.length;
    
    if (typeof value == 'number') {
      while (low < high) {
        let mid = (low + high) >>> 1;
        let computed = array[mid];
        
        if (computed !== null & (computed <= value)) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }
      
      if (this.length == maxLength) {
        this.pop(); // Remove the last entry to make way for the new one
      }
      
      this.splice(high, 0, value)
    }
  }
}

export { insert, query, create }
