// The compute lab's numeric contract, in the fast tier: no browser, no host state.
// The browser check (npm run test:compute) drives the real page, the WASM and GPU
// kernels and the storage layouts; these are the pure definitions it relies on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compare, corpus, cpuScores, topK } from '../../demo/compute/engines.js';

test('the synthetic corpus is a deterministic, seed-dependent Float32 stream in [-1, 1)', () => {
  const a = corpus(8, 4, 42);
  assert.ok(a instanceof Float32Array);
  assert.equal(a.length, 32);
  assert.deepEqual([...a], [...corpus(8, 4, 42)]);
  assert.notDeepEqual([...a], [...corpus(8, 4, 43)]);
  for (const value of a) assert.ok(value >= -1 && value < 1, `${value} outside [-1, 1)`);
  assert.ok([...a].some(value => value < 0) && [...a].some(value => value > 0), 'expected both signs');
});

test('cpuScores is cosine similarity, not a bare dot product, with a double reference', () => {
  const values = new Float32Array([3, 0, 0, 4, -1, -1]);
  const query = new Float32Array([10, 0]);
  const scores = cpuScores(values, query);
  assert.ok(scores instanceof Float64Array);
  const reference = [];
  for (let row = 0; row < 3; row++) {
    const x = values[row * 2], y = values[row * 2 + 1];
    const qq = query[0] * query[0] + query[1] * query[1];
    reference.push((x * query[0] + y * query[1]) / Math.sqrt((x * x + y * y) * qq));
  }
  assert.equal(scores[0], 1, 'a parallel row is similarity 1 regardless of magnitude');
  assert.equal(scores[1], 0, 'an orthogonal row is similarity 0');
  for (let row = 0; row < 3; row++) assert.ok(Math.abs(scores[row] - reference[row]) < 1e-12);
  const wide = corpus(4, 128, 7);
  assert.equal(cpuScores(wide, wide.subarray(2 * 128, 3 * 128))[2], 1, 'a row is its own nearest neighbour');
});

test('topK orders by score then ascending id, and refuses non-finite scores', () => {
  const scores = new Float64Array([0.5, 0.9, 0.9, 0.1, -0.2]);
  assert.deepEqual(topK(scores, 3).map(item => item.id), [1, 2, 0]);
  assert.deepEqual(topK(scores, 3).map(item => item.score), [0.9, 0.9, 0.5]);
  assert.equal(topK(scores, 2).length, 2);
  assert.equal(topK(scores).length, 5, 'a k larger than the corpus returns every score');
  assert.throws(() => topK(new Float64Array([1, NaN])), /Non-finite score at 1/);
  assert.throws(() => topK([1, Infinity]), /Non-finite score at 1/);
});

test('compare reports agreement, overlap and error scope, and rejects a negated mutant', () => {
  const scores = new Float64Array([0.1, 0.8, 0.4, -0.3, 0.9, 0.2]);
  const reference = topK(scores, 3);
  const same = compare(reference, topK(scores, 3), scores, Float64Array.from(scores));
  assert.equal(same.orderedTopKMatch, true);
  assert.equal(same.overlap, 1);
  assert.equal(same.maxAbsoluteScoreError, 0);
  assert.equal(same.scoreErrorScope, 'all corpus scores');
  const mutant = Float64Array.from(scores, score => -score);
  const mutated = compare(reference, topK(mutant, 3), scores, mutant);
  assert.equal(mutated.orderedTopKMatch, false);
  assert.equal(mutated.overlap, 0);
  assert.equal(mutated.maxAbsoluteScoreError, 2 * 0.9);
  const partial = compare(reference, [reference[0]], scores);
  assert.equal(partial.scoreErrorScope, 'shared top-k only', 'without full scores only shared neighbours compare');
  assert.equal(partial.overlap, 1 / 3);
  assert.throws(() => compare(reference, topK(scores, 3), scores, scores.slice(0, 2)), /Score count mismatch/);
  const poisoned = Float64Array.from(scores, (score, i) => (i ? score : NaN));
  assert.throws(() => compare(reference, topK(scores, 3), scores, poisoned), /Non-finite candidate score/);
});

test('the 128-D near-tie fixture keeps the double reference the lab compares every engine against', () => {
  const dim = 128, rows = 12;
  const values = new Float32Array(rows * dim), query = new Float32Array(dim);
  query[0] = 1;
  for (let id = 0; id < rows; id++) {
    values[id * dim] = 1;
    values[id * dim + 1] = (rows - id) * 1e-6;
  }
  const scores = cpuScores(values, query);
  assert.deepEqual(topK(scores, 10).map(item => item.id), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  for (const score of scores) assert.ok(score > 0.999999 && score <= 1);
  // Float32 spacing immediately below 1 is 2^-24; the SIMD/GPU kernels round these
  // scores to exactly 1 here, so the recorded neighbour divergence is this fixture's
  // expected outcome rather than a fault in the comparison instrument.
  assert.equal(2 ** -24, 5.960464477539063e-8);
});
