import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { launch } from '../tests/lib/cdp.mjs';
import { serve } from './wiki-demo-server.mjs';
import { reportTarget } from './report-target.mjs';
import { fitWhitening } from '../utils/geometry.js';

// Exploratory page-level labels: never infer relevance from a ranking under test.
const root = new URL('../', import.meta.url);
const sourceBytes = await readFile(new URL('demo/data/source.json', root));
const labelBytes = await readFile(new URL('tests/fixtures/wikipedia-relevance.json', root));
const passageBytes = await readFile(new URL('demo/data/passages-2000.json', root));
const vectorBytes = await readFile(new URL('demo/data/vectors-2000.f32', root));
const source = JSON.parse(sourceBytes), labels = JSON.parse(labelBytes), passages = JSON.parse(passageBytes);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(vectorBytes), source.artifacts['2000'].vectorSha256, 'corpus vector provenance');
assert.equal(vectorBytes.byteLength, passages.length * source.dimensions * 4);
const vectors = new Float32Array(vectorBytes.buffer, vectorBytes.byteOffset, vectorBytes.byteLength / 4);
const titles = [...new Set(passages.map(row => row.title))];
const heldOut = new Set(titles.filter((_, index) => index % 4 === 0));
const train = [], eligible = [];
for (let index = 0; index < passages.length; index++) {
  const vector = Array.from(vectors.subarray(index * source.dimensions, (index + 1) * source.dimensions));
  const row = { index, title: passages[index].title, vector };
  (heldOut.has(row.title) ? eligible : train).push(row);
}
assert.equal(new Set(train.map(row => row.title)).size + heldOut.size, titles.length);
assert.ok(labels.queries.length >= 10);
assert.ok(labels.queries.every(row => heldOut.has(row.title)));
const relevant = Object.fromEntries(labels.queries.map(row => [row.title, eligible.filter(candidate => candidate.title === row.title).length]));
assert.ok(Object.values(relevant).every(count => count > 0));

const server = await serve();
let page, queryVectors;
try {
  page = await launch();
  await page.goto(server.url);
  queryVectors = await page.evaluate(async queries => {
    const { createEncoder } = await import('./encoder.js');
    const encode = await createEncoder();
    const result = [];
    for (const query of queries) {
      const [vector] = await encode([query]);
      result.push(vector);
    }
    return result;
  }, labels.queries.map(row => row.query));
} finally {
  await page?.close();
  await new Promise(resolve => server.server.close(resolve));
}
assert.equal(queryVectors.length, labels.queries.length);
assert.ok(queryVectors.every(vector => vector.length === source.dimensions && vector.every(Number.isFinite)));

