import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { launch } from './lib/cdp.mjs';
import { serve } from '../tools/wiki-demo-server.mjs';
import { runDir } from '../tools/report-target.mjs';
// Every wait here measures work on a host shared with other agent turns, so each spends a gate-derived
// budget rather than waitFor's 15s default or a per-site guess: the load phase immediately before the
// injected-write-failure check took 242.8s in the full gate on ea71d3f (2026-10-29, idb-vector-g85a),
// and that check then waited 15s, so a correct tree failed. A load phase downloads the model and
// commits a corpus (233s measured for the 250-passage load under host load, idb-vector-k6wh); any
// other page phase encodes a query, reads 2,000 records back or waits for the offline flag. The full
// gate allows 2400s for npm test, the packed run and this driver together: a load gets a quarter of
// that, every other page phase an eighth, the same split tests/browser.mjs uses for its dataset and
// search waits.
const READY_WAIT_MS = 600000;
const PAGE_WORK_WAIT_MS = 300000;
const external = process.argv[2];
const local = external ? null : await serve();
const url = external || local.url;
// Unique per-run evidence directory (a fixed /tmp name let two runs share one - idb-vector-8oy).
const { dir: evidence } = runDir(process.env.IDB_DEMO_EVIDENCE, 'idb-wikipedia-demo-');
// Disclose the directory BEFORE the run starts (idb-vector-tkh): a run that hangs or dies at
// launch would otherwise leave screenshots and report.json in a directory nothing names.
console.log(`Evidence: ${evidence}`);
const page = await launch();
const report = { url, evidence, at: new Date().toISOString(), browser: await page.send('Browser.getVersion'), model: 'Xenova/all-MiniLM-L6-v2 quantized, 384 dimensions', measurements: [] };
const text = id => page.evaluate(id => document.getElementById(id).textContent, id);

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
 * Turn a wait that ran out of budget into a report of which phase stalled and why: elapsed ms against
 * the budget plus the page's last #status line, so contention (status still mid-work) is
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
 * Wait for one page phase with an explicit budget and a label. Every wait in this driver goes through
 * here: the label names the phase a timeout stalled in, and the budget is a value this file derives
 * from the full gate's allowance rather than waitFor's default.
 */
async function waitForPhase(page, predicate, { phase, budgetMs, stalledHint = 'still working => host contention; unchanged since the action => page hang' }) {
  const start = Date.now();
  try {
    await page.waitFor(predicate, { timeout: budgetMs, label: phase });
  } catch (error) {
    throw await timedOutAfter(page, error, { phase, elapsedMs: Date.now() - start, budgetMs, stalledHint });
  }
  const elapsedMs = Date.now() - start;
  console.log(`Phase '${phase}' finished in ${elapsedMs} ms of its ${budgetMs} ms budget`);
  return elapsedMs;
}

