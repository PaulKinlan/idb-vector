import assert from 'node:assert/strict';
import { serve } from '../tools/wiki-demo-server.mjs';
import { launch } from './lib/cdp.mjs';

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
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
  const storage = await page.evaluate(() => document.querySelector('#storage').textContent);
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
  const invalidStorage = await page.evaluate(() => document.querySelector('#storage').textContent);
  assert.match(invalidStorage, /incomplete or invalid \(250 of 250 vectors\)/);
  assert.equal(await page.evaluate(() => document.querySelector('#run').disabled), true);
  console.log(JSON.stringify({ storage, ...result, invalidStorage }));
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
}