const fitStart = performance.now();
const mean = new Float64Array(source.dimensions);
for (const { vector } of train) for (let i = 0; i < mean.length; i++) mean[i] += vector[i] / train.length;
const centeredFitMs = performance.now() - fitStart;
const whiteStart = performance.now();
const whitening = fitWhitening(train.map(row => row.vector));
const whiteningFitMs = performance.now() - whiteStart;
const centered = vector => vector.map((value, i) => value - mean[i]);
const methods = {
  raw: { version: 'raw-cosine-v1', transform: vector => vector, fitMs: 0 },
  centered: { version: 'mean-center-v1', transform: centered, fitMs: centeredFitMs },
  whitened: { version: 'cholesky-whiten-v1-ridge-1e-6', transform: vector => whitening.transform(vector), fitMs: whiteningFitMs },
};
for (const method of Object.values(methods)) {
  const start = performance.now();
  method.candidates = eligible.map(row => ({ ...row, vector: method.transform(row.vector) }));
  method.prepareMs = performance.now() - start;
}
const score = (a, b) => {
  let dot = 0, a2 = 0, b2 = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; a2 += a[i] * a[i]; b2 += b[i] * b[i]; }
  return dot / Math.sqrt(a2 * b2);
};
const rows = labels.queries.map(({ query, title }, i) => {
  const methodsForQuery = {};
  for (const [name, method] of Object.entries(methods)) {
    const start = performance.now();
    const vector = method.transform(queryVectors[i]);
    const top = method.candidates.map(row => ({ index: row.index, title: row.title, similarity: score(vector, row.vector) }))
      .sort((a, b) => b.similarity - a.similarity || a.index - b.index).slice(0, 10);
    const searchMs = performance.now() - start;
    const firstRelevantRank = top.findIndex(item => item.title === title) + 1;
    const hits = top.filter(item => item.title === title).length;
    methodsForQuery[name] = { searchMs, top, firstRelevantRank, hits, eligibleRecallAt10: hits / relevant[title] };
  }
  const rawKeys = new Set(methodsForQuery.raw.top.map(item => item.index));
  for (const method of Object.values(methodsForQuery)) method.neighbourOverlapAt10 = method.top.filter(item => rawKeys.has(item.index)).length / 10;
  return { query, targetTitle: title, relevantEligible: relevant[title], methods: methodsForQuery };
});
const summarize = name => {
  const samples = rows.map(row => row.methods[name]);
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  return {
    mrrAt10: samples.reduce((sum, row) => sum + (row.firstRelevantRank ? 1 / row.firstRelevantRank : 0), 0) / samples.length,
    hitAt1: samples.filter(row => row.firstRelevantRank === 1).length / samples.length,
    hitAt10: samples.filter(row => row.firstRelevantRank > 0).length / samples.length,
    eligibleRecallAt10: samples.reduce((sum, row) => sum + row.eligibleRecallAt10, 0) / samples.length,
    neighbourOverlapAt10: samples.reduce((sum, row) => sum + row.neighbourOverlapAt10, 0) / samples.length,
    medianQuerySearchMs: median(samples.map(row => row.searchMs)),
    fitMs: methods[name].fitMs,
    prepareEligibleMs: methods[name].prepareMs,
  };
};
const report = {
  observedAt: new Date().toISOString(), model: source.model, revision: source.revision, runtime: source.runtime,
  dimensions: source.dimensions, regularization: whitening.regularization,
  provenance: { corpusVectorsSha256: sha256(vectorBytes), corpusPassagesSha256: sha256(passageBytes),
    labelsSha256: sha256(labelBytes), sourceManifestSha256: sha256(sourceBytes), annotation: labels.annotation, split: labels.split },
  trainPassages: train.length, eligiblePassages: eligible.length, trainPages: titles.length - heldOut.size,
  eligiblePages: heldOut.size, queryCount: rows.length,
  conditions: 'Fresh local headless Chromium encoder for questions; Node exhaustive cosine on committed f32 corpus vectors promoted to Float64; no IndexedDB timing or p95 claim. Query search time excludes browser model encoding and one-time fit/preparation. Single process, no confidence interval.',
  transformVersions: Object.fromEntries(Object.entries(methods).map(([name, method]) => [name, method.version])),
  metrics: Object.fromEntries(Object.keys(methods).map(name => [name, summarize(name)])),
  rows,
};
// The report goes to a unique per-run temp directory by default (a fixed os.tmpdir() name let two
// concurrent runs clobber one report - idb-vector-006): reports/preprocessing-relevance.json is
// TRACKED, and writing it here advances its nsec ctime, which fleet-check's worktree digest reads
// as a mid-run tree mutation (STALE).
// Regenerate the tracked report deliberately with PREPROCESSING_RELEVANCE_REPORT=reports/preprocessing-relevance.json.
const target = reportTarget(process.env.PREPROCESSING_RELEVANCE_REPORT, 'idb-preprocessing-', 'preprocessing-relevance.json');
try {
  await writeFile(target.path, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ queryCount: report.queryCount, trainPassages: report.trainPassages,
    eligiblePassages: report.eligiblePassages, metrics: report.metrics }));
  // Only a pinned report survives the run; an ephemeral one is removed with its directory.
  if (!target.dir) console.log(`Report: ${target.path}`);
} finally {
  if (target.dir) await rm(target.dir, { recursive: true, force: true });
}
