import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { serve } from '../tools/demo-server.mjs';
import { launch } from '../tests/lib/cdp.mjs';
import * as pure from '../test-harness/quantized-pass.js';

// idb-vector-kuc.6: measure compact candidate passes (SQ8 int8 / 1-bit sign / coarse buckets)
// against an exact eligible oracle in a real Chromium page, then exact Float64 rerank.
// Research only: no index strategy is implemented or chosen here.

const specs = [
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
        budgets: [100, 300, 1000], repetitions: spec.repetitions ?? 3, predicate,
      }));
      // Free the biggest structures before building the next corpus.
      vectors = null; queries = null;
    }
    return results;
  }, specs);

  assert.equal(measurements.length, specs.length);
  for (const result of measurements) {
    assert.equal(result.methods.exact.meanRecallAt10, 1);
    for (const method of ['sq8', 'sign', 'bucket']) {
      assert.ok(result.methods[method].medianMs > 0, `${result.name} ${method} latency`);
      assert.ok(result.methods[method].meanRecallAt10 >= 0);
      for (const budget of [100, 300, 1000]) {
        const entry = result.methods[method].perBudget[budget];
        assert.ok(entry.recallAt10 <= entry.candidateCeilingAt10 + 1e-12, `${result.name} ${method}@${budget} recall exceeds ceiling`);
      }
    }
  }
  const filtered = measurements.find(row => row.name === 'uniform-100k-128-filtered');
  assert.ok(filtered.predicate.selectivity > 0 && filtered.predicate.selectivity < 0.02);

  const report = {
    observedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    diff: execFileSync('git', ['diff', '--stat']).toString().trim(),
    browser: await page.send('Browser.getVersion'),
    cpu: os.cpus()[0].model, load: os.loadavg(),
    conditions: 'Fresh headless Chromium profile; all corpora generated in-page from seeded generators (real MiniLM corpus fetched from the served repo copy); candidate codes built in memory simulating a compact side-store; rerank reads resident originals, NOT IndexedDB records; exact baseline computes norms inline like the library scan; warm medians over 10 queries, 3 order-rotated repetitions (1 for the filtered leg); single process, no p95 or cold-disk claim.',
    referenceBaselines: {
      exactScan100k128Ms: 941.6, batchedRead100k128Ms: 796.3, metadataIndex1pctMs: 13.5,
      note: 'Chrome 152 / Ryzen 9 9955HX from reports/browser-analysis.md; this run is Chrome on this VM, so compare ratios, not absolute numbers.',
    },
    nodeCrosscheck: { name: nodeTiny.name, exactRecall: nodeTiny.methods.exact.meanRecallAt10, sq8Recall: nodeTiny.methods.sq8.meanRecallAt10 },
    measurements,
  };
  await writeFile('reports/quantized-candidate-pass.json', JSON.stringify(report, null, 2) + '\n');
  for (const result of measurements) {
    const m = result.methods;
    console.log(`${result.name} (n=${result.count}, d=${result.dims}${result.predicate ? `, filtered ${(result.predicate.selectivity * 100).toFixed(1)}%` : ''}): ` +
      `exact ${m.exact.medianMs.toFixed(1)}ms | ` +
      `sq8 ${m.sq8.medianMs.toFixed(1)}ms r@10=${m.sq8.meanRecallAt10.toFixed(3)} | ` +
      `sign ${m.sign.medianMs.toFixed(1)}ms r@10=${m.sign.meanRecallAt10.toFixed(3)} | ` +
      `bucket ${m.bucket.medianMs.toFixed(1)}ms r@10=${m.bucket.meanRecallAt10.toFixed(3)} | ` +
      `build sq8/sign/bucket ${result.build.sq8Ms.toFixed(0)}/${result.build.signMs.toFixed(0)}/${result.build.bucketsMs.toFixed(0)}ms`);
  }
  console.log('Report: reports/quantized-candidate-pass.json');
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
}
