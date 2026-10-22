import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { serve } from '../tools/demo-server.mjs';
import { launch } from '../tests/lib/cdp.mjs';
import { reportTarget } from '../tools/report-target.mjs';
import * as pure from '../test-harness/quantized-pass.js';

// idb-vector-kuc.6: measure compact candidate passes (SQ8 int8 / 1-bit sign / coarse buckets)
// against an exact eligible oracle in a real Chromium page, then exact Float64 rerank.
// Research only: no index strategy is implemented or chosen here.

// A driver that a gate might some day run must not write a tracked file: fleet-check's worktree
// digest fingerprints every tracked file, so an in-place report write records STALE even when the
// content is identical (idb-vector-2ox). The report goes to a unique per-run temp directory (two
// concurrent runs must never share the path, idb-vector-8oy) unless asked for, and the directory
// is removed in the finally below.
const report = reportTarget(process.env.IDB_VECTOR_QUANTIZED_REPORT, 'idb-vector-quantized-');
const reportPath = report.path;

// IDB_VECTOR_QUANTIZED_SMOKE=1 runs the same code path on tiny corpora, to check the driver itself
// (and its output path) in seconds instead of spending a bounded run on 500 MB of writes.
const smoke = Boolean(process.env.IDB_VECTOR_QUANTIZED_SMOKE);
const specs = smoke
  ? [
    { name: 'smoke-uniform-2k-32', kind: 'uniform', count: 2000, dims: 32, seed: 42, bucketK: 32, bucketSample: 2000, budgets: [50, 100], repetitions: 1 },
    { name: 'smoke-filtered-2k-32', kind: 'uniform', count: 2000, dims: 32, seed: 42, bucketK: 32, bucketSample: 2000, budgets: [50, 100], repetitions: 1, predicate: { modulo: 100, value: 7 } },
  ]
  : [
    { name: 'uniform-100k-128', kind: 'uniform', count: 100000, dims: 128, seed: 42, bucketK: 256 },
    { name: 'adversarial-100k-128', kind: 'adversarial', count: 100000, dims: 128, seed: 7, bucketK: 256 },
    { name: 'real-minilm-2000-384', kind: 'real', count: 2000, dims: 384, bucketK: 256, bucketSample: 2000 },
    { name: 'uniform-100k-384', kind: 'uniform', count: 100000, dims: 384, seed: 43, bucketK: 256 },
    { name: 'uniform-20k-1536', kind: 'uniform', count: 20000, dims: 1536, seed: 44, bucketK: 64, bucketSample: 5000 },
    { name: 'adversarial-20k-1536', kind: 'adversarial', count: 20000, dims: 1536, seed: 8, bucketK: 64, bucketSample: 5000 },
    { name: 'uniform-100k-128-filtered', kind: 'uniform', count: 100000, dims: 128, seed: 42, bucketK: 256, predicate: { modulo: 100, value: 7 }, repetitions: 1 },
  ];

