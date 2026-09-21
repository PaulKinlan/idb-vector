import { VectorDB } from '../index.js';
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
async function readMeta() {
  return new Promise((resolve, reject) => {
    const request = db.transaction('meta').objectStore('meta').get('loaded');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function condition() { return `${count.toLocaleString()} passages × 384 dimensions · quantized MiniLM · ${navigator.userAgent}`; }
function loadTiming(meta) {
  $('load-timing').textContent = `Load ${meta.totalMs.toFixed(0)} ms total · download/model setup ${meta.setupMs.toFixed(0)} ms · database commit ${meta.writeMs.toFixed(0)} ms. ${meta.count} passages × 384 dimensions. ${meta.browser}`;
}
if (db) {
  vectorDB = new VectorDB({ dbName, vectorPath: 'embedding' });
  try {
    const meta = await readMeta();
    if (meta) {
      count = meta.count;
      $('size').value = String(count);
      $('storage').textContent = `${count.toLocaleString()} passages already stored on this device. Press Load to restore the language model in this page.`;
      loadTiming(meta);
    }
  } catch (error) { $('status').textContent = `Cannot read saved data: ${error.message}. Remove local data and retry.`; }
}
controls(false);
$('load').addEventListener('click', async () => {
  if (busy || !db) return;
  controls(true);
  $('results').replaceChildren();
  const started = performance.now(), selected = Number($('size').value);
  $('progress').removeAttribute('value');
  $('status').textContent = 'Downloading language runtime (about 11 MB on first load)…';
  try {
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
    const saved = await readMeta();
    if (saved?.count === selected) {
      count = selected;
      $('status').textContent = `Ready: restored ${count.toLocaleString()} stored passages. This open page can now search offline.`;
      $('load-timing').textContent = `Restore ${Math.round(performance.now() - started)} ms (model setup + stored metadata). Original load: ${saved.totalMs.toFixed(0)} ms; database commit ${saved.writeMs.toFixed(0)} ms. ${condition()}`;
    } else {
      $('status').textContent = `Downloading ${selected.toLocaleString()} passages and their vectors…`;
      $('progress').removeAttribute('value');
      const responses = await Promise.all([fetch(`./data/passages-${selected}.json`), fetch(`./data/vectors-${selected}.f32`)]);
      if (responses.some(r => !r.ok)) throw new Error('Corpus download failed. Connect to the network and retry.');
      const passages = await responses[0].json(), bytes = await responses[1].arrayBuffer();
      if (passages.length !== selected || bytes.byteLength !== selected * 384 * 4) throw new Error('Corpus size mismatch');
      const vectors = new Float32Array(bytes);
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
        tx.objectStore('meta').put({ count: selected, totalMs: 0, setupMs, writeMs: 0, browser: navigator.userAgent }, 'loaded');
      } catch (error) {
        tx.abort();
        await done.catch(() => {});
        throw error;
      }
      await done;
      count = selected;
      const meta = { count, totalMs: performance.now() - started, setupMs, writeMs: performance.now() - writing, browser: navigator.userAgent };
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
  $('query-timing').textContent = 'Encoding question on this device…';
  try {
    const start = performance.now();
    const [vector] = await encoder([query]);
    const encoded = performance.now();
    const results = await vectorDB.query(vector, { limit: 5 });
    const end = performance.now();
    $('query-timing').textContent = `Question encoding ${(encoded - start).toFixed(1)} ms · IndexedDB search ${(end - encoded).toFixed(1)} ms · total ${(end - start).toFixed(1)} ms. ${condition()}`;
    for (const { object, similarity } of results) {
      const li = document.createElement('li'), heading = document.createElement('h3'), link = document.createElement('a');
      link.textContent = object.title;
      link.href = `https://en.wikipedia.org/w/index.php?oldid=${object.revision}`;
      heading.append(link);
      const text = document.createElement('p');
      text.textContent = object.text;
      const score = document.createElement('p');
      score.className = 'detail';
      score.textContent = `Cosine similarity ${similarity.toFixed(4)} · cosine distance (1 − similarity) ${(1 - similarity).toFixed(4)}`;
      const attribution = document.createElement('a');
      attribution.href = `https://en.wikipedia.org/w/index.php?curid=${object.pageid}&action=history`;
      attribution.textContent = 'Wikipedia contributors / history';
      attribution.className = 'detail';
      li.append(heading, text, score, attribution);
      $('results').append(li);
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
      for (const request of await cache.keys()) if (request.url.startsWith(prefix)) await cache.delete(request);
    }
    count = 0;
    $('results').replaceChildren();
    $('status').textContent = 'Stored passages, vectors and model cache removed. The running model remains in memory until you close this tab.';
    $('storage').textContent = '';
    $('load-timing').textContent = 'Load timing will appear here.';
    $('query-timing').textContent = 'Search timing will appear here.';
    $('progress').value = 0;
  } catch (error) { $('status').textContent = `Could not remove all local data: ${error.message}. Clear this site’s storage in browser settings.`; }
  finally { controls(false); }
});
