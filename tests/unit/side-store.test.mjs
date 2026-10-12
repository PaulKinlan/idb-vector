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
    { key: 'a', revision: 1, embedding: [1.0, 0.0] },
    { key: 'b', revision: 1, embedding: [0.0, 1.0] },
    { key: 'c', revision: 1, embedding: [0.70710678, 0.70710678] },
  ];

  const codeRec = buildCodeRecord(records, { revision: 1, vectorPath: 'embedding' });
  assert.equal(codeRec.revision, 1);
  assert.equal(codeRec.count, 3);
  assert.equal(codeRec.dims, 2);
  assert.deepEqual(codeRec.keys, ['a', 'b', 'c']);
  assert.equal(codeRec.codes.length, 6);
  assert.ok(codeRec.bytes > 0);

  // Codes are within [-127, 127]
  for (let i = 0; i < codeRec.codes.length; i++) {
    assert.ok(codeRec.codes[i] >= -127 && codeRec.codes[i] <= 127);
  }

  // Precomputed norms match actual L2 norms
  assert.ok(Math.abs(codeRec.norms[0] - 1.0) < 1e-6);
  assert.ok(Math.abs(codeRec.norms[1] - 1.0) < 1e-6);
  assert.ok(Math.abs(codeRec.norms[2] - 1.0) < 1e-6);
});

test('buildCodeRecord throws if an original record lacks revision property (ADR 0001 Invariant 3)', () => {
  const records = [
    { key: 'a', revision: 1, embedding: [1.0, 0.0] },
    { key: 'b', embedding: [0.0, 1.0] }, // unversioned!
  ];

  assert.throws(
    () => buildCodeRecord(records, { revision: 1 }),
    /no "revision" property/
  );

  const mismatchedRecords = [
    { key: 'a', revision: 1, embedding: [1.0, 0.0] },
    { key: 'b', revision: 2, embedding: [0.0, 1.0] }, // mismatched revision!
  ];

  assert.throws(
    () => buildCodeRecord(mismatchedRecords, { revision: 1 }),
    /has revision 2, expected 1/
  );
});

test('scanSideStore orders candidates and respects candidate budget (ADR 0001 Invariant 4)', () => {
  const records = [
    { key: 'k1', revision: 1, embedding: [1.0, 0.0] },
    { key: 'k2', revision: 1, embedding: [0.9, 0.1] },
    { key: 'k3', revision: 1, embedding: [0.5, 0.5] },
    { key: 'k4', revision: 1, embedding: [0.0, 1.0] },
  ];

  const codeRec = buildCodeRecord(records, { revision: 1 });
  const query = [1.0, 0.0];

  // candidateBudget = 2
  const candidates = scanSideStore(codeRec, query, 2);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].key, 'k1');
  assert.equal(candidates[1].key, 'k2');
  assert.ok(candidates[0].score >= candidates[1].score);
});

test('scanSideStore filters candidates before budget truncation (ADR 0001 Invariant 6)', () => {
  const records = [
    { key: 1, revision: 1, embedding: [1.0, 0.0] }, // closest to [1, 0]
    { key: 2, revision: 1, embedding: [0.99, 0.01] },
    { key: 3, revision: 1, embedding: [0.0, 1.0] }, // eligible
    { key: 4, revision: 1, embedding: [0.1, 0.9] }, // eligible
  ];

  const codeRec = buildCodeRecord(records, { revision: 1 });
  const query = [1.0, 0.0];

  // Only keys 3 and 4 are eligible. If budget is 2, keys 3 and 4 must be returned,
  // NOT keys 1 and 2 dropped afterwards.
  const eligibleSet = new Set([3, 4]);
  const candidates = scanSideStore(codeRec, query, 2, eligibleSet);

  assert.equal(candidates.length, 2);
  assert.deepEqual(Array.from(candidates.map(c => c.key)), [4, 3]);
});

test('rerankCandidates preserves exact candidate primary keys (ADR 0001 Invariant 1)', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { id: 'wrong-id', revision: 1, embedding: [1.0, 0.0] },
  ];
  const candidateKeys = ['real-out-of-line-primary-key'];

  const results = rerankCandidates(fetched, 'embedding', query, 1, null, 1, 'revision', candidateKeys);
  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'real-out-of-line-primary-key');
  assert.equal(results[0].object.id, 'wrong-id');
});

test('rerankCandidates rejects stale revision during reranking (ADR 0001 Invariant 2)', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { key: 'a', revision: 2, embedding: [1.0, 0.0] }, // updated to revision 2!
  ];

  assert.throws(
    () => rerankCandidates(fetched, 'embedding', query, 1, null, 1),
    /Record "a" has revision 2, but query pinned revision 1/
  );
});

test('rerankCandidates rejects unversioned original during reranking (ADR 0001 Invariant 2)', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { key: 'a', embedding: [1.0, 0.0] }, // missing revision!
  ];

  assert.throws(
    () => rerankCandidates(fetched, 'embedding', query, 1, null, 1),
    /has no "revision" property/
  );
});

test('rerankCandidates enforces 0 dead rows on current revision', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { key: 'a', revision: 1, embedding: [1.0, 0.0] },
    undefined, // deleted / missing row
  ];

  assert.throws(
    () => rerankCandidates(fetched, 'embedding', query, 2, null, 1),
    /0 dead rows acceptable on the current revision/
  );
});

test('rerankCandidates respects threshold', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { key: 'a', revision: 1, embedding: [1.0, 0.0] },
    { key: 'b', revision: 1, embedding: [0.99, 0.01] },
    { key: 'c', revision: 1, embedding: [0.5, 0.5] },
  ];

  const results = rerankCandidates(fetched, 'embedding', query, 10, 0.8, 1);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(r => r.key), ['a', 'b']);
});