// Cross-check in pure Node that the exact same module produces a complete result headlessly.
const tiny = pure.uniformCorpus(500, 16, 123, 3);
const nodeTiny = pure.runExperiment({
  name: 'node-crosscheck-500-16', kind: 'uniform',
  vectors: tiny.vectors, queries: tiny.queries,
  count: 500, dims: 16,
  bucketK: 16, bucketSample: 500, budgets: [50, 100], repetitions: 1,
});
assert.equal(nodeTiny.methods.exact.meanRecallAt10, 1);
assert.ok(nodeTiny.methods.sq8.meanRecallAt10 >= 0.9);

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  const measurements = await page.evaluate(async specs => {
    const m = await import('/test-harness/quantized-pass.js');
    const results = [];
    for (const spec of specs) {
      let vectors, queries;
      if (spec.kind === 'real') {
        const bytes = await (await fetch('/demo/data/vectors-2000.f32')).arrayBuffer();
        if (bytes.byteLength !== spec.count * spec.dims * 4) throw new Error('real corpus size mismatch');
        vectors = new Float32Array(bytes);
        queries = m.perturbedRealQueries(vectors, spec.count, spec.dims, Math.floor(spec.count * 0.95), 10, 0.25, 11);
      } else if (spec.kind === 'adversarial') {
        ({ vectors, queries } = m.adversarialCorpus(spec.count, spec.dims, spec.seed, 10));
      } else {
        ({ vectors, queries } = m.uniformCorpus(spec.count, spec.dims, spec.seed, 10));
      }
      const predicate = spec.predicate ? (id => id % spec.predicate.modulo === spec.predicate.value) : null;
      results.push(m.runExperiment({
        name: spec.name, kind: spec.kind, vectors, count: spec.count, dims: spec.dims, queries,
        bucketK: spec.bucketK, bucketSample: spec.bucketSample ?? 10000,
        budgets: spec.budgets ?? [100, 300, 1000], repetitions: spec.repetitions ?? 3, predicate,
      }));
      // Free the biggest structures before building the next corpus.
      vectors = null; queries = null;
    }
    return results;
  }, specs);

  assert.equal(measurements.length, specs.length);
  // Timing floors are meaningless on the seconds-long smoke corpora, where a leg can round to 0 ms;
  // the structural assertions hold in both modes.
  const positive = (value, label) => assert.ok(smoke ? value >= 0 : value > 0, label);
  for (const result of measurements) {
    assert.equal(result.methods.exact.meanRecallAt10, 1);
    for (const method of ['sq8', 'sign', 'bucket', 'sq8-postfilter', 'sign-postfilter']) {
      if (!result.methods[method]) continue;
      positive(result.methods[method].medianMs, `${result.name} ${method} latency`);
      assert.ok(result.methods[method].meanRecallAt10 >= 0 && result.methods[method].meanRecallAt10 <= 1, `${result.name} ${method} recall range`);
      assert.ok(result.methods[method].firstCallMs >= 0, `${result.name} ${method} cold call`);
      for (const budget of result.budgets) {
        const entry = result.methods[method].perBudget[budget];
        assert.ok(entry.recallAt10 <= entry.candidateCeilingAt10 + 1e-12, `${result.name} ${method}@${budget} recall exceeds ceiling`);
      }
    }
    assert.ok(result.deleteMicrosPerRow.bucketListLength > 0, `${result.name} delete cost`);
    assert.ok(result.oracle.oracleRows === result.count || result.predicate, `${result.name} oracle rows`);
  }
  // Selected by the predicate, not by the name: the smoke corpus is called 'smoke-filtered-2k-32',
  // which the previous endsWith('-filtered') selector silently missed, skipping every filtered
  // assertion in smoke mode without saying so (idb-vector-1tx).
  const filtered = measurements.find(row => row.predicate);
  if (specs.some(spec => spec.predicate)) {
    assert.ok(filtered, 'a spec declared a predicate but no filtered measurement was checked');
  }
  if (filtered) {
    assert.ok(filtered.predicate.selectivity > 0 && filtered.predicate.selectivity < 0.02);
    // Predicate-before-candidate, measured on the 1%-selective corpus: a pass restricted to the
    // eligible rows holds the whole eligible corpus inside its candidate budget (ceiling 1) and
    // scores 1% of the rows; a pass that ranks the whole corpus first pays the full scan and its
    // candidate list is chosen without regard to the predicate.
    assert.equal(filtered.methods.sq8.meanCandidateCeiling, 1);
    assert.ok(filtered.methods.sq8.medianCandidateMs < filtered.methods['sq8-postfilter'].medianCandidateMs,
      'the masked scan should be cheaper than the full-corpus scan');
    assert.ok(filtered.methods['sq8-postfilter'].meanCandidateCeiling <= filtered.methods.sq8.meanCandidateCeiling);
  }

  // ---- Compact side-store read leg (idb-vector-kuc.6) ----
  // The candidate pass above scores codes that are already resident. What a side-store actually
  // changes in IndexedDB is BYTES READ, so measure the read leg for each representation, plus
  // the cost of fetching originals for the rerank when they live as individual records.
  const sideStore = await page.evaluate(async () => {
    const m = await import('/test-harness/quantized-pass.js');
    const count = 100000, dims = 128;
    const { vectors } = m.uniformCorpus(count, dims, 42, 1);
    const sq8 = m.encodeSq8(vectors, count, dims);
    const sign = m.encodeSign(vectors, count, dims);
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const time = async fn => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

    // One fresh database per representation: its first get is that store's first read in this
    // process (warm page cache, cold structured-clone deserialisation), the rest are warm reads.
    async function packedRead(key, value) {
      const name = `kuc6-side-${crypto.randomUUID()}`;
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore('rows');
      const db = await request(open);
      try {
        const tx = db.transaction('rows', 'readwrite');
        tx.objectStore('rows').put(value, key);
        await complete(tx);
        const get = () => request(db.transaction('rows').objectStore('rows').get(key));
        const cold = await time(get);
        const warm = [];
        for (let i = 0; i < 5; i++) warm.push((await time(get)).ms);
        return { bytes: cold.value.byteLength, coldMs: cold.ms, warmMedianMs: median(warm), warmMs: warm };
      } finally {
        db.close();
        indexedDB.deleteDatabase(name);
      }
    }
    const reads = {
      f32: await packedRead('f32', vectors),
      sq8: await packedRead('sq8', sq8.codes),
      sign: await packedRead('sign', sign.codes),
    };

    // Originals as individual records (the library's current storage shape): 1,000 serial gets,
    // the worst-case candidate budget, is what a rerank costs before any arithmetic.
    const rowsName = `kuc6-rows-${crypto.randomUUID()}`;
    const openRows = indexedDB.open(rowsName, 1);
    openRows.onupgradeneeded = () => openRows.result.createObjectStore('rows');
    const rowsDb = await request(openRows);
    let rerankFetch;
    try {
      for (let offset = 0; offset < count; offset += 2000) {
        const tx = rowsDb.transaction('rows', 'readwrite');
        const store = tx.objectStore('rows');
        for (let id = offset; id < offset + 2000; id++) store.put({ id, embedding: Float64Array.from(vectors.subarray(id * dims, (id + 1) * dims)) }, id);
        await complete(tx);
      }
      const pick = m.mulberry32(5);
      const ids = Array.from({ length: 1000 }, () => Math.floor(pick() * count));
      const serial = await time(async () => {
        let checksum = 0;
        for (const id of ids) checksum += (await request(rowsDb.transaction('rows').objectStore('rows').get(id))).embedding[0];
        return checksum;
      });
      rerankFetch = { keys: ids.length, totalMs: serial.ms, meanMsPerGet: serial.ms / ids.length };
    } finally {
      rowsDb.close();
      indexedDB.deleteDatabase(rowsName);
    }
    return {
      count, dims,
      conditions: 'Each representation written as one packed record into its own fresh database, read back five times (first read = cold deserialisation, warm page cache) after committed writes; individual originals written as 100,000 Float64Array records, then 1,000 serial random gets.',
      reads, rerankFetch,
    };
  });
  for (const key of ['f32', 'sq8', 'sign']) {
    assert.ok(sideStore.reads[key].bytes > 0, `side-store ${key} bytes`);
    positive(sideStore.reads[key].coldMs, `side-store ${key} cold read`);
    positive(sideStore.reads[key].warmMedianMs, `side-store ${key} warm read`);
  }
  assert.ok(sideStore.reads.sq8.bytes * 4 === sideStore.reads.f32.bytes, 'int8 codes should be a quarter of Float32');
  positive(sideStore.rerankFetch.totalMs, 'rerank fetch total');
  positive(sideStore.rerankFetch.meanMsPerGet, 'rerank fetch per get');
  // The composed pipeline is stated for the 100k x 128 corpus the whole report is framed around;
  // the smoke run only checks code paths, so it records no pipeline.
  const base = smoke ? null : measurements.find(row => row.name === 'uniform-100k-128');
  const pipeline = !base ? null : {
    exactPackedF32ReadPlusScanMs: sideStore.reads.f32.warmMedianMs + base.methods.exact.medianMs,
    sq8ScanThen1000OriginalGetsMs: sideStore.reads.sq8.warmMedianMs + base.methods.sq8.medianCandidateMs + sideStore.rerankFetch.totalMs,
    sq8ScanWithOriginalsAlsoPackedMs: sideStore.reads.sq8.warmMedianMs + sideStore.reads.f32.warmMedianMs + base.methods.sq8.medianCandidateMs + base.methods.sq8.medianRerankMs,
    note: 'Composed from legs measured on this run, not one end-to-end query: packed read + resident arithmetic + the fetch the rerank needs. A candidate pass still has to obtain original vectors for exact rerank, either as individual record gets or as a second full packed read.',
  };

  const report = {
    observedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    diff: execFileSync('git', ['diff', '--stat']).toString().trim(),
    browser: await page.send('Browser.getVersion'),
    cpu: os.cpus()[0].model, load: os.loadavg(),
    conditions: 'Two legs. (1) Resident arithmetic: fresh headless Chromium page; all corpora generated in-page from seeded generators (real MiniLM corpus fetched from the served repo copy); candidate codes built in memory simulating a compact side-store; rerank reads resident originals, NOT IndexedDB records; exact baseline computes norms inline like the library scan; warm medians over 10 queries, 3 order-rotated repetitions (1 for the filtered leg); first-call medians are also recorded per method; single process, no p95 or cold-disk claim. Filtered corpora run each compact pass twice: restricted to eligible rows (predicate before candidate) and over the whole corpus with the predicate applied afterwards. (2) Side-store read leg: packed and individual-record reads from IndexedDB, described in its own section.',
    referenceBaselines: {
      exactScan100k128Ms: 941.6, batchedRead100k128Ms: 796.3, metadataIndex1pctMs: 13.5,
      note: 'Chrome 152 / Ryzen 9 9955HX from reports/browser-analysis.md; this run is Chrome on this VM, so compare ratios, not absolute numbers.',
    },
    nodeCrosscheck: { name: nodeTiny.name, exactRecall: nodeTiny.methods.exact.meanRecallAt10, sq8Recall: nodeTiny.methods.sq8.meanRecallAt10 },
    measurements,
    sideStore,
    pipeline,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  for (const result of measurements) {
    const m = result.methods;
    console.log(`${result.name} (n=${result.count}, d=${result.dims}${result.predicate ? `, filtered ${(result.predicate.selectivity * 100).toFixed(1)}%` : ''}): ` +
      `exact ${m.exact.medianMs.toFixed(1)}ms | ` +
      `sq8 ${m.sq8.medianMs.toFixed(1)}ms r@10=${m.sq8.meanRecallAt10.toFixed(3)} | ` +
      `sign ${m.sign.medianMs.toFixed(1)}ms r@10=${m.sign.meanRecallAt10.toFixed(3)} | ` +
      `bucket ${m.bucket.medianMs.toFixed(1)}ms r@10=${m.bucket.meanRecallAt10.toFixed(3)} | ` +
      `build sq8/sign/bucket ${result.build.sq8Ms.toFixed(0)}/${result.build.signMs.toFixed(0)}/${result.build.bucketsMs.toFixed(0)}ms`);
  }
  console.log(`Report: ${reportPath}`);
  const s = sideStore.reads;
  console.log(`side-store read (100k x 128): f32 ${(s.f32.bytes / 1e6).toFixed(1)}MB cold ${s.f32.coldMs.toFixed(1)}ms warm ${s.f32.warmMedianMs.toFixed(1)}ms | ` +
    `sq8 ${(s.sq8.bytes / 1e6).toFixed(1)}MB cold ${s.sq8.coldMs.toFixed(1)}ms warm ${s.sq8.warmMedianMs.toFixed(1)}ms | ` +
    `sign ${(s.sign.bytes / 1e6).toFixed(1)}MB cold ${s.sign.coldMs.toFixed(1)}ms warm ${s.sign.warmMedianMs.toFixed(1)}ms | ` +
    `1000 serial original gets ${sideStore.rerankFetch.totalMs.toFixed(1)}ms`);
  if (pipeline) console.log(`pipeline: exact packed-f32 read + scan ${pipeline.exactPackedF32ReadPlusScanMs.toFixed(1)}ms | sq8 scan + 1000 original gets ${pipeline.sq8ScanThen1000OriginalGetsMs.toFixed(1)}ms`);
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
  if (report.dir) await rm(report.dir, { recursive: true, force: true });
}
