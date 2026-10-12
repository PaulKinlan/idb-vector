import assert from 'node:assert/strict';
import test from 'node:test';
import { uniformCorpus, precomputeNorms, exactTopK, rerankTopK, recallAtK } from '../../test-harness/quantized-pass.js';
import { buildCodeRecord, rerankFetched } from '../../test-harness/side-store.js';

test('the code record carries what a query needs and nothing the originals could be rebuilt from', () => {
  const count = 400, dims = 24;
  const { vectors } = uniformCorpus(count, dims, 3, 1);
  const record = buildCodeRecord(vectors, count, dims, 7);
  assert.equal(record.revision, 7);
  assert.equal(record.count, count);
  assert.equal(record.dims, dims);
  assert.equal(record.codes.length, count * dims);
  assert.equal(record.norms.length, count);
  assert.equal(record.mins.length, dims);
  assert.equal(record.scales.length, dims);
  assert.equal(record.bytes, count * dims + count * 4 + dims * 4 + dims * 4);
  // Codes reconstruct each coordinate within half a scale step, so the record is a lossy stand-in
  // for scoring, never a replacement for the originals in an exact rerank.
  const norms = precomputeNorms(vectors, count, dims);
  for (let i = 0; i < count; i += 53) {
    assert.ok(Math.abs(norms[i] - record.norms[i]) < 1e-6);
    for (let d = 0; d < dims; d += 7) {
      const reconstructed = (record.codes[i * dims + d] + 127) * record.scales[d] + record.mins[d];
      assert.ok(Math.abs(reconstructed - vectors[i * dims + d]) <= record.scales[d] / 2 + 1e-9);
    }
  }
});

test('rerankFetched matches the resident rerank on the same rows', () => {
  const count = 200, dims = 16;
  const { vectors, queries } = uniformCorpus(count, dims, 11, 3);
  const norms = precomputeNorms(vectors, count, dims);
  const ids = Array.from({ length: 40 }, (_, i) => i * 3 % count);
  for (const query of queries) {
    const fetched = ids.map(id => ({ id, embedding: Float64Array.from(vectors.subarray(id * dims, (id + 1) * dims)) }));
    const fetchedTop = rerankFetched(fetched, query, 10, dims);
    const residentTop = rerankTopK(vectors, dims, norms, ids, query, 10);
    assert.deepEqual(fetchedTop.map(row => row.index), residentTop.map(row => row.index));
    // Identical ordering, but the similarity can differ at the Float32-vs-Float64 boundary: the
    // resident rerank divides by the stored Float32 norm, the fetched rerank recomputes the norm
    // from the Float64 row (that difference is why a side-store must ship norms, not just codes).
    for (let k = 0; k < 10; k++) assert.ok(Math.abs(fetchedTop[k].similarity - residentTop[k].similarity) < 1e-6);
    // The fetched rerank is the exact ranking over the candidate set, so it cannot beat the exact
    // oracle over the whole corpus and it must reach the ceiling the candidate set allows.
    const oracle = exactTopK(vectors, count, dims, query, 10, null);
    assert.equal(recallAtK(fetchedTop, oracle), recallAtK(residentTop, oracle));
  }
});

test('rows the pinned revision no longer has are skipped, not scored as zero', () => {
  const count = 120, dims = 8;
  const { vectors, query } = { vectors: uniformCorpus(120, 8, 5, 0).vectors, query: uniformCorpus(120, 8, 5, 1).queries[0] };
  const live = [0, 1, 2, 3].map(id => ({ id, embedding: Float64Array.from(vectors.subarray(id * dims, (id + 1) * dims)) }));
  const withDeleted = [live[0], null, { id: 9, deleted: true, embedding: null }, live[1], live[2], live[3]];
  const top = rerankFetched(withDeleted, query, 4, dims);
  assert.deepEqual(top.map(row => row.index).sort((a, b) => a - b), [0, 1, 2, 3]);
  for (const row of top) assert.ok(Number.isFinite(row.similarity) && row.similarity !== 0);
  // A row of the wrong width is a real bug in the caller's revision, so it is refused loudly.
  assert.throws(() => rerankFetched([{ id: 0, embedding: new Float64Array(4) }], query, 1, dims), /expected 8/);
});
