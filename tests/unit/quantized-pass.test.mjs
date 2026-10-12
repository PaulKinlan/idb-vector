import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POP8, uniformCorpus, adversarialCorpus, encodeSq8, encodeSq8Row, sq8QueryWeights,
  encodeSign, encodeSignRow, signCosineEstimate, signCosineEstimateAt, signBytes,
  trainBuckets, assignBuckets, assignRow, eligibleMask, exactTopK, rerankTopK,
  recallAtK, candidateCeiling, sq8Scan, signScan, bucketCandidates, precomputeNorms,
  runExperiment, perturbedRealQueries,
} from '../../test-harness/quantized-pass.js';

test('SQ8 affine codes reconstruct each coordinate within half a scale step', () => {
  const { vectors } = uniformCorpus(500, 16, 5, 2);
  const sq8 = encodeSq8(vectors, 500, 16);
  assert.equal(sq8.codes.length, 500 * 16);
  for (let i = 0; i < 500; i += 37) for (let d = 0; d < 16; d++) {
    const reconstructed = (sq8.codes[i * 16 + d] + 127) * sq8.scales[d] + sq8.mins[d];
    assert.ok(Math.abs(reconstructed - vectors[i * 16 + d]) <= sq8.scales[d] / 2 + 1e-9);
  }
  const single = encodeSq8Row(vectors, 3, 16, sq8);
  for (let d = 0; d < 16; d++) assert.equal(single[d], sq8.codes[3 * 16 + d]);
});

test('popcount table and sign estimates are exact on known bit patterns', () => {
  assert.equal(POP8[0b11111111], 8);
  assert.equal(POP8[0b10110001], 4);
  const dims = 16, stride = signBytes(dims);
  assert.equal(stride, 2);
  const a = new Uint8Array([0b10110001, 0b00001111]);
  assert.equal(signCosineEstimate(a, a, stride, dims), 1);
  const flipped = new Uint8Array([0b01001110, 0b11110000]);
  assert.equal(signCosineEstimate(a, flipped, stride, dims), -1);
  const packed = new Uint8Array(stride);
  packed.set([0b10110001, 0b00001111]);
  assert.equal(signCosineEstimateAt(a, 0, packed, stride, dims), 1);
});

test('sign row encoding matches the corpus encoder bit for bit', () => {
  const { vectors } = uniformCorpus(64, 24, 9, 1);
  const sign = encodeSign(vectors, 64, 24);
  assert.equal(sign.stride, 3);
  for (let i = 0; i < 64; i += 7) {
    const row = encodeSignRow(vectors, i, 24, sign.stride);
    for (let b = 0; b < 3; b++) assert.equal(row[b], sign.codes[i * 3 + b]);
  }
});

test('exactTopK matches a brute-force sort including eligibility filtering', () => {
  const { vectors, queries } = uniformCorpus(300, 8, 21, 3);
  const mask = eligibleMask(300, id => id % 10 === 3);
  assert.equal(Array.from(mask).filter(Boolean).length, 30);
  for (const query of queries) {
    const brute = [];
    let qn = 0;
    for (let d = 0; d < 8; d++) qn += query[d] ** 2;
    qn = Math.sqrt(qn);
    for (let i = 0; i < 300; i++) {
      if (!mask[i]) continue;
      let dot = 0, norm = 0;
      for (let d = 0; d < 8; d++) { dot += query[d] * vectors[i * 8 + d]; norm += vectors[i * 8 + d] ** 2; }
      brute.push({ index: i, similarity: dot / (qn * Math.sqrt(norm)) });
    }
    brute.sort((x, y) => y.similarity - x.similarity);
    const top = exactTopK(vectors, 300, 8, query, 10, mask);
    assert.deepEqual(top.map(row => row.index), brute.slice(0, 10).map(row => row.index));
    for (let k = 0; k < 10; k++) assert.ok(Math.abs(top[k].similarity - brute[k].similarity) < 1e-12);
  }
});

test('recall and candidate-ceiling arithmetic', () => {
  const a = [{ index: 1 }, { index: 2 }, { index: 3 }];
  const b = [{ index: 2 }, { index: 3 }, { index: 4 }];
  assert.equal(recallAtK(a, b, 3), 2 / 3);
  assert.equal(candidateCeiling([2, 3, 9], b, 3), 2 / 3);
  assert.equal(candidateCeiling([7, 8, 9], b, 3), 0);
});

