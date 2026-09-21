import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { serve } from '../tools/wiki-demo-server.mjs';
import { launch } from './lib/cdp.mjs';
const output = process.env.COMPUTE_OUTPUT || '/tmp/idb-vector-compute';
await mkdir(output, { recursive: true });
const local = process.env.COMPUTE_URL ? null : await serve();
const url = process.env.COMPUTE_URL || local.url.replace('/demo/index.html', '/demo/compute/index.html');
const browserArgs = process.env.COMPUTE_BROWSER_ARGS ? JSON.parse(process.env.COMPUTE_BROWSER_ARGS) : [];
const page = await launch({ browserArgs });
try {
  const conditions = {
    commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    diff: execFileSync('git', ['diff', '--stat']).toString().trim(),
    url, browserArgs, browser: await page.send('Browser.getVersion'),
    hardware: { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ram: os.totalmem(), platform: os.platform(), release: os.release() },
    loadStart: os.loadavg(), started: new Date().toISOString(),
  };
  await page.goto(url);
  // Drive native controls, not a call to the benchmark function.
  await page.click('#run');
  await page.waitFor(() => window.computeReport || window.computeError, { timeout: 240000 });
  assert.equal(await page.evaluate(() => window.computeError), null);
  const report = await page.evaluate(() => window.computeReport);
  conditions.loadEnd = os.loadavg();
  await writeFile(`${output}/measurement.json`, JSON.stringify({ conditions, report }, null, 2));
  assert.equal(report.count, 100000);
  for (const backend of Object.values(report.storage)) if (!backend.unavailable) assert.equal(backend.roundTripExact, true);
  assert.ok(!report.engines.wasm.unavailable, report.engines.wasm.unavailable);
  for (const query of report.queries) {
    assert.equal(query.results.library.comparison.scoreErrorScope, 'shared top-k only');
    assert.equal(query.results.wasm.comparison.scoreErrorScope, 'all corpus scores');
  }
  for (const query of report.queries) for (const result of Object.values(query.results)) {
    assert.equal(result.comparison.orderedTopKMatch, true, JSON.stringify(result));
    assert.ok(result.comparison.maxAbsoluteScoreError < 1e-5);
  }
  assert.equal(report.queries[0].results.library.top[0].id, 7);
  await page.screenshot(`${output}/results.png`, { fullPage: true });
  await page.emulateViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot(`${output}/mobile.png`);
  // A deliberate score mutation must be rejected by the exact comparison instrument.
  const checks = await page.evaluate(async () => {
    const { corpus, cpuScores, topK, compare, wasmEngine, gpuEngine } = await import('./engines.js');
    const x = corpus(100, 32), q = x.slice(0, 32), scores = cpuScores(x, q), ref = topK(scores);
    const mutant = Float64Array.from(scores, s => -s);
    const w = await wasmEngine(x, 32);
    const match = compare(ref, topK(w.run(q)), scores, w.run(q));
    // Exact ties: common stable ID ordering. Non-unit vectors exercise cosine, not just dot.
    const ties = new Float32Array(32 * 12); for (let i = 0; i < 12; i++) ties[i * 32] = i + 1;
    const tq = new Float32Array(32); tq[0] = 2;
    const tw = await wasmEngine(ties, 32);
    // Deliberately resolvable in double but not Float32: report the actual lost neighbours.
    const near = new Float32Array(12 * 128), nq = new Float32Array(128); nq[0] = 1;
    for (let id = 0; id < 12; id++) { near[id * 128] = 1; near[id * 128 + 1] = (12 - id) * 1e-6; }
    const ns = cpuScores(near, nq), nr = topK(ns), nw = await wasmEngine(near, 128);
    const nearTies = { reference: nr, wasm: { top: topK(nw.run(nq)), comparison: compare(nr, topK(nw.run(nq)), ns, nw.run(nq)) } };
    let ng;
    try {
      ng = await gpuEngine(near, 128); const gs = await ng.run(nq);
      nearTies.gpu = { top: topK(gs), comparison: compare(nr, topK(gs), ns, gs) };
    } catch (error) { nearTies.gpu = { unavailable: error.message }; }
    finally { ng?.close(); }
    return { mutant: compare(ref, topK(mutant), scores, mutant), match, ties: topK(tw.run(tq)).map(x => x.id), nearTies };
  });
  assert.equal(checks.mutant.orderedTopKMatch, false);
  assert.equal(checks.match.orderedTopKMatch, true);
  assert.deepEqual(checks.ties, [0,1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(checks.nearTies.reference.map(x => x.id), [11,10,9,8,7,6,5,4,3,2]);
  // Below 1, adjacent Float32 values are 2^-24 apart (above 1: 2^-23).
  checks.nearTies.float32SpacingBelowOne = 2 ** -24;
  for (const path of ['wasm', 'gpu']) if (!checks.nearTies[path].unavailable) {
    const result = checks.nearTies[path];
    assert.deepEqual(result.top.map(x => x.id), [0,1,2,3,4,5,6,7,8,9]);
    assert.ok(result.top.every(x => x.score === 1));
    assert.equal(result.comparison.orderedTopKMatch, false);
    assert.equal(result.comparison.overlap, 0.8);
    assert.ok(result.comparison.maxAbsoluteScoreError > 0);
    assert.ok(result.comparison.maxAbsoluteScoreError < checks.nearTies.float32SpacingBelowOne);
  }
  await writeFile(`${output}/checks.json`, JSON.stringify(checks, null, 2));
  console.log(JSON.stringify({ output, gpu: report.engines.gpu, storage: report.storage, queries: report.queries.map(q => Object.fromEntries(Object.entries(q.results).map(([k,v]) => [k, v.ms]))) }, null, 2));
} finally { await page.close(); if (local) await new Promise(resolve => local.server.close(resolve)); }
