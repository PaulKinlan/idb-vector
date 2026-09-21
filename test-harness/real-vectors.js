import { VectorDB } from '../index.js';
import { SortedArray } from '../utils/sortedarray.js';

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const complete = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onerror = tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});
function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return dot / Math.sqrt(aa * bb);
}
export function recall(ids, expected) {
  if (ids.length !== 10 || new Set(ids).size !== 10) throw new Error('Expected 10 unique returned IDs');
  const targets = new Set(expected);
  return ids.filter(id => targets.has(id)).length / 10;
}
export function assertExact(ids, truth) {
  const value = recall(ids, truth.acceptableIds);
  if (value !== 1) throw new Error(`Exact recall failed: ${value}; got ${ids}, expected ${truth.ids}`);
}
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

export async function run(name, method, status) {
  const base = `/data/${name}/`;
  const manifest = await (await fetch(base + 'manifest.json')).json();
  const [vectorBuffer, cellBuffer] = await Promise.all(['vectors.f32', 'cells.u32'].map(async file => {
    const response = await fetch(base + file);
    if (!response.ok) throw new Error(`Dataset fetch failed: ${file}`);
    const buffer = await response.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (digest !== manifest.files[file].sha256) throw new Error(`Dataset checksum mismatch: ${file}`);
    return buffer;
  }));
  const vectors = new Float32Array(vectorBuffer), cells = new Uint32Array(cellBuffer);
  const { count, dimensions, queries } = manifest;
  if (vectors.length !== count * dimensions || cells.length !== count) throw new Error('Dataset shape mismatch');
  const dbName = `real-vector-${method}`;
  let library, db;
  const buildStart = performance.now();
  if (method === 'library') {
    library = new VectorDB({ dbName, vectorPath: 'embedding' });
    // Opening queues behind the library's own initial open and schema creation.
    db = await request(indexedDB.open(dbName));
  } else {
    const opening = indexedDB.open(dbName, 1);
    opening.onupgradeneeded = () => {
      const store = opening.result.createObjectStore('vectors', { autoIncrement: true });
      store.createIndex('cell', 'cell');
      opening.result.createObjectStore('centroids');
    };
    db = await request(opening);
  }
  // Equal 1000-row native-IDB bulk load for both schemas, not VectorDB.insert timing.
  for (let start = 0; start < count; start += 1000) {
    const tx = db.transaction('vectors', 'readwrite'), done = complete(tx);
    const store = tx.objectStore('vectors');
    for (let id = start; id < Math.min(count, start + 1000); id++) {
      store.add({ id, embedding: Array.from(vectors.subarray(id * dimensions, (id + 1) * dimensions)),
        ...(method === 'ivf' ? { cell: cells[id] } : {}) });
    }
    await done;
  }
  if (method === 'ivf') {
    const tx = db.transaction('centroids', 'readwrite'), done = complete(tx);
    tx.objectStore('centroids').put(manifest.ivf.centroids, 'centroids');
    await done;
  }
  const buildMs = performance.now() - buildStart;
  status(`Built ${method}: ${count.toLocaleString()} real vectors × ${dimensions}D in ${buildMs.toFixed(0)} ms. Querying…`);
  const measurements = [];
  const centroidLoadStart = performance.now();
  const centroids = method === 'ivf' ? await request(db.transaction('centroids').objectStore('centroids').get('centroids')) : null;
  const centroidLoadMs = method === 'ivf' ? performance.now() - centroidLoadStart : 0;
  async function search(query, nprobe) {
    if (method === 'library') {
      const rows = await library.query(query, { limit: 10 });
      return { ids: rows.map(row => row.object.id), scores: rows.map(row => row.similarity), visited: count };
    }
    const chosen = centroids.map((c, id) => ({ id, score: cosine(query, c) }))
      .sort((a, b) => b.score - a.score || a.id - b.id).slice(0, nprobe);
    const top = new SortedArray(10, 'similarity');
    let visited = 0;
    // One read transaction/query. Cursor streams cells, avoiding unbounded getAll for a broad bucket.
    const tx = db.transaction('vectors'), done = complete(tx);
    const index = tx.objectStore('vectors').index('cell');
    await Promise.all(chosen.map(({ id }) => new Promise((resolve, reject) => {
      const cursor = index.openCursor(IDBKeyRange.only(id));
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) { resolve(); return; }
        visited++;
        top.insert({ id: row.value.id, similarity: cosine(query, row.value.embedding) });
        row.continue();
      };
    })));
    await done;
    return { ids: top.slice(0, 10).map(row => row.id), scores: top.slice(0, 10).map(row => row.similarity), visited };
  }
  // All 40 held-out queries per setting; rotate setting order to reduce fixed-order bias.
  const probes = method === 'library' ? [null] : [1, 4, 16, 64];
  for (let q = 0; q < queries.length; q++) {
    for (let step = 0; step < probes.length; step++) {
      const nprobe = probes[(q + step) % probes.length];
      const started = performance.now();
      const result = await search(queries[q], nprobe);
      const latencyMs = performance.now() - started;
      if (result.scores.some((score, i) => !Number.isFinite(score) || (i > 0 && score > result.scores[i - 1]))) throw new Error('Scores must be finite and descending');
      if (method === 'library' || nprobe === 64) {
        assertExact(result.ids, manifest.truth[q]);
        if (result.scores.some((score, i) => Math.abs(score - manifest.truth[q].scores[i]) > 1e-10)) throw new Error('Exact scores disagree with independent oracle');
      }
      measurements.push({ query: q, nprobe, latencyMs, ...result,
        recallAt10: recall(result.ids, manifest.truth[q].ids),
        tieAwareRecallAt10: recall(result.ids, manifest.truth[q].acceptableIds) });
    }
    status(`${method}: ${q + 1}/${queries.length} held-out queries complete (${count.toLocaleString()} × ${dimensions}D)`);
  }
  const summary = probes.map(nprobe => {
    const rows = measurements.filter(row => row.nprobe === nprobe);
    return { nprobe, queries: rows.length, p50Ms: percentile(rows.map(row => row.latencyMs), .5),
      p95Ms: percentile(rows.map(row => row.latencyMs), .95),
      recallAt10: rows.reduce((n, row) => n + row.recallAt10, 0) / rows.length,
      tieAwareRecallAt10: rows.reduce((n, row) => n + row.tieAwareRecallAt10, 0) / rows.length,
      meanCandidates: rows.reduce((n, row) => n + row.visited, 0) / rows.length };
  });
  const result = { corpus: name, count, dimensions, method, buildMs, centroidLoadMs,
    offlineTrainingMs: method === 'ivf' ? manifest.ivf.trainingMs : 0,
    totalBuildMs: buildMs + (method === 'ivf' ? manifest.ivf.trainingMs : 0),
    storageEstimate: await navigator.storage.estimate(), summary, measurements };
  db.close();
  status(`Finished ${method}: ${count.toLocaleString()} real vectors × ${dimensions}D`);
  return result;
}
