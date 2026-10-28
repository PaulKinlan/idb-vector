import { VectorDB } from '../index.js';
import { browserLabel } from './ua.js';
import { loadManifest, verifyBytes } from './integrity.js';
import { validateStoredMeta, validateStoredRecord } from './record-validation.js';
import { corpusFiles, nearestCorpusSize } from './corpus-size.js';
import { resultsView } from './results.js';
const $ = id => document.getElementById(id);
const dbName = 'idb-vector-wikipedia-minilm-v1';
let encoder, vectorDB, count = 0, busy = false;
const db = await new Promise((resolve, reject) => {
  const request = indexedDB.open(dbName, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('vectors', { autoIncrement: true }).createIndex('embedding', 'embedding');
    request.result.createObjectStore('meta');
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
}).catch(error => { $('status').textContent = `Storage unavailable: ${error.message}. Allow browser storage and reload.`; return null; });
function connection() { $('connection').textContent = navigator.onLine ? 'Browser reports online' : 'Browser reports offline'; }
connection();
addEventListener('online', connection);
addEventListener('offline', connection);
function controls(value) {
  busy = value;
  $('load').disabled = value || !db;
  $('size').disabled = value;
  $('clear').disabled = value || !db;
  $('run').disabled = value || !encoder || !count;
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('Database transaction aborted'));
    tx.onerror = () => {}; // The abort event is the final outcome.
  });
}
async function readStored() {
  // Metadata and every record are observed in one read transaction. Count alone
  // cannot detect a same-size store containing a malformed record, and a malformed
  // record is not only a bad vector: every field the panel renders is checked by
  // validateStoredRecord(), and the timings it draws by validateStoredMeta()
  // (demo/record-validation.js, idb-vector-4skw).
  const tx = db.transaction(['meta', 'vectors']);
  const done = transactionDone(tx);
  const meta = tx.objectStore('meta').get('loaded');
  const cursor = tx.objectStore('vectors').openCursor();
  let vectors = 0, problem = null;
  cursor.onsuccess = () => {
    const row = cursor.result;
    if (!row) return;
    vectors++;
    problem ??= validateStoredRecord(row.value);
    row.continue();
  };
  await done;
  if (problem === null && meta.result !== undefined) problem = validateStoredMeta(meta.result);
  return { meta: meta.result, vectors, valid: problem === null, problem };
}
function condition() { return `${count.toLocaleString()} passages × 384 dimensions · quantized MiniLM · ${browserLabel()}`; }
function loadTiming(meta) {
  $('load-timing').textContent = `Load ${meta.totalMs.toFixed(0)} ms total · download/model setup ${meta.setupMs.toFixed(0)} ms · database commit ${meta.writeMs.toFixed(0)} ms. ${meta.count} passages × 384 dimensions. ${meta.browser}`;
}
if (db) {
  vectorDB = new VectorDB({ dbName, vectorPath: 'embedding' });
  try {
    const { meta, vectors, valid, problem } = await readStored();
    if (meta) {
      if (valid && vectors === meta.count) {
        count = meta.count;
        // An earlier visit may have loaded a corpus size this page no longer offers. Writing that
        // count into #size would match no option, leave the control unselected, and make Load read
        // Number('') = 0 and request passages-0.json (idb-vector-z7q7), so the select always gets an
        // option the markup offers and the message says which corpus Load will download.
        const size = nearestCorpusSize(count, [...$('size').options].map(option => option.value));
        $('size').value = String(size);
        $('storage').textContent = size === count
          ? `${count.toLocaleString()} passages already stored on this device. Press Load to restore the language model in this page.`
          : `${count.toLocaleString()} passages are stored on this device, but not at a corpus size this page offers. Press Load to download ${size.toLocaleString()} passages and replace them.`;
        loadTiming(meta);
      } else {
        const countDisplay = Number.isSafeInteger(meta?.count) && meta.count >= 0 ? `${meta.count.toLocaleString()} vectors` : 'the expected count';
        const problemSummary = problem ? ` First problem: ${problem}.` : '';
        const msg = `Stored corpus is incomplete or invalid (${vectors.toLocaleString()} of ${countDisplay}).${problemSummary} Press Load to download it again.`;
        $('storage').textContent = msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
      }
    }
  } catch (error) {
    const msg = `Cannot read saved data: ${error.message}. Remove local data and retry.`;
    $('status').textContent = msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
  }
}
// The stored-corpus probe above is asynchronous, so #storage is empty until it finishes and its
// text is the only trace of what it found. Publish completion as data-storage-probe so a driver can
// wait for the read rather than race it (the page's own #load button is enabled from the markup, so
// it cannot stand in for the probe); the attribute is set in every case, including when storage is
// unavailable and the probe will never run.
document.documentElement.dataset.storageProbe = 'done';
controls(false);
$('load').addEventListener('click', async () => {
  if (busy || !db) return;
  controls(true);
  $('results').replaceChildren();
  const started = performance.now();
  $('progress').removeAttribute('value');
  $('status').textContent = 'Downloading language runtime (about 11 MB on first load)…';
  try {
    // Throws rather than build ./data/passages-0.json from an unselected #size; the catch below
    // reports it as a failed load and the button comes back.
    const { count: selected, passages: passageFile, vectors: vectorFile } = corpusFiles($('size').value);
    if (!encoder) {
      const { createEncoder } = await import('./encoder.js');
      encoder = await createEncoder(info => {
        if (info.status === 'progress') {
          $('progress').max = info.total || 1;
          $('progress').value = info.loaded || 0;
          $('status').textContent = `Loading ${info.file}: ${(info.loaded / 1e6).toFixed(1)} / ${(info.total / 1e6).toFixed(1)} MB (${Math.round(info.progress)}%). Model files are cached on this device.`;
        }
      });
    }
    const { meta: saved, vectors: storedVectors, valid } = await readStored();
    if (saved?.count === selected && storedVectors === selected && valid) {
      count = selected;
      $('status').textContent = `Ready: restored ${count.toLocaleString()} stored passages. This open page can now search offline.`;
      $('load-timing').textContent = `Restore ${Math.round(performance.now() - started)} ms (model setup + stored metadata). Original load: ${saved.totalMs.toFixed(0)} ms; database commit ${saved.writeMs.toFixed(0)} ms. ${condition()}`;
    } else {
      $('status').textContent = `Downloading ${selected.toLocaleString()} passages and their vectors…`;
      $('progress').removeAttribute('value');
      // Corpus bytes are checked against the pinned manifest before use.
      const manifest = await loadManifest();
      const responses = await Promise.all([fetch(passageFile.url), fetch(vectorFile.url)]);
      if (responses.some(r => !r.ok)) throw new Error('Corpus download failed. Connect to the network and retry.');
      const passageBytes = new Uint8Array(await responses[0].arrayBuffer());
      const vectorBytes = new Uint8Array(await responses[1].arrayBuffer());
      await verifyBytes(manifest, passageFile.path, passageBytes, 'the passage corpus');
      await verifyBytes(manifest, vectorFile.path, vectorBytes, 'the corpus vectors');
      const passages = JSON.parse(new TextDecoder().decode(passageBytes));
      if (passages.length !== selected || vectorBytes.byteLength !== selected * 384 * 4) throw new Error('Corpus size mismatch');
      const vectors = new Float32Array(vectorBytes.buffer);
      if (!vectors.every(Number.isFinite)) throw new Error('Invalid corpus vector');
      const setupMs = performance.now() - started, writing = performance.now();
      // One atomic replacement. A failed/aborted load preserves the previous corpus.
      const tx = db.transaction(['vectors', 'meta'], 'readwrite'), done = transactionDone(tx);
      const store = tx.objectStore('vectors');
      try {
        store.clear();
        $('progress').max = selected;
        $('progress').value = 0;
        for (let i = 0; i < selected; i++) {
          const request = store.add({ ...passages[i], embedding: Array.from(vectors.subarray(i * 384, (i + 1) * 384)) });
          if ((i + 1) % 50 === 0 || i + 1 === selected) request.onsuccess = () => {
            $('progress').value = i + 1;
            $('status').textContent = `Writing ${i + 1} / ${selected} vectors to IndexedDB; waiting for commit…`;
          };
        }
        // Persist identity in the same transaction; timing is recorded after commit separately.
        tx.objectStore('meta').put({ count: selected, totalMs: 0, setupMs, writeMs: 0, browser: browserLabel() }, 'loaded');
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
      await done;
      count = selected;
      const meta = { count, totalMs: performance.now() - started, setupMs, writeMs: performance.now() - writing, browser: browserLabel() };
      const timingTx = db.transaction('meta', 'readwrite'), timingDone = transactionDone(timingTx);
      timingTx.objectStore('meta').put(meta, 'loaded');
      await timingDone;
      loadTiming(meta);
      $('status').textContent = `Ready: ${count.toLocaleString()} passages committed. This open page can now search offline.`;
    }
    $('progress').max = count;
    $('progress').value = count;
    $('storage').textContent = `${count.toLocaleString()} passages and vectors now live in IndexedDB on this device. Try a new question with the network turned off.`;
  } catch (error) {
    $('status').textContent = `Load failed: ${error.message}. Reconnect and retry; committed data remains available.`;
  } finally { controls(false); }
});
$('search').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !encoder || !count || !vectorDB) return;
  const query = $('query').value.trim();
  if (!query) return;
  controls(true);
  $('results').replaceChildren();
  $('result-summary').textContent = '';
  $('query-timing').textContent = 'Encoding question on this device…';
  try {
    const start = performance.now();
    const [vector] = await encoder([query]);
    const encoded = performance.now();
    const results = await vectorDB.query(vector, { limit: 5 });
    const end = performance.now();
    $('query-timing').textContent = `Question encoding ${(encoded - start).toFixed(1)} ms · IndexedDB search ${(end - encoded).toFixed(1)} ms · total ${(end - start).toFixed(1)} ms. ${condition()}`;
    const view = resultsView(results, query);
    $('result-summary').textContent = view.summary;
    const list = $('results');
    for (const item of view.items) {
      const li = document.createElement('li'), heading = document.createElement('h3'), link = document.createElement('a');
      link.textContent = item.title;
      link.href = item.href;
      heading.append(link);
      const text = document.createElement('p');
      text.textContent = item.text;
      const score = document.createElement('p');
      score.className = 'detail';
      score.textContent = item.score;
      const attribution = document.createElement('a');
      attribution.href = item.sourceHref;
      attribution.textContent = item.sourceText;
      attribution.className = 'detail';
      li.append(heading, text, score, attribution);
      list.append(li);
    }
    // The zero-result answer is rendered as a result, not as an empty list: same heading level,
    // same list, so it reads as the outcome of the search instead of a panel still filling in.
    if (view.empty) {
      const li = document.createElement('li'), heading = document.createElement('h3'), text = document.createElement('p');
      li.className = 'empty';
      heading.textContent = view.empty.heading;
      text.textContent = view.empty.body;
      li.append(heading, text);
      list.append(li);
    }
  } catch (error) { $('query-timing').textContent = `Search failed: ${error.message}. Try loading again.`; }
  finally { controls(false); }
});
$('clear').addEventListener('click', async () => {
  if (busy || !db) return;
  controls(true);
  try {
    const tx = db.transaction(['vectors', 'meta'], 'readwrite'), done = transactionDone(tx);
    tx.objectStore('vectors').clear(); tx.objectStore('meta').clear();
    await done;
    // Only remove this demo's model entries, not other apps' caches on the same origin.
    if ('caches' in window && await caches.has('transformers-cache')) {
      const cache = await caches.open('transformers-cache');
      const prefix = new URL('./models/', import.meta.url).href;
      // Deletes are independent per entry: run them together instead of one round-trip at a time.
      const matching = (await cache.keys()).filter(request => request.url.startsWith(prefix));
      await Promise.all(matching.map(request => cache.delete(request)));
    }
    count = 0;
    $('results').replaceChildren();
    $('result-summary').textContent = '';
    $('status').textContent = 'Stored passages, vectors and model cache removed. The running model remains in memory until you close this tab.';
    $('storage').textContent = '';
    $('load-timing').textContent = 'Load timing will appear here.';
    $('query-timing').textContent = 'Search timing will appear here.';
    $('progress').value = 0;
  } catch (error) { $('status').textContent = `Could not remove all local data: ${error.message}. Clear this site’s storage in browser settings.`; }
  finally { controls(false); }
});
