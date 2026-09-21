import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/cdp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const corpora = (process.env.IDB_REAL_CORPORA || 'glove25-10000,glove25-100000,glove25-1183514,wiki-api-10000').split(',');
const methods = process.env.IDB_REAL_METHODS?.split(',') || ['library', 'ivf'];
assert.ok(methods.length && methods.every(m => ['library', 'ivf'].includes(m)));
const allowed = new Map(['index.js', 'utils/sortedarray.js', 'utils/packed-snapshot.js', 'utils/geometry.js', 'test-harness/real-vectors.js', 'test-harness/real-vectors.html'].map(f => ['/' + f, path.join(root, f)]));
const manifests = [];
for (const corpus of corpora) {
  assert.match(corpus, /^(glove25|wiki-api)-[0-9]+$/);
  const directory = path.join(root, '.cache/real-vectors', corpus);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
  assert.equal(manifest.name, corpus);
  manifests.push(manifest);
  for (const file of ['manifest.json', 'vectors.f32', 'cells.u32']) allowed.set(`/data/${corpus}/${file}`, path.join(directory, file));
}
const server = createServer(async (req, res) => {
  const file = allowed.get(new URL(req.url, 'http://localhost').pathname);
  if (!file) { res.writeHead(404).end(); return; }
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.html') ? 'text/html' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch { res.writeHead(500).end('Dataset unavailable'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const url = `http://127.0.0.1:${server.address().port}`;
const output = process.env.IDB_REAL_REPORT || '/tmp/idb-vector-real-measurements.json';
const evidence = path.dirname(output);
await mkdir(evidence, { recursive: true });
async function disk(directory) {
  let logicalBytes = 0, allocatedBytes = 0, files = 0;
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else { const s = await stat(file); logicalBytes += s.size; allocatedBytes += s.blocks * 512; files++; }
    }
  }
  await walk(directory);
  return { logicalBytes, allocatedBytes, files };
}
const report = {
  startedAt: new Date().toISOString(), harnessCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  trackedDiff: execFileSync('git', ['diff', '--stat'], { cwd: root }).toString().trim(),
  hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramBytes: os.totalmem(), platform: os.platform(), release: os.release() },
  loadStart: os.loadavg(),
  condition: 'Real vectors, 40 held-out queries per setting, k10 cosine. Fresh Chromium profile per corpus/approach, same origin, bulk writes completed before queries. Warm/recent-write filesystem; shared machine. CPU only; CDP helper disables GPU. IVF settings order rotates per query. p95 is nearest-rank over 40 different queries, not repeated trials.',
  diskCondition: 'Actual files under owned profile/Default/IndexedDB, measured with stat after 1s idle while browser alive; logical bytes and allocated blocks. Entire database including records, indexes, WAL/compaction residue, not isolated index bytes or quota estimate. No forced compaction or cold storage claim.',
  buildCondition: 'Native IndexedDB add in 1000-record transactions for BOTH approaches, not VectorDB.insert throughput. Library schema includes its unused vector-array index; IVF replaces that with cell index and persists centroids. IVF offline NumPy training/full assignment timed separately and added to totalBuildMs. Input download/checksum excluded.',
  corpora: manifests, runs: [],
};
try {
  for (const corpus of corpora) for (const method of methods) {
    const profile = await mkdtemp(path.join(os.tmpdir(), 'idb-real-profile-'));
    let page;
    try {
      page = await launch({ width: 1200, height: 850, profile });
      report.browser = await page.send('Browser.getVersion');
      await page.goto(`${url}/test-harness/real-vectors.html?${new URLSearchParams({ corpus, method })}`);
      // Permanent negative control: oracle validation must reject an intentionally disjoint top ten.
      assert.equal(await page.evaluate(async () => {
        const { assertExact, recall } = await import('/test-harness/real-vectors.js');
        const ids = Array.from({ length: 10 }, (_, i) => i);
        if (recall(ids, ids) !== 1 || recall(ids, ids.map(x => x + 20)) !== 0) return false;
        try { assertExact(ids, { ids: ids.map(x => x + 20), acceptableIds: ids.map(x => x + 20) }); }
        catch (e) { return e.message.startsWith('Exact recall failed'); }
        return false;
      }), true, 'recall guard must fail on disjoint IDs');
      await page.screenshot(path.join(evidence, `${corpus}-${method}-before.png`));
      console.log(`Measuring ${corpus} / ${method}`);
      await page.click('#run');
      await page.waitFor(() => window.measurement || window.measurementError, { timeout: 1800000, label: `${corpus}/${method}` });
      const error = await page.evaluate(() => window.measurementError || null);
      assert.equal(error, null, `${corpus}/${method}`);
      const result = await page.evaluate(() => window.measurement);
      assert.equal(result.measurements.length, method === 'ivf' ? 160 : 40);
      assert.equal(await page.evaluate(() => document.querySelectorAll('#results tr').length), method === 'ivf' ? 4 : 1);
      await page.screenshot(path.join(evidence, `${corpus}-${method}-after.png`));
      await new Promise(resolve => setTimeout(resolve, 1000));
      result.disk = await disk(path.join(profile, 'Default/IndexedDB'));
      assert.ok(result.disk.logicalBytes > 0, 'Actual IndexedDB files must exist');
      result.finishedAt = new Date().toISOString();
      report.runs.push(result);
      await writeFile(output, JSON.stringify(report, null, 2) + '\n'); // retain completed sizes if a larger run fails
      console.log(JSON.stringify({ corpus, method, buildMs: result.buildMs, disk: result.disk, summary: result.summary }));
    } finally { await page?.close(); await rm(profile, { recursive: true, force: true }); }
  }
  report.finishedAt = new Date().toISOString(); report.loadEnd = os.loadavg();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`PASS: ${report.runs.length} browser runs; raw measurements and screenshots: ${output}`);
} finally { await new Promise(resolve => server.close(resolve)); }
