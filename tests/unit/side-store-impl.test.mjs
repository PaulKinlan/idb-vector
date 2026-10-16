import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCodeRecord,
  sq8QueryWeights,
  scanSideStore,
  rerankCandidates,
  canonicalKey,
} from '../../utils/side-store.js';

test('canonicalKey serializes primitives, Dates, Arrays, and binary buffers to canonical value forms (ADR 0001 Invariant 10)', () => {
  // Numbers and strings
  assert.equal(canonicalKey(42), '["number",42]');
  assert.equal(canonicalKey('user-1'), '["string","user-1"]');

  // Dates: two distinct instances with same timestamp have same canonical form
  const d1 = new Date(1700000000000);
  const d2 = new Date(1700000000000);
  assert.notEqual(d1, d2);
  assert.equal(canonicalKey(d1), canonicalKey(d2));
  assert.equal(canonicalKey(d1), '["date",1700000000000]');

  // Arrays: two distinct instances with same elements have same canonical form
  const a1 = ['groupA', 10, d1];
  const a2 = ['groupA', 10, d2];
  assert.notEqual(a1, a2);
  assert.equal(canonicalKey(a1), canonicalKey(a2));
  assert.equal(canonicalKey(a1), '["array",[["string","groupA"],["number",10],["date",1700000000000]]]');
  assert.notEqual(canonicalKey(['a,s:b', 'c']), canonicalKey(['a', 'b,s:c']));
  assert.equal(canonicalKey([0, ['a,b']]), canonicalKey([0, ['a,b']]));

  // Binary Uint8Array
  const b1 = new Uint8Array([1, 2, 3]);
  const b2 = new Uint8Array([1, 2, 3]);
  assert.notEqual(b1, b2);
  assert.equal(canonicalKey(b1), canonicalKey(b2));
  assert.equal(canonicalKey(b1), '["binary",[1,2,3]]');
  assert.equal(canonicalKey(new Uint8Array([0, 1, 2, 3]).subarray(1, 3)), '["binary",[1,2]]');
});

test('buildCodeRecord quantizes vectors to int8 and precomputes norms', () => {
  const records = [
    { key: 'a', embedding: [1.0, 0.0] },
    { key: 'b', embedding: [0.0, 1.0] },
    { key: 'c', embedding: [0.70710678, 0.70710678] },
  ];

  const codeRec = buildCodeRecord(records, { epoch: 1, vectorPath: 'embedding', keys: records.map(r => r.key) });
  assert.equal(codeRec.epoch, 1);
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

test('scanSideStore orders candidates and respects candidate budget bound (ADR 0001 Invariant 4 & 12)', () => {
  const records = [
    { key: 'k1', embedding: [1.0, 0.0] },
    { key: 'k2', embedding: [0.9, 0.1] },
    { key: 'k3', embedding: [0.5, 0.5] },
    { key: 'k4', embedding: [0.0, 1.0] },
  ];

  const codeRec = buildCodeRecord(records, { epoch: 1, keys: records.map(r => r.key) });
  const query = [1.0, 0.0];

  // candidateBudget = 2
  const candidates = scanSideStore(codeRec, query, 2);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].key, 'k1');
  assert.equal(candidates[1].key, 'k2');
  assert.ok(candidates[0].score >= candidates[1].score);
});

test('scanSideStore filters candidates before budget truncation (ADR 0001 Invariant 11)', () => {
  const records = [
    { key: 1, embedding: [1.0, 0.0] }, // closest to [1, 0]
    { key: 2, embedding: [0.99, 0.01] },
    { key: 3, embedding: [0.0, 1.0] }, // eligible
    { key: 4, embedding: [0.1, 0.9] }, // eligible
  ];

  const codeRec = buildCodeRecord(records, { epoch: 1, keys: records.map(r => r.key) });
  const query = [1.0, 0.0];

  // Only keys 3 and 4 are eligible. If budget is 2, keys 3 and 4 must be returned,
  // NOT keys 1 and 2 dropped afterwards.
  const eligibleSet = new Set([3, 4]);
  const candidates = scanSideStore(codeRec, query, 2, eligibleSet);

  assert.equal(candidates.length, 2);
  assert.deepEqual(Array.from(candidates.map(c => c.key)), [4, 3]);
});

test('scanSideStore matches Date and array keys by value in eligibleKeys (ADR 0001 Invariant 10)', () => {
  const dKey1 = new Date(1700000001000);
  const dKey2 = new Date(1700000002000);
  const arrKey1 = ['group1', 1];
  const arrKey2 = ['group2', 2];

  const records = [
    { key: dKey1, embedding: [1.0, 0.0] },
    { key: dKey2, embedding: [0.0, 1.0] },
    { key: arrKey1, embedding: [0.9, 0.1] },
    { key: arrKey2, embedding: [0.1, 0.9] },
  ];

  const codeRec = buildCodeRecord(records, { epoch: 1, keys: records.map(r => r.key) });
  const query = [1.0, 0.0];

  // Distinct Date and Array instances passed in eligibleKeys
  const queryDate = new Date(1700000001000);
  const queryArr = ['group1', 1];
  assert.notEqual(queryDate, dKey1);
  assert.notEqual(queryArr, arrKey1);

  const eligibleKeys = [queryDate, queryArr];
  const candidates = scanSideStore(codeRec, query, 10, eligibleKeys);

  assert.equal(candidates.length, 2);
  // Matches dKey1 and arrKey1
  assert.equal(candidates[0].key, dKey1);
  assert.equal(candidates[1].key, arrKey1);
});

test('rerankCandidates preserves exact candidate primary keys (ADR 0001 Invariant 1)', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { id: 'wrong-id', embedding: [1.0, 0.0] },
  ];
  const candidateKeys = ['real-out-of-line-primary-key'];

  const results = rerankCandidates(fetched, 'embedding', query, 1, null, candidateKeys);
  assert.equal(results.length, 1);
  assert.equal(results[0].key, 'real-out-of-line-primary-key');
  assert.equal(results[0].object.id, 'wrong-id');
});

test('rerankCandidates enforces 0 dead rows on current revision', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { key: 'a', embedding: [1.0, 0.0] },
    undefined, // deleted / missing row
  ];

  assert.throws(
    () => rerankCandidates(fetched, 'embedding', query, 2, null, ['a', 'b']),
    /0 dead rows acceptable on the current revision/
  );
});

test('rerankCandidates respects threshold', () => {
  const query = [1.0, 0.0];
  const fetched = [
    { key: 'a', embedding: [1.0, 0.0] },
    { key: 'b', embedding: [0.99, 0.01] },
    { key: 'c', embedding: [0.5, 0.5] },
  ];

  const results = rerankCandidates(fetched, 'embedding', query, 10, 0.8, ['a', 'b', 'c']);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(r => r.key), ['a', 'b']);
});
