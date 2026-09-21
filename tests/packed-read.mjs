import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';
const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const { vector } = await import('/test-harness/experiment.js');
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const count = 100000, dimensions = 128;
    const open = indexedDB.open(`packed-measure-${crypto.randomUUID()}`, 1);
    open.onupgradeneeded = () => { for (const name of ['rows', 'packed']) open.result.createObjectStore(name); };
    const db = await request(open);
    const packed32 = new Float32Array(count * dimensions), packed64 = new Float64Array(count * dimensions);
    for (let offset = 0; offset < count; offset += 1000) {
      const tx = db.transaction('rows', 'readwrite');
      const done = complete(tx);
      for (let id = offset; id < offset + 1000; id++) {
        const embedding = vector(id, dimensions);
        packed32.set(embedding, id * dimensions); packed64.set(embedding, id * dimensions);
        tx.objectStore('rows').put({ id, embedding }, id);
      }
      await done;
    }
    const tx = db.transaction('packed', 'readwrite'), done = complete(tx);
    tx.objectStore('packed').put(packed32, 'f32'); tx.objectStore('packed').put(packed64, 'f64'); await done;
    const time = async fn => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };
    const readPacked = type => request(db.transaction('packed').objectStore('packed').get(type));
    const scan = async () => {
      let checksum = 0;
      for (let offset = 0; offset < count; offset += 1000) {
        const rows = await request(db.transaction('rows').objectStore('rows').getAll(IDBKeyRange.lowerBound(offset), 1000));
        for (const row of rows) checksum += row.embedding[0];
      }
      return checksum;
    };
    const random = async () => {
      const latencies = []; let checksum = 0;
      for (let i = 0; i < 256; i++) {
        const key = (Math.imul(i + 1, 2654435761) >>> 0) % count;
        const r = await time(() => request(db.transaction('rows').objectStore('rows').get(key)));
        checksum += r.value.embedding[0]; latencies.push(r.ms);
      }
      latencies.sort((a, b) => a - b);
      return { p50Ms: latencies[128], p95Ms: latencies[243], totalMs: latencies.reduce((a,b) => a+b), reads: 256, checksum };
    };
    const query = vector(42, dimensions);
    const score = () => {
      let checksum = 0;
      const qnorm = Math.sqrt(query.reduce((s,x) => s+x*x, 0));
      for (let row = 0; row < count; row++) {
        let dot = 0, norm = 0;
        for (let d = 0; d < dimensions; d++) { const x = packed64[row*dimensions+d]; dot += query[d]*x; norm += x*x; }
        checksum += dot/(qnorm*Math.sqrt(norm));
      }
      return checksum;
    };
    const runs = [];
    for (let run = 0; run < 3; run++) {
      const methods = { packed32: () => readPacked('f32'), packed64: () => readPacked('f64'), records: scan, arithmetic: score, random };
      const names = Object.keys(methods), row = {};
      for (let j = 0; j < names.length; j++) {
        const name = names[(j+run)%names.length]; const r = await time(methods[name]);
        row[name] = { ms: r.ms, ...(ArrayBuffer.isView(r.value) ? { bytes: r.value.byteLength, first: r.value[0], last: r.value.at(-1) } : { value: r.value }) };
      }
      runs.push(row);
    }
    db.close(); indexedDB.deleteDatabase(db.name);
    return { count, dimensions, runs };
  });
  for (const run of result.runs) { assert.equal(run.packed32.bytes, 51200000); assert.equal(run.packed64.bytes, 102400000); assert.ok(Number.isFinite(run.arithmetic.value)); }
  const report = { sourceCommit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(), sourceDiff: execFileSync('git', ['diff', '--stat']).toString().trim(), observedAt: new Date().toISOString(), browser: await page.send('Browser.getVersion'), cpu: os.cpus()[0].model, load: os.loadavg(), condition: 'Fresh headless Chromium profile; warm IDB after committed writes; seeded synthetic 100k x128, three order-rotated runs; 1000-row getAll pages; 256 serial random gets each using a fresh readonly transaction; arithmetic is cosine only (not top-k); not cold-disk or an isolated host. Float32 rounds original JS numbers; Float64 preserves them.', ...result };
  await writeFile('reports/packed-read.json', JSON.stringify(report, null, 2)+'\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await page?.close(); await new Promise(resolve => server.close(resolve)); }
