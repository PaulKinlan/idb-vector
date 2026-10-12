import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodeRecord,
  sq8QueryWeights,
  scanSideStore,
  rerankCandidates,
} from '../../utils/side-store.js';

test('buildCodeRecord quantizes vectors to int8 and precomputes norms', () => {
  const records = [
    { id: 'a', embedding: [1.0, 0.0, -1.0, 0.5] },
    { id: 'b', embedding: [0.0, 1.0, 0.5, -0.5] },
    { id: 'c', embedding: [-0.5, -0.5, 0.0, 1.0] },
  ];

  const codeRecord = buildCodeRecord(records, { revision: 3, vectorPath: 'embedding' });
  assert.equal(codeRecord.revision, 3);
  assert.equal(codeRecord.count, 3);
  assert.equal(codeRecord.dims, 4);
  assert.deepEqual(codeRecord.keys, ['a', 'b', 'c']);
  assert.equal(codeRecord.codes.length, 12);
  assert.equal(codeRecord.norms.length, 3);

  // Int8 values must be within [-127, 127]
  for (let i = 0; i < codeRecord.codes.length; i++) {
    assert.ok(codeRecord.codes[i] >= -128 && codeRecord.codes[i] <= 127);
  }

  // Norms match expected L2 lengths
  assert.ok(Math.abs(codeRecord.norms[0] - Math.sqrt(1 + 0 + 1 + 0.25)) < 1e-5);

  // Bytes calculation is exact
  const expectedBytes = codeRecord.codes.byteLength + codeRecord.norms.byteLength +
    codeRecord.mins.byteLength + codeRecord.scales.byteLength;
  assert.equal(codeRecord.bytes, expectedBytes);
});

test('scanSideStore orders candidates and respects candidate budget', () => {
  const dims = 8;
  const count = 50;
  const records = [];
  for (let i = 0; i < count; i++) {
    const v = new Array(dims).fill(0);
    v[i % dims] = 1.0;
    v[(i + 1) % dims] = (i / count);
    records.push({ id: i + 1, embedding: v });
  }

  const codeRecord = buildCodeRecord(records, { revision: 1 });
  const query = new Array(dims).fill(0);
  query[0] = 1.0;

  // Budget of 10
  const candidates = scanSideStore(codeRecord, query, 10);
  assert.equal(candidates.length, 10);
  // Descending order by score
  for (let i = 1; i < candidates.length; i++) {
    assert.ok(candidates[i - 1].score >= candidates[i].score);
  }
  // The top candidate should have coordinate 0 prominent
  assert.equal(candidates[0].key, 1);
});

test('scanSideStore filters candidates before scoring (predicate-before-candidate)', () => {
  const records = [
    { id: 1, embedding: [1, 0, 0] },
    { id: 2, embedding: [0.99, 0.1, 0] },
    { id: 3, embedding: [0.5, 0.5, 0.5] },
    { id: 4, embedding: [0, 1, 0] },
  ];

  const codeRecord = buildCodeRecord(records, { revision: 1 });
  const query = [1, 0, 0];

  // Set-based filter: only keys 3 and 4 are eligible
  const eligibleSet = new Set([3, 4]);
  const candidates = scanSideStore(codeRecord, query, 10, eligibleSet);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(c => c.key), [3, 4]);

  // Function-based filter
  const candidatesFn = scanSideStore(codeRecord, query, 10, key => key === 2);
  assert.equal(candidatesFn.length, 1);
  assert.equal(candidatesFn[0].key, 2);
});

test('rerankCandidates computes exact Float64 scores and enforces 0 dead rows and revision match', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { id: 10, revision: 1, embedding: [1.0, 0.0] },
    { id: 20, revision: 1, embedding: [0.0, 1.0] },
    { id: 30, revision: 1, embedding: [0.70710678, 0.70710678] },
  ];

  const results = rerankCandidates(fetched, 'embedding', query, 2, null, 1);
  assert.equal(results.length, 2);
  assert.equal(results[0].key, 10);
  assert.ok(Math.abs(results[0].similarity - 1.0) < 1e-9);
  assert.equal(results[1].key, 30);
  assert.ok(Math.abs(results[1].similarity - 0.70710678) < 1e-6);

  // Enforces 0 dead rows on the current pinned revision
  const fetchedWithDeadRow = [
    { id: 10, revision: 1, embedding: [1.0, 0.0] },
    undefined, // dead row
  ];
  assert.throws(
    () => rerankCandidates(fetchedWithDeadRow, 'embedding', query, 2, null, 1),
    /0 dead rows acceptable on the current revision/
  );

  // Enforces revision match on fetched records
  const fetchedWithStaleRev = [
    { id: 10, revision: 2, embedding: [1.0, 0.0] }, // record updated to rev 2
  ];
  assert.throws(
    () => rerankCandidates(fetchedWithStaleRev, 'embedding', query, 2, null, 1),
    /Record 10 has revision 2, but query pinned revision 1/
  );
});

test('rerankCandidates respects threshold', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { id: 1, revision: 1, embedding: [1.0, 0.0] },
    { id: 2, revision: 1, embedding: [0.99, 0.01] },
    { id: 3, revision: 1, embedding: [0.5, 0.5] },
  ];

  // Threshold filtering
  const threshResults = rerankCandidates(fetched, 'embedding', query, 10, 0.8, 1);
  assert.equal(threshResults.length, 2);
  assert.deepEqual(threshResults.map(r => r.key), [1, 2]);
});
