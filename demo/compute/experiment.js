import { VectorDB } from '../../index.js';
import { corpus, cpuScores, topK, compare, wasmEngine, gpuEngine } from './engines.js';

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
const complete = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  tx.onerror = () => reject(tx.error);
});
async function timed(fn) {
  const start = performance.now(); const value = await fn();
  return { ms: performance.now() - start, value };
}
function equal(a, b) {
  if (a.length !== b.length) throw new Error('Storage length mismatch');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error(`Storage mismatch at float ${i}`);
  return true;
}

export async function experiment({ count = 100000, dim = 128, onProgress = () => {} } = {}) {
  if (!Number.isSafeInteger(count) || count < 10 || ![32, 128, 384].includes(dim)) throw new Error('Invalid corpus parameters');
  const values = corpus(count, dim), name = `idb-vector-compute-${crypto.randomUUID()}`;
  const report = {
    started: new Date().toISOString(), count, dim, bytes: values.byteLength, corpus: 'Synthetic LCG uniform [-1,1), seed 42, Float32',
    browser: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
    conditions: 'Fresh database; warm OS caches possible; one write/read per backend, three queries, rotated engine order, no unreported warmup. Full CPU score readback and common JS top-k. No embeddings/model timing.',
    storage: {}, engines: {}, queries: [],
  };
  let db, gpu, opfsRoot, library;
  try {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      const records = open.result.createObjectStore('vectors');
      // Match the current library schema, including its unused vector index.
      records.createIndex('embedding', 'embedding', { unique: false });
      open.result.createObjectStore('packed');
    };
    db = await request(open);
    onProgress('Writing individual IndexedDB records…');
    const write = await timed(async () => {
      const tx = db.transaction('vectors', 'readwrite'), done = complete(tx), store = tx.objectStore('vectors');
      for (let id = 0; id < count; id++) store.put({ embedding: Array.from(values.subarray(id * dim, (id + 1) * dim)) }, id);
      await done;
    });
    const read = await timed(async () => {
      const output = new Float32Array(values.length);
      const tx = db.transaction('vectors'), done = complete(tx);
      const req = tx.objectStore('vectors').openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { output.set(c.value.embedding, c.key * dim); c.continue(); } };
      await done; return output;
    });
    report.storage.records = { writeMs: write.ms, readMs: read.ms, roundTripExact: equal(values, read.value), layout: 'Array-valued records plus embedding IDBIndex, one transaction; cursor read includes packing to Float32' };
    onProgress('Writing and reading a packed IndexedDB snapshot…');
    const packedWrite = await timed(async () => {
      const tx = db.transaction('packed', 'readwrite'), done = complete(tx);
      tx.objectStore('packed').put(values, 'snapshot'); await done;
    });
    const packedRead = await timed(async () => {
      const tx = db.transaction('packed'), done = complete(tx);
      const value = await request(tx.objectStore('packed').get('snapshot')); await done; return value;
    });
    report.storage.packed = { writeMs: packedWrite.ms, readMs: packedRead.ms, roundTripExact: equal(values, packedRead.value), layout: 'One Float32Array snapshot; no per-vector metadata index' };
    onProgress('Writing and reading an OPFS snapshot…');
    try {
      opfsRoot = await navigator.storage.getDirectory();
      const handle = await opfsRoot.getFileHandle(name, { create: true });
      const opfsWrite = await timed(async () => {
        const stream = await handle.createWritable();
        try { await stream.write(values); await stream.close(); }
        catch (error) { await stream.abort().catch(() => {}); throw error; }
      });
      const opfsRead = await timed(async () => new Float32Array(await (await handle.getFile()).arrayBuffer()));
      report.storage.opfs = { writeMs: opfsWrite.ms, readMs: opfsRead.ms, roundTripExact: equal(values, opfsRead.value), layout: 'Raw Float32 file; async writable stream and File.arrayBuffer; no metadata index' };
    } catch (error) {
      if (error.message.startsWith('Storage ')) throw error;
      report.storage.opfs = { unavailable: error.message };
    }

    onProgress('Preparing WASM-SIMD and WebGPU…');
    let wasm;
    try { wasm = await wasmEngine(values, dim); report.engines.wasm = { setupMs: wasm.setupMs, uploadMs: wasm.uploadMs }; }
    catch (error) { report.engines.wasm = { unavailable: error.message }; }
    try { gpu = await gpuEngine(values, dim); report.engines.gpu = { setupMs: gpu.setupMs, uploadMs: gpu.uploadMs, adapter: gpu.adapterInfo }; }
    catch (error) { report.engines.gpu = { unavailable: error.message }; }
    // Opening the current public API on the exact same records, not a copied approximation.
    library = new VectorDB({ dbName: name, objectStore: 'vectors', vectorPath: 'embedding' });
    const queries = [values.slice(7 * dim, 8 * dim), corpus(1, dim, 987), corpus(1, dim, 12345)];
    for (let i = 0; i < queries.length; i++) {
      onProgress(`Query ${i + 1}/3: same input across all engines…`);
      const query = queries[i], row = { query: i === 0 ? 'self ID7' : `independent seed ${i === 1 ? 987 : 12345}`, results: {} };
      let referenceScores;
      const paths = ['library', 'cpu', 'wasm', 'gpu'];
      for (const path of [...paths.slice(i), ...paths.slice(0, i)]) {
        if ((path === 'wasm' && !wasm) || (path === 'gpu' && !gpu)) continue;
        const run = await timed(async () => {
          if (path === 'library') return { top: (await library.query(Array.from(query), { limit: 10 })).map(x => ({ id: x.key, score: x.similarity })) };
          const scores = path === 'cpu' ? cpuScores(values, query) : await (path === 'wasm' ? wasm : gpu).run(query);
          if (path === 'cpu') referenceScores = scores;
          return { scores: scores.slice(), top: topK(scores) };
        });
        row.results[path] = { ms: run.ms, top: run.value.top, scores: run.value.scores };
      }
      const reference = row.results.cpu.top;
      for (const result of Object.values(row.results)) {
        result.comparison = compare(reference, result.top, referenceScores, result.scores);
        delete result.scores;
      }
      report.queries.push(row);
    }
    report.finished = new Date().toISOString();
    return report;
  } finally {
    gpu?.close();
    db?.close();
    if (opfsRoot) await opfsRoot.removeEntry(name).catch(() => {});
    // VectorDB has no close API. A blocked delete is queued and completes on page close/reload.
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onerror = () => console.warn('Benchmark database cleanup failed', deletion.error);
    deletion.onblocked = () => console.info('Benchmark database cleanup queued until this page closes (library has no close API).');
  }
}
