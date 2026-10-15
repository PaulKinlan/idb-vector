import assert from 'node:assert/strict';
import { serve } from '../tools/wiki-demo-server.mjs';
import { launch } from './lib/cdp.mjs';

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  const guarded = await page.evaluate(async () => {
    const { loadManifest, withVerifiedAssets } = await import('./integrity.js');
    const manifest = await loadManifest();
    const blob = URL.createObjectURL(new Blob(['local bytes']));
    try {
      return await withVerifiedAssets(manifest, async () => {
        const local = await fetch(blob);
        const pinned = await fetch('./vendor/ONNXRUNTIME-LICENSE?revision=2');
        let unpinnedRejected = false;
        try { await fetch('./vendor/unknown.js?revision=2'); } catch { unpinnedRejected = true; }
        return { local: await local.text(), pinned: pinned.ok, unpinnedRejected };
      });
    } finally { URL.revokeObjectURL(blob); }
  });
  assert.deepEqual(guarded, { local: 'local bytes', pinned: true, unpinnedRejected: true });
  // A surviving meta record must not certify a separately cleared vector store.
  await page.evaluate(async () => {
    const request = indexedDB.open('idb-vector-wikipedia-minilm-v1');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction(['meta', 'vectors'], 'readwrite');
    tx.objectStore('vectors').clear();
    tx.objectStore('meta').put({ count: 250, totalMs: 1, setupMs: 1, writeMs: 1, browser: 'test' }, 'loaded');
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    db.close();
  });
  await page.goto(url);
  // #storage is written by an async IndexedDB inspection after load. Reading it straight after goto
  // is a race: under load the evaluate saw '' and the full gate failed on this line (2026-10-15,
  // c1dd88d). Wait for the message the assertion is about, as the #status read below already does.
  const storage = await page.waitFor(() => {
    const text = document.querySelector('#storage').textContent;
    return /incomplete or invalid \(0 of 250 vectors\)/.test(text) ? text : '';
  }, { label: 'incomplete storage message after reload', timeout: 60000 });
  assert.match(storage, /incomplete or invalid \(0 of 250 vectors\)/);
  assert.equal(await page.evaluate(() => document.querySelector('#run').disabled), true);
  await page.screenshot('/tmp/idb-demo-incomplete-before.png');
  await page.click('#load');
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Ready:') || document.querySelector('#status').textContent.startsWith('Load failed:'), { timeout: 180000 });
  const result = await page.evaluate(async () => {
    const request = indexedDB.open('idb-vector-wikipedia-minilm-v1');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const count = await new Promise((resolve, reject) => {
      const query = db.transaction('vectors').objectStore('vectors').count();
      query.onsuccess = () => resolve(query.result); query.onerror = () => reject(query.error);
    });
    db.close();
    return { status: document.querySelector('#status').textContent, count, runEnabled: !document.querySelector('#run').disabled };
  });
  assert.match(result.status, /^Ready: 250 passages committed/);
  assert.equal(result.count, 250);
  assert.equal(result.runEnabled, true);
  await page.screenshot('/tmp/idb-demo-incomplete-after.png');
  // A matching row count is not enough when one record's vector is corrupt.
  await page.evaluate(async () => {
    const request = indexedDB.open('idb-vector-wikipedia-minilm-v1');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('vectors', 'readwrite');
    tx.objectStore('vectors').put({ embedding: [NaN] }, 1);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    db.close();
  });
  await page.goto(url);
  const invalidStorage = await page.waitFor(() => {
    const text = document.querySelector('#storage').textContent;
    return /incomplete or invalid \(250 of 250 vectors\)/.test(text) ? text : '';
  }, { label: 'invalid storage message after reload', timeout: 60000 });
  assert.match(invalidStorage, /incomplete or invalid \(250 of 250 vectors\)/);
  assert.equal(await page.evaluate(() => document.querySelector('#run').disabled), true);
  console.log(JSON.stringify({ guarded, storage, ...result, invalidStorage }));
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
}
