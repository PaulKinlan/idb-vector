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
      db.createObjectStore(objectStore, { autoIncrement: true });
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
  const db = await create(options);
  const transaction = db.transaction([objectStore], 'readwrite');
  const objectStore = transaction.objectStore('vectors');
  objectStore.add({ vector });
}

async function query(queryVector, k, options = DB_DEFAUlTS) {
  const db = await create(options);
  const transaction = db.transaction([objectStore], 'readonly');
  const objectStore = transaction.objectStore(objectStore);
  const request = objectStore.openCursor();
  const similarities = [];

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const similarity = cosineSimilarity(queryVector, cursor.value.vector);
        similarities.push({ id: cursor.value.id, similarity });
        cursor.continue();
      } else {
        similarities.sort((a, b) => b.similarity - a.similarity);
        resolve(similarities.slice(0, k));
      }
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

export { insert, query, create }
