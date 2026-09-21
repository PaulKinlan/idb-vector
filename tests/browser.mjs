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
  await page.screenshot('/tmp/idb-vector-before.png');
  await page.click('#generate');
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Ready:'), { timeout: 120000 });
  await page.click('#run');
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Search complete'), { timeout: 30000 });
  assert.equal(await page.evaluate(() => document.querySelector('#results tr td').textContent), '42');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#results tr').length), 10);
  await page.type('#query', '7');
  await page.click('#run');
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Search complete'));
  assert.equal(await page.evaluate(() => document.querySelector('#results tr td').textContent), '7');
  await page.click('#category');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await page.evaluate(() => document.querySelector('#category').value), '7');
  await page.click('#run');
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Search complete'));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#results tr')].every(row => row.children[1].textContent === '7')), true);
  await page.screenshot('/tmp/idb-vector-after.png');
  for (const width of [360, 390, 430]) {
    await page.emulateViewport({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.emulateViewport({ width: 844, height: 390 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot('/tmp/idb-vector-landscape.png');
  console.log('PASS: real clicks, dataset creation, self-match, changed query, category results, 360/390/430/landscape no overflow');

  if (process.argv.includes('--measure')) {
    const report = {
      libraryCommit: execFileSync('git', ['rev-parse', 'e346cc4']).toString().trim(),
      harnessCommit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
      trackedDiff: execFileSync('git', ['diff', '--stat']).toString().trim(),
      browser: await page.send('Browser.getVersion'),
      hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramBytes: os.totalmem(), platform: os.platform(), release: os.release() },
      started: new Date().toISOString(), loadStart: os.loadavg(),
      conditions: 'Headless Chromium, fresh temporary profile, same browser process, seeded uniform [-1,1) vectors, category=id%100, query ID42, k10, three order-rotated repetitions, writes complete before queries; not cold disk or idle host',
      measurements: [],
    };
    for (const count of [1000, 10000, 100000]) {
      console.log(`Measuring ${count} x 128`);
      const row = await page.evaluate(async count => {
        const { dataset, measure, discard } = await import('/test-harness/experiment.js');
        const data = await dataset(count, 128);
        try { return await measure(data); } finally { discard(data); }
      }, count);
      report.measurements.push(row);
      console.log(JSON.stringify(row));
    }
    report.findings = await page.evaluate(async () => {
      const { VectorDB } = await import('/index.js');
      const name = `idb-vector-findings-${crypto.randomUUID()}`;
      const db = new VectorDB({ dbName: name, vectorPath: 'embedding' });
      await db.insert({ embedding: [1, 0] });
      const emptyOptionsCount = (await db.query([1, 0], {})).length;
      await db.insert({ embedding: [0, 0] });
      await db.insert({ embedding: [Infinity, 0] });
      const scores = (await db.query([1, 0])).map(x => String(x.similarity));
      const nested = new VectorDB({ dbName: `${name}-nested`, vectorPath: 'nested.vector' });
      let nestedError;
      try { await nested.insert({ nested: { vector: [1, 0] } }); } catch (error) { nestedError = error.message; }
      // Observe promise resolution despite a real aborted transaction.
      const original = IDBObjectStore.prototype.add;
      let aborted;
      const abortWitness = new Promise(resolve => { aborted = resolve; });
      IDBObjectStore.prototype.add = function (...args) {
        const request = original.apply(this, args);
        this.transaction.addEventListener('abort', () => aborted(true));
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      };
      let acknowledged;
      try { acknowledged = await db.insert({ embedding: [1, 1] }); }
      finally { IDBObjectStore.prototype.add = original; }
      const transactionAborted = await abortWitness;
      const stillPresent = (await db.query([1, 1], { limit: 10 })).some(x => x.key === acknowledged);
      indexedDB.deleteDatabase(name); indexedDB.deleteDatabase(`${name}-nested`);
      return { emptyOptionsCount, scores, nestedError, acknowledged, transactionAborted, stillPresent };
    });
    report.finished = new Date().toISOString(); report.loadEnd = os.loadavg();
    const output = process.env.IDB_VECTOR_REPORT || '/tmp/idb-vector-measurements.json';
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Measurements: ${output}`);
  }
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
}