async function query(value) {
  await page.type('#query', value);
  await page.click('#run');
  // Encoding the query shares the contested host with everything else, so this is a page phase on the
  // same budget as the storage probes, not a click-latency wait.
  await waitForPhase(
    page,
    () => document.querySelectorAll('#results li').length === 5 && !document.querySelector('#run').disabled,
    { phase: `query results for ${JSON.stringify(value)}`, budgetMs: PAGE_WORK_WAIT_MS, stalledHint: 'results still encoding/searching => host contention; unchanged since the click => page hang' },
  );
  return { query: value, timing: await text('query-timing'), results: await page.evaluate(() => [...document.querySelectorAll('#results li')].map(li => ({ title: li.querySelector('h3').textContent, score: li.querySelector('.detail').textContent }))) };
}
try {
  await page.send('Network.enable');
  await page.goto(url);
  assert.equal(await page.evaluate(() => document.querySelector('#run').disabled), true);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(r => /vendor|models|vectors-/.test(r.name))), false, 'No model, runtime or vector download before click');
  await page.screenshot(`${evidence}/before.png`);
  await page.click('#load');
  await waitForPhase(page, () => document.querySelector('#status').textContent.startsWith('Ready:'), { phase: 'explicit load of the 250-passage corpus', budgetMs: READY_WAIT_MS, stalledHint: 'status still loading => host contention; unchanged since the click => page hang' });
  assert.match(await text('storage'), /250 passages and vectors/);
  const first = await query('How do plants turn sunlight into food?');
  assert.ok(first.results.slice(0, 3).some(r => /Photosynthesis/i.test(r.title)), 'Meaningful unseen free-text query finds photosynthesis');
  report.measurements.push({ count: 250, load: await text('load-timing'), online: first });
  await page.screenshot(`${evidence}/online.png`, { fullPage: true });
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await waitForPhase(page, () => !navigator.onLine, { phase: 'offline network emulation', budgetMs: PAGE_WORK_WAIT_MS, stalledHint: 'network emulation applied but the page still reports online => page hang' });
  assert.equal(await page.evaluate(async () => { try { await fetch('./data/source.json?offline-proof', { cache: 'no-store' }); return false; } catch { return true; } }), true, 'Actual fetch must fail, not just a cosmetic offline label');
  const offline = await query('How do plants turn sunlight into food?');
  assert.deepEqual(offline.results, first.results, 'Network-off ranking and scores exactly match');
  const newOffline = await query('What makes the ground shake during an earthquake?');
  assert.ok(newOffline.results.slice(0, 3).some(r => /Earthquake/i.test(r.title)), 'A new offline question is encoded, not a cached answer');
  assert.match(await text('connection'), /offline/);
  report.measurements[0].offline = offline;
  report.measurements[0].newOffline = newOffline;
  await page.screenshot(`${evidence}/offline.png`, { fullPage: true });
  // A failed offline size switch must not destroy the committed smaller corpus.
  // Real keyboard selection, then load a different database size.
  await page.click('#size');
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await page.evaluate(() => document.querySelector('#size').value), '2000');
  await page.click('#load');
  // A load phase, the class that measured 242.8s: a 2,000-passage load must fail while offline.
  await waitForPhase(page, () => document.querySelector('#status').textContent.startsWith('Load failed:'), { phase: 'offline 2,000-passage load fails', budgetMs: READY_WAIT_MS, stalledHint: 'status still loading => host contention; unchanged since the click => page hang' });
  const retained = await query('How do plants turn sunlight into food?');
  assert.deepEqual(retained.results, first.results, 'Failed replacement retains committed corpus');
  assert.match(retained.timing, /250 passages/);
  report.failedOfflineReplacementRetainedData = true;
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  // Throw after clear + some writes are queued: synchronous errors must abort too.
  await page.evaluate(() => {
    window.originalAdd = IDBObjectStore.prototype.add;
    let writes = 0;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'vectors' && ++writes === 51) throw new DOMException('Injected write failure', 'DataCloneError');
      return window.originalAdd.apply(this, args);
    };
  });
  await page.click('#load');
  // The full gate failed this wait at waitFor's 15s default after the 242.8s load above (idb-vector-g85a).
  await waitForPhase(page, () => document.querySelector('#status').textContent.includes('Injected write failure'), { phase: 'injected write failure during the 2,000-passage load', budgetMs: READY_WAIT_MS, stalledHint: 'status still loading => host contention; unchanged since the click => page hang' });
  await page.evaluate(() => { IDBObjectStore.prototype.add = window.originalAdd; });
  assert.deepEqual((await query('How do plants turn sunlight into food?')).results, first.results, 'Synchronous write failure rolls back clear and partial writes');
  report.synchronousWriteFailureRolledBack = true;
  await page.click('#load');
  await waitForPhase(page, () => document.querySelector('#status').textContent.startsWith('Ready: 2,000'), { phase: '2,000-passage load after synchronous write failure', budgetMs: READY_WAIT_MS, stalledHint: 'status still loading => host contention; unchanged since the click => page hang' });
  report.measurements.push({ count: 2000, load: await text('load-timing'), online: await query('How do plants turn sunlight into food?') });
  await page.screenshot(`${evidence}/large.png`, { fullPage: true });
  await page.goto(url);
  // The stored-corpus probe is asynchronous, so #storage is empty until it finishes: reading it
  // straight after goto raced a 2,000-record IndexedDB read against the navigation and saw '' under
  // load, failing the full gate for an unrelated branch. Wait for the probe's own completion signal.
  await waitForPhase(page, () => document.documentElement.dataset.storageProbe === 'done', { phase: 'stored corpus probe', budgetMs: PAGE_WORK_WAIT_MS, stalledHint: 'the 2,000-record IndexedDB read is still running => host contention; no probe after navigation => page hang' });
  assert.match(await text('storage'), /2,000 passages already stored/);
  assert.equal(await page.evaluate(() => document.querySelector('#run').disabled), true, 'Reload requires explicit model restoration');
  await page.click('#load');
  await waitForPhase(page, () => document.querySelector('#status').textContent.startsWith('Ready: restored'), { phase: 'restore of stored 2,000-passage corpus', budgetMs: READY_WAIT_MS, stalledHint: 'status still restoring => host contention; unchanged since the click => page hang' });
  report.restore = await text('load-timing');
  await query('What makes the ground shake during an earthquake?');
  for (const width of [390, 844]) {
    await page.emulateViewport({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px`);
  }
  await page.screenshot(`${evidence}/mobile.png`, { fullPage: true });
  report.origins = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map(r => new URL(r.name).origin))]);
  assert.deepEqual(report.origins, [new URL(url).origin], 'No third-party runtime requests');
  await page.click('#clear');
  await waitForPhase(page, () => document.querySelector('#status').textContent.startsWith('Stored passages, vectors and model cache removed'), { phase: 'clear of stored passages, vectors and model cache', budgetMs: PAGE_WORK_WAIT_MS, stalledHint: 'still deleting => host contention; unchanged since the click => page hang' });
  assert.equal(await page.evaluate(async () => { const cache = await caches.open('transformers-cache'); return (await cache.keys()).filter(r => r.url.includes('/demo/models/')).length; }), 0);
  await page.goto(url);
  // The same probe, in the direction that cannot be waited for by text: '' is also the pre-read
  // state, and #load is enabled from the markup, so neither can stand in for the read. Wait for
  // data-storage-probe, which demo/app.js sets only after the metadata read has finished.
  await waitForPhase(page, () => document.documentElement.dataset.storageProbe === 'done', { phase: 'storage probe after clear', budgetMs: PAGE_WORK_WAIT_MS, stalledHint: 'the empty-store IndexedDB read is still running => host contention; no probe after navigation => page hang' });
  assert.equal(await text('storage'), '');
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.stack;
  report.status = await text('status').catch(() => 'unavailable');
  console.error(report);
  throw error;
} finally {
  await writeFile(`${evidence}/report.json`, JSON.stringify(report, null, 2));
  await page.close();
  local?.server.close();
}
