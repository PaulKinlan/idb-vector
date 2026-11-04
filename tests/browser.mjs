import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';
import { PAGE_WORK_WAIT_MS, READY_WAIT_MS, timedOutAfter } from './lib/wait-budget.mjs';
import { runDir } from '../tools/report-target.mjs';

// Evidence (screenshots, measurements) goes to a unique per-run directory: fixed /tmp names let
// two concurrent runs clobber each other (idb-vector-8oy). The directory is kept for inspection.
const out = runDir(undefined, 'idb-vector-browser-');
console.log(`Evidence: ${out.dir}`);

// The wait budgets this driver spends, and the measurements behind them, are shared with the other
// two drivers in tests/lib/wait-budget.mjs (idb-vector-t5wv): READY_WAIT_MS for the dataset build,
// PAGE_WORK_WAIT_MS for a search.

/**
 * Wait for a search triggered from #search to report completion. The label names the phase, so a
 * timeout says which click stalled; the elapsed time is returned for the driver's log.
 */
async function waitForSearchComplete(page, label) {
  const start = Date.now();
  try {
    await page.waitFor(
      () => (document.querySelector('#status')?.textContent ?? '').startsWith('Search complete'),
      { timeout: PAGE_WORK_WAIT_MS, label },
    );
  } catch (error) {
    throw await timedOutAfter(page, error, {
      phase: label,
      elapsedMs: Date.now() - start,
      budgetMs: PAGE_WORK_WAIT_MS,
      stalledHint: 'still searching => host contention; #status unchanged since the click => page hang',
    });
  }
  return Date.now() - start;
}

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  await page.screenshot(join(out.dir, 'before.png'));
  const generateStart = Date.now();
  await page.click('#generate');
  try {
    await page.waitFor(
      () => {
        const text = document.querySelector('#status')?.textContent ?? '';
        if (text.startsWith('Dataset failed:')) throw new Error(text);
        return text.startsWith('Ready:');
      },
      { timeout: READY_WAIT_MS, label: 'dataset creation (#generate seeding)' }
    );
  } catch (error) {
    // A bare "timed out" hides which failure this was: status still creating means the host was
    // contended, status stalled or empty means the page hung.
    throw await timedOutAfter(page, error, {
      phase: 'dataset creation (#generate seeding)',
      elapsedMs: Date.now() - generateStart,
      budgetMs: READY_WAIT_MS,
      stalledHint: 'still creating => host contention; unchanged since the click => page hang',
    });
  }
  console.log(`Dataset seeded in ${((Date.now() - generateStart) / 1000).toFixed(1)}s`);
  await page.click('#run');
  const firstSearchMs = await waitForSearchComplete(page, 'search complete after #search (ID42 query)');
  console.log(`Search complete in ${firstSearchMs} ms (ID42 query)`);
  assert.equal(await page.evaluate(() => document.querySelector('#results tr td').textContent), '42');
  assert.equal(await page.evaluate(() => document.querySelectorAll('#results tr').length), 10);
  await page.type('#query', '7');
  await page.click('#run');
  await waitForSearchComplete(page, 'search complete after #search (changed query 7)');
  assert.equal(await page.evaluate(() => document.querySelector('#results tr td').textContent), '7');
  await page.click('#category');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await page.evaluate(() => document.querySelector('#category').value), '7');
  await page.click('#run');
  await waitForSearchComplete(page, 'search complete after #search (category 7)');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#results tr')].every(row => row.children[1].textContent === '7')), true);
  await page.screenshot(join(out.dir, 'after.png'), { fullPage: true });
  for (const width of [360, 390, 430]) {
    await page.emulateViewport({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.emulateViewport({ width: 844, height: 390 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot(join(out.dir, 'landscape.png'));
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
      // The baseline run accepted these; the contract now refuses them before any transaction.
      const rejectedWrites = [];
      for (const embedding of [[0, 0], [Infinity, 0], [], [1, NaN]]) {
        try { await db.insert({ embedding }); rejectedWrites.push(`${embedding}: accepted`); }
        catch (error) { rejectedWrites.push(`${embedding}: ${error.message}`); }
      }
      const scores = (await db.query([1, 0])).map(x => String(x.similarity));
      let nestedError;
      try { new VectorDB({ dbName: `${name}-nested`, vectorPath: 'nested.vector' }); nestedError = 'accepted'; }
      catch (error) { nestedError = error.message; }
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
      let acknowledged, writeError;
      try { acknowledged = await db.insert({ embedding: [1, 1] }); }
      catch (error) { writeError = error.message; }
      finally { IDBObjectStore.prototype.add = original; }
      const transactionAborted = await abortWitness;
      const stillPresent = (await db.query([1, 1], { limit: 10 })).some(x => x.key === acknowledged);
      indexedDB.deleteDatabase(name);
      return { emptyOptionsCount, scores, rejectedWrites, nestedError, acknowledged, writeError, transactionAborted, stillPresent };
    });
    report.finished = new Date().toISOString(); report.loadEnd = os.loadavg();
    const output = process.env.IDB_VECTOR_REPORT || join(out.dir, 'measurements.json');
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Measurements: ${output}`);
  }
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
}
