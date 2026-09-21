import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launch } from './lib/cdp.mjs';
import { serve } from '../tools/wiki-demo-server.mjs';
const external = process.argv[2];
const local = external ? null : await serve();
const url = external || local.url;
const evidence = process.env.IDB_DEMO_EVIDENCE || '/tmp/idb-wikipedia-demo';
await mkdir(evidence, { recursive: true });
const page = await launch();
const report = { url, at: new Date().toISOString(), browser: await page.send('Browser.getVersion'), model: 'Xenova/all-MiniLM-L6-v2 quantized, 384 dimensions', measurements: [] };
const text = id => page.evaluate(id => document.getElementById(id).textContent, id);
async function query(value) {
  await page.type('#query', value);
  await page.click('#run');
  await page.waitFor(() => document.querySelectorAll('#results li').length === 5 && !document.querySelector('#run').disabled, { timeout: 60000 });
  return { query: value, timing: await text('query-timing'), results: await page.evaluate(() => [...document.querySelectorAll('#results li')].map(li => ({ title: li.querySelector('h3').textContent, score: li.querySelector('.detail').textContent }))) };
}
try {
  await page.send('Network.enable');
  await page.goto(url);
  assert.equal(await page.evaluate(() => document.querySelector('#run').disabled), true);
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(r => /vendor|models|vectors-/.test(r.name))), false, 'No model, runtime or vector download before click');
  await page.screenshot(`${evidence}/before.png`);
  await page.click('#load');
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Ready:'), { timeout: 180000, label: 'explicit load' });
  assert.match(await text('storage'), /250 passages and vectors/);
  const first = await query('How do plants turn sunlight into food?');
  assert.ok(first.results.slice(0, 3).some(r => /Photosynthesis/i.test(r.title)), 'Meaningful unseen free-text query finds photosynthesis');
  report.measurements.push({ count: 250, load: await text('load-timing'), online: first });
  await page.screenshot(`${evidence}/online.png`, { fullPage: true });
  await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page.waitFor(() => !navigator.onLine);
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
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Load failed:'));
  const retained = await query('How do plants turn sunlight into food?');
  assert.deepEqual(retained.results, first.results, 'Failed replacement retains committed corpus');
  assert.match(retained.timing, /250 passages/);
  report.failedOfflineReplacementRetainedData = true;
  await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await page.click('#load');
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Ready: 2,000'), { timeout: 180000 });
  report.measurements.push({ count: 2000, load: await text('load-timing'), online: await query('How do plants turn sunlight into food?') });
  await page.screenshot(`${evidence}/large.png`, { fullPage: true });
  await page.goto(url);
  assert.match(await text('storage'), /2,000 passages already stored/);
  assert.equal(await page.evaluate(() => document.querySelector('#run').disabled), true, 'Reload requires explicit model restoration');
  await page.click('#load');
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Ready: restored'), { timeout: 180000 });
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
  await page.waitFor(() => document.querySelector('#status').textContent.startsWith('Stored passages, vectors and model cache removed'));
  assert.equal(await page.evaluate(async () => { const cache = await caches.open('transformers-cache'); return (await cache.keys()).filter(r => r.url.includes('/demo/models/')).length; }), 0);
  await page.goto(url);
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
