// The high-cardinality packed-snapshot measurement, deliberately OUT of the merger's full gate.
//
// It lives here because it is a benchmark, not a correctness gate: writing 100000x128 vectors in batches
// of 1000 and timing three exact baseline-vs-cache comparisons per corpus took the full gate past 900s at
// host load ~10 (37% of its 2400s allowance) without telling anyone anything the small corpora do not
// (idb-vector-bqw, ADR idb-vector-80j). The full-gate leg keeps the contract checks and a 1000x128
// synthetic corpus, so exactness at practical cardinality is still covered on every landing; this file is
// the size-dependent check, run on a schedule and on changes to the packed-snapshot path
// (.github/workflows/packed-stress.yml), with evidence written to a directory that is KEPT and printed.
//
//   npm run measure:packed-snapshot           # unique temp dir, path printed, artifact kept
//   PACKED_SNAPSHOT_STRESS_DIR=<dir> ...      # write into <dir> instead (CI uploads it)
//   PACKED_SNAPSHOT_STRESS_COUNT=<n> ...      # smaller corpus for a smoke run
//
// One browser, closed in finally. The page work is a single evaluate, so a failure names its check.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';
import { runDir } from '../tools/report-target.mjs';

export function resolveEvidenceDir(configured = process.env.PACKED_SNAPSHOT_STRESS_DIR) {
  return runDir(configured, 'idb-packed-stress-');
}

export function targetFiles(evidenceDir) {
  return {
    reportPath: join(evidenceDir, 'packed-snapshot-stress.json'),
    screenshotPath: join(evidenceDir, 'packed-snapshot-stress.png'),
  };
}

export async function runStress(count = Number(process.env.PACKED_SNAPSHOT_STRESS_COUNT ?? 100000)) {
  assert.ok(Number.isSafeInteger(count) && count >= 1000, `PACKED_SNAPSHOT_STRESS_COUNT must be a safe integer >= 1000; got ${process.env.PACKED_SNAPSHOT_STRESS_COUNT}`);

  const { dir: evidenceDir } = resolveEvidenceDir();
  const startedAt = new Date();

  const { server, url } = await serve();
  let page;
  try {
    page = await launch();
    await page.goto(url);
    const pageStart = Date.now();
    const result = await page.evaluate(async (vectorCount) => {
    const { VectorDB } = await import('/index.js');
    const { vector } = await import('/test-harness/experiment.js');
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const bits = rows => {
      const bytes = new Float64Array(rows.length * 2);
      rows.forEach((row, i) => { bytes[2 * i] = row.key; bytes[2 * i + 1] = row.similarity; });
      return Array.from(new Uint8Array(bytes.buffer)).join(',');
    };
    const timed = async fn => { const start = performance.now(), value = await fn(); return { ms: performance.now() - start, value }; };

    const corpus = { name: `seeded uniform ${vectorCount}x128`, count: vectorCount, dimensions: 128, vector: i => vector(i, 128) };
    const dbName = `snapshot-stress-${crypto.randomUUID()}`;
    const library = new VectorDB({ dbName, vectorPath: 'embedding' });
    await library.query([1]);
    const source = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = await timed(async () => {
      for (let offset = 0; offset < corpus.count; offset += 1000) {
        const tx = source.transaction('vectors', 'readwrite'), done = complete(tx);
        for (let i = offset; i < Math.min(offset + 1000, corpus.count); i++) {
          tx.objectStore('vectors').put({ embedding: corpus.vector(i), id: i }, i + 1);
        }
        await done;
      }
    });
    // Budget equals the encoded payload plus one block of padding, not a corpus-size cap.
    const maxBytes = (corpus.dimensions + 2) * 8 * corpus.count + 1024 * 1024;
    const built = await timed(() => library.createSnapshot({ maxBytes }));
    const cache = built.value;
    if (!(cache.mode === 'snapshot' && cache.bytes <= maxBytes)) throw new Error('stress corpus cache did not fit its explicit byte budget');
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const q = corpus.vector(42 + i);
      let baseline, cached;
      // Alternate the order so neither path systematically pays for the other's cold state.
      if (i % 2) { cached = await timed(() => cache.query(q)); baseline = await timed(() => library.query(q)); }
      else { baseline = await timed(() => library.query(q)); cached = await timed(() => cache.query(q)); }
      if (bits(cached.value.results) !== bits(baseline.value)) throw new Error(`stress query ${42 + i}: cached ranking is not bit-identical to the baseline scan`);
      runs.push({ queryId: 42 + i, baselineMs: baseline.ms, cachedMs: cached.ms, mode: cached.value.mode, byteIdentical: true, keys: cached.value.results.map(x => x.key) });
    }
    const entry = { name: corpus.name, count: corpus.count, dimensions: corpus.dimensions, maxBytes, allocatedBytes: cache.bytes, writeMs: write.ms, buildMs: built.ms, diagnostic: cache.diagnostic, runs };
    cache.close();
    source.close();
    await library.close();
    return entry;
  }, count);
  const pageMs = Date.now() - pageStart;

  const hashesOf = ['index.js', 'utils/packed-snapshot.js', 'utils/sortedarray.js', 'utils/geometry.js', 'tests/packed-snapshot-stress.mjs', 'tools/demo-server.mjs'];
  const report = {
    kind: 'packed-snapshot-stress',
    sourceHashes: Object.fromEntries(await Promise.all(hashesOf.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
    commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    observedAt: startedAt.toISOString(),
    wallMs: pageMs,
    browser: await page.send('Browser.getVersion'),
    cpu: os.cpus()[0].model,
    cores: os.cpus().length,
    load: os.loadavg(),
    condition: 'Fresh headless Chromium profile; seeds written in batches of 1000; three alternating query timings; query IDs 42-44; k10; exact Float64 byte comparison of keys, scores and order; not cold disk and not an isolated host.',
    measured: [result],
    qualityClaim: 'None: the snapshot is a cache over the same records, so identical bytes is the correctness claim; the timings are a reproduction aid, not a benchmark against other libraries.',
  };
  const { reportPath, screenshotPath } = targetFiles(evidenceDir);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await page.screenshot(screenshotPath);
  console.log(JSON.stringify({ evidenceDir, reportPath, corpus: result.name, writeMs: Math.round(result.writeMs), buildMs: Math.round(result.buildMs), runs: result.runs.map(r => ({ queryId: r.queryId, baselineMs: Math.round(r.baselineMs), cachedMs: Math.round(r.cachedMs), byteIdentical: r.byteIdentical })), wallMs: pageMs, load: os.loadavg() }, null, 2));
  console.log(`Evidence kept: ${evidenceDir}`);
  return { evidenceDir, reportPath, screenshotPath, report };
} finally {
  if (page) await page.close();
  await new Promise(resolve => server.close(resolve));
}
}

export function isDirectExecution() {
  if (import.meta.main) return true;
  if (!process.argv[1]) return false;
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectExecution()) {
  await runStress();
} else if (process.argv[1] && path.basename(process.argv[1]).includes('packed-snapshot-stress')) {
  console.error(`Refusing silent skip: target ${process.argv[1]} does not resolve to ${fileURLToPath(import.meta.url)}`);
  process.exit(1);
}