test('bucket candidates respect the eligibility mask and budget', () => {
  const { vectors, queries } = adversarialCorpus(400, 8, 13, 2);
  const buckets = trainBuckets(vectors, 400, 8, 8, 3, 400);
  const index = assignBuckets(vectors, 400, 8, buckets);
  assert.equal(index.assignments.length, 400);
  for (let i = 0; i < 400; i += 41) assert.equal(assignRow(vectors, i, 8, buckets), index.assignments[i]);
  const mask = eligibleMask(400, id => id % 4 === 0);
  for (const query of queries) {
    const ids = bucketCandidates(buckets, index, query, 50, mask, 8);
    assert.ok(ids.length <= 50);
    assert.ok(ids.length > 0);
    assert.ok(ids.every(id => mask[id]));
    const unfiltered = bucketCandidates(buckets, index, query, 50, null, 8);
    assert.equal(unfiltered.length, 50);
  }
});

test('compact scans rank exact neighbours on an easy corpus', () => {
  const { vectors, queries } = uniformCorpus(200, 8, 31, 2);
  const norms = precomputeNorms(vectors, 200, 8);
  const sq8 = encodeSq8(vectors, 200, 8);
  const sign = encodeSign(vectors, 200, 8);
  const buckets = trainBuckets(vectors, 200, 8, 8, 3, 200);
  const index = assignBuckets(vectors, 200, 8, buckets);
  for (const query of queries) {
    const oracle = exactTopK(vectors, 200, 8, query, 10, null);
    for (const [name, ids] of [
      ['sq8', sq8Scan(vectors, 200, 8, sq8, norms, query, 100).map(row => row.index)],
      ['sign', signScan(sign, 200, 8, query, 100).map(row => row.index)],
      // Coarse buckets at 8 dimensions genuinely drop neighbours (8 centroids over random
      // 8-D rows): assert a sanity floor here, the real numbers come from 128-1536 D.
      ['bucket', bucketCandidates(buckets, index, query, 100, null, 8)],
    ]) {
      const floor = name === 'bucket' ? 0.6 : 0.9;
      const reranked = rerankTopK(vectors, 8, norms, ids, query, 10);
      assert.ok(recallAtK(reranked, oracle) >= floor, `${name} recall too low`);
      assert.ok(candidateCeiling(ids, oracle) >= floor, `${name} ceiling too low`);
    }
  }
});

test('runExperiment produces complete, self-consistent measurements', () => {
  const { vectors, queries } = uniformCorpus(250, 8, 77, 3);
  const result = runExperiment({ name: 'unit', kind: 'uniform', vectors, count: 250, dims: 8, queries, bucketK: 8, bucketIters: 2, bucketSample: 250, budgets: [20, 50], repetitions: 2 });
  assert.equal(result.methods.exact.meanRecallAt10, 1);
  for (const method of ['sq8', 'sign', 'bucket']) {
    assert.ok(result.methods[method].medianMs > 0);
    assert.ok(result.methods[method].meanRecallAt10 >= 0.5, `${method} mean recall`);
  }
  assert.ok(result.methods.sq8.meanRecallAt10 >= 0.9, 'sq8 mean recall');
  // 1-bit codes at 8 dimensions hold almost no information: assert structure, not quality.
  assert.ok(result.methods.sign.medianMs > 0);
  assert.ok(result.methods.sign.meanRecallAt10 >= 0.3);
  for (const method of ['sq8', 'sign', 'bucket']) {
    for (const budget of [20, 50]) {
      const entry = result.methods[method].perBudget[budget];
      assert.ok(entry.recallAt10 <= entry.candidateCeilingAt10 + 1e-12);
    }
  }
  assert.ok(result.build.bucketsMs >= 0 && result.memoryBytes.sq8 < result.memoryBytes.originals);
  assert.ok(result.updateMicrosPerRow.sq8 > 0 && result.updateMicrosPerRow.sign > 0);
});

test('perturbed real queries stay near their source rows', () => {
  const { vectors } = uniformCorpus(50, 8, 5, 0);
  const queries = perturbedRealQueries(vectors, 50, 8, 40, 10, 0.01, 3);
  assert.equal(queries.length, 10);
  const norms = precomputeNorms(vectors, 50, 8);
  for (let q = 0; q < 10; q++) {
    const top = exactTopK(vectors, 50, 8, queries[q], 1, null);
    assert.equal(top[0].index, 40 + q);
    assert.ok(rerankTopK(vectors, 8, norms, [40 + q], queries[q], 1)[0].similarity > 0.9);
  }
});
