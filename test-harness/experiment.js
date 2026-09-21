import { VectorDB } from '../index.js';
import { SortedArray } from '../utils/sortedarray.js';

// Seeded synthetic numeric vectors, not text embeddings or a semantic-search claim.
export function vector(id, dimensions) {
  let state = (id + 1) >>> 0;
  return Array.from({ length: dimensions }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  });
}

export async function dataset(count, dimensions) {
  const name = `idb-vector-demo-${crypto.randomUUID()}`;
  const library = new VectorDB({ dbName: name, vectorPath: 'embedding' });
  const start = performance.now();
  for (let id = 0; id < count; id++) {
    await library.insert({ id, category: id % 100, embedding: vector(id, dimensions) });
  }
  // Open another connection to the SAME store; the library has no connection escape hatch.
  const raw = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // Barrier: wait for all previous insert transactions to finish before querying.
  await new Promise((resolve, reject) => {
    const tx = raw.transaction('vectors');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
  });
  const seedMs = performance.now() - start;
  const indexStart = performance.now();
  // An independent candidate store avoids changing the library's version-1 schema.
  const indexed = await new Promise((resolve, reject) => {
    const request = indexedDB.open(`${name}-candidate`, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('vectors', { autoIncrement: true });
      store.createIndex('category', 'category');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  // Same vectors and keys, bounded batches. This is not a bulk-insert library benchmark.
  for (let offset = 0; offset < count; offset += 1000) {
    await new Promise((resolve, reject) => {
      const tx = indexed.transaction('vectors', 'readwrite');
      for (let id = offset; id < Math.min(count, offset + 1000); id++) {
        tx.objectStore('vectors').add({ id, category: id % 100, embedding: vector(id, dimensions) });
      }
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  }
  return { library, raw, indexed, name, count, dimensions, seedMs,
    candidateSeedMs: performance.now() - indexStart };
}

function cosine(a, b, aNorm) {
  let dot = 0, norm = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; norm += b[i] * b[i]; }
  return dot / (aNorm * Math.sqrt(norm));
}

// Experimental exact alternative: bounded getAll pages, hoisted query norm, optional
// native index or JS predicate BEFORE top-k. Not exported by the library.
export async function batched(db, query, { category = null, index = false, limit = 10 } = {}) {
  const top = new SortedArray(limit, 'similarity');
  const norm = Math.sqrt(query.reduce((sum, x) => sum + x * x, 0));
  let after = null, visited = 0;
  while (true) {
    const rows = await new Promise((resolve, reject) => {
      const store = db.transaction('vectors').objectStore('vectors');
      const source = index ? store.index('category') : store;
      // Category range fits one batch for the measured <=100k, 100-partition fixture.
      const range = index ? IDBKeyRange.only(category) : after === null ? null : IDBKeyRange.lowerBound(after, true);
      const request = source.getAll(range, index ? undefined : 1000);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    visited += rows.length;
    for (const row of rows) {
      if (category !== null && row.category !== category) continue;
      top.insert({ object: row, key: row.id + 1, similarity: cosine(query, row.embedding, norm) });
    }
    if (index || rows.length < 1000) break;
    after = rows.at(-1).id + 1;
  }
  return { results: Array.from(top), visited };
}

export async function timed(fn) {
  const start = performance.now();
  const result = await fn();
  return { ms: performance.now() - start, result };
}

export function sameKeys(a, b) {
  return a.map(x => x.key).join(',') === b.map(x => x.key).join(',');
}

export async function measure(data, repetitions = 3) {
  const query = vector(42, data.dimensions);
  const runs = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    // Rotate order to avoid always favouring the warm candidate.
    const methods = {
      baseline: () => data.library.query(query, { limit: 10 }),
      batch: () => batched(data.raw, query),
      filteredScan: () => batched(data.indexed, query, { category: 7 }),
      filteredIndex: () => batched(data.indexed, query, { category: 7, index: true }),
    };
    const names = Object.keys(methods);
    const run = {};
    for (let j = 0; j < names.length; j++) {
      const name = names[(j + repetition) % names.length];
      run[name] = await timed(methods[name]);
    }
    if (!sameKeys(run.baseline.result, run.batch.result.results)) throw new Error('Exact batch top-k differs');
    if (!sameKeys(run.filteredScan.result.results, run.filteredIndex.result.results)) throw new Error('Index top-k differs');
    const late = run.baseline.result.filter(x => x.object.category === 7);
    const truth = run.filteredScan.result.results;
    runs.push({ repetition, baselineMs: run.baseline.ms, batchMs: run.batch.ms,
      filteredScanMs: run.filteredScan.ms, filteredIndexMs: run.filteredIndex.ms,
      visitedScan: run.filteredScan.result.visited, visitedIndex: run.filteredIndex.result.visited,
      exactKeysMatch: true, filteredKeysMatch: true, lateFilterCount: late.length,
      eligibleCount: truth.length, lateFilterRecall: late.filter(x => truth.some(y => y.key === x.key)).length / truth.length,
      topKeys: run.baseline.result.map(x => x.key), eligibleKeys: truth.map(x => x.key) });
  }
  return { count: data.count, dimensions: data.dimensions, k: 10, seedMs: data.seedMs,
    candidateSeedMs: data.candidateSeedMs, runs };
}

export function discard(data) {
  data.raw.close();
  data.indexed.close();
  // Library connection cannot be closed: deletion waits until page/browser closure.
  indexedDB.deleteDatabase(data.name);
  indexedDB.deleteDatabase(`${data.name}-candidate`);
}
