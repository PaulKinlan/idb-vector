import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';
import { runDir } from '../tools/report-target.mjs';

// Evidence (screenshots, measurements) goes to a unique per-run directory: fixed /tmp names let
// two concurrent runs clobber each other (idb-vector-8oy). The directory is kept for inspection.
const out = runDir(undefined, 'idb-vector-browser-');
console.log(`Evidence: ${out.dir}`);

// Seeding gets no fair CPU share: several agent turns and a browser compete for the same cores, so
// the wait has to cover contention, not just the work. Measured 17.9s at load 5.7 and 25-34s at
// load 17; a FULL gate run at load >16 blew through 300s. 600s clears that noise and still bounds a
// real hang.
const DATASET_SEED_TIMEOUT_MS = 600000;

// The search phase runs on the same contended host as seeding, immediately after it: the FULL gate
// failed this wait at 30s on a correct tree at load >16, and the driver run that measured 108.1s of
// seeding at load 14.79 spent 206s end to end, so 30s was measuring the CPU share, not the work.
// The full gate allows 2400s (tests/packed-snapshot.mjs); 300s is one eighth of that for a single
// phase - well above the observed worst case, and still tight enough to bound a real hang.
const SEARCH_COMPLETE_TIMEOUT_MS = 300000;

/** The page's last #status line, bounded: a hung renderer must not turn a failure into a stall. */
async function lastStatusText(page) {
  let timer;
  const unreadable = new Promise(resolve => {
    timer = setTimeout(() => resolve('<unreadable: page unresponsive>'), 5000);
  });
  try {
    return await Promise.race([
      page.evaluate(() => document.querySelector('#status')?.textContent ?? ''),
      unreadable,
    ]);
  } catch (error) {
    return `<unreadable: ${error.message}>`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a wait that ran out of budget into a report of which phase stalled and why: elapsed ms
 * against the budget plus the page's last #status line, so contention (status still mid-work) is
 * distinguishable from a hang (status unchanged since the action).
 */
async function timedOutAfter(page, error, { phase, elapsedMs, budgetMs, stalledHint }) {
  // page.waitFor's own message already names the label it was given, so a phase the message names
  // must not be prefixed again: the message keeps the wording it was reviewed with.
  const named = error.message.includes(phase) ? '' : `${phase} `;
  return new Error(
    `${error.message}\n  ${named}after ${elapsedMs} ms of a ${budgetMs} ms budget; page #status: ${JSON.stringify(await lastStatusText(page))}` +
      `\n  (${stalledHint})`,
    { cause: error },
  );
}

/**
 * Wait for a search triggered from #search to report completion. The label names the phase, so a
 * timeout says which click stalled; the elapsed time is returned for the driver's log.
 */
async function waitForSearchComplete(page, label) {
  const start = Date.now();
  try {
    await page.waitFor(
      () => (document.querySelector('#status')?.textContent ?? '').startsWith('Search complete'),
      { timeout: SEARCH_COMPLETE_TIMEOUT_MS, label },
    );
  } catch (error) {
    throw await timedOutAfter(page, error, {
      phase: label,
      elapsedMs: Date.now() - start,
      budgetMs: SEARCH_COMPLETE_TIMEOUT_MS,
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
      { timeout: DATASET_SEED_TIMEOUT_MS, label: 'dataset creation (#generate seeding)' }
    );
  } catch (error) {
    // A bare "timed out" hides which failure this was: status still creating means the host was
    // contended, status stalled or empty means the page hung.
    throw await timedOutAfter(page, error, {
      phase: 'dataset creation (#generate seeding)',
      elapsedMs: Date.now() - generateStart,
      budgetMs: DATASET_SEED_TIMEOUT_MS,
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
