import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  assert.equal(canonicalKey(-0), canonicalKey(0));
  assert.notEqual(canonicalKey(Infinity), canonicalKey(-Infinity));
  assert.throws(() => canonicalKey(null), /valid IndexedDB primary keys/);
  assert.notEqual(canonicalKey(Infinity), canonicalKey('+Infinity'));
  assert.throws(() => canonicalKey(NaN), /valid IndexedDB primary keys/);
});

test('pure code builder refuses an unstamped corpus epoch', () => {
  assert.throws(() => buildCodeRecord([{ embedding: [1, 0] }], { keys: [7] }), /requires a store-wide epoch/);
  assert.equal(buildCodeRecord([{ embedding: [1, 0] }], { keys: [7], epoch: 7 }).epoch, 7);
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

test('buildCodeRecord refuses vectors whose Float32 storage would silently corrupt ranking', () => {
  // Finite f64 coordinates whose L2 norm exceeds Float32 max (~3.4e38): the
  // stored norm would become Infinity and every scan score would collapse.
  assert.throws(
    () => buildCodeRecord(
      [
        { embedding: [0, 1e40] },
        { embedding: [1e40, 0] },
      ],
      { keys: ['best', 'wrong'], epoch: 1 },
    ),
    /overflows Float32/,
  );

  // A single coordinate beyond Float32 range always implies norm overflow
  // (norm >= max|coordinate|), so it is rejected by the same check.
  assert.throws(
    () => buildCodeRecord([{ embedding: [1e39] }], { keys: ['big'], epoch: 1 }),
    /overflows Float32/,
  );

  // Values just inside Float32 range are still representable and must build.
  const edge = buildCodeRecord(
    [{ embedding: [1e38, -1e38] }],
    { keys: ['edge'], epoch: 1 },
  );
  assert.equal(edge.count, 1);
  assert.ok(Number.isFinite(edge.norms[0]));
  assert.ok(Number.isFinite(edge.mins[0]));
  assert.ok(Number.isFinite(edge.scales[0]));
});

test('scanSideStore refuses stored code records with non-finite or zero norms', () => {
  const record = buildCodeRecord(
    [{ embedding: [1, 0] }],
    { keys: ['a'], epoch: 1 },
  );
  // Simulate records published before range validation existed: Float32
  // overflow (Infinity) and underflow / zero vector (0). Both must fail loudly
  // with a rebuild instruction instead of silently mis-ranking.
  for (const poison of [Infinity, 0]) {
    record.norms[0] = poison;
    assert.throws(
      () => scanSideStore(record, [1, 0], 10),
      /non-finite or zero norm/,
    );
  }
});

test('buildCodeRecord refuses vectors whose L2 norm underflows Float32 to zero (idb-vector-b1a)', () => {
  // Finite f64 coordinates whose L2 norm sits below the Float32 minimum: the
  // stored norm would become 0, (norms[i] || 1) would silently substitute 1,
  // and a bounded scan would distort or tie every score.
  assert.throws(
    () => buildCodeRecord(
      [
        { embedding: [1e-50, 0] },
        { embedding: [0, 1e-50] },
      ],
      { keys: ['wrong', 'best'], epoch: 1 },
    ),
    /underflows Float32/,
  );

  // A genuine all-zero vector is refused at build: insert() and
  // rerankCandidates() already reject it (cosine is undefined/NaN), so no
  // legitimate code record ever stores a 0 norm — which is what lets
  // scanSideStore() treat a stored 0 as corruption (idb-vector-pku).
  assert.throws(
    () => buildCodeRecord([{ embedding: [0, 0] }], { keys: ['zero'], epoch: 1 }),
    /all-zero vector/,
  );
});

test('finite 1e38 query over a representable corpus keeps exact ranking (idb-vector-p3o regression)', () => {
  // All stored norms are positive finite and pass the build guards; before the
  // Float64 query-weights fix, q*scale (~3.9e73) narrowed to Float32 Infinity
  // and the budget-1 scan returned 'third' with -Infinity.
  const rows = [
    { embedding: [0, 1e38] },
    { embedding: [1e38, 5e37] },
    { embedding: [1e38, 0] },
  ];
  const keys = ['best', 'wrong', 'third'];
  const query = [0, 1e38];

  const codeRecord = buildCodeRecord(rows, { keys, epoch: 1 });
  const top = scanSideStore(codeRecord, query, 1);
  assert.equal(top[0].key, 'best');
  assert.ok(Number.isFinite(top[0].score));

  const exact = rerankCandidates(rows, 'embedding', query, 1, null, keys);
  assert.equal(exact[0].key, 'best');
  assert.ok(Math.abs(exact[0].similarity - top[0].score) < 1e-6,
    `scan score ${top[0].score} should track exact cosine ${exact[0].similarity}`);
});

test('sweep: every Float32Array narrowing in side-store.js is enumerated and bounded (no surface left)', () => {
  // The same failure pattern was found four times (stored norms, underflow,
  // legacy zero, query weights). Lock the inventory: every float32 narrowing
  // must appear here WITH a proof it cannot produce a non-finite or overflowing
  // intermediate. A new Float32Array in the source fails this test until it is
  // either guarded and added below, or moved to Float64.
  const source = readFileSync(
    fileURLToPath(new URL('../../utils/side-store.js', import.meta.url)),
    'utf8',
  );

  // Math.fround is the other float32 narrowing; none is allowed.
  assert.ok(!source.includes('Math.fround'), 'Math.fround (float32 narrowing) found in side-store.js');

  // The only permitted Float32Arrays are the STORED tables of buildCodeRecord
  // (norms, mins, scales, maxs): compact on disk and guarded at build time by
  // the L2-norm check (norm is finite, positive, and >= max|coordinate|, which
  // subsumes mins/maxs/scales). Transient per-query intermediates (query
  // weights) must be Float64.
  const sites = [...source.matchAll(/new Float32Array\(([^)]*)\)/g)].map(m => m[1].trim()).sort();
  assert.deepEqual(sites, ['0', '0', '0', 'count', 'dims', 'dims', 'dims'],
    'Float32Array inventory changed: add a boundedness proof for the new site or use Float64/Int8');

  // Proof for the stored tables: a boundary corpus that survives the build
  // guards reads back finite everywhere, and the pathological corpora on both
  // ends of Float32 range are rejected before anything is published.
  const boundary = buildCodeRecord([{ embedding: [1e38, -1e38] }], { keys: ['edge'], epoch: 1 });
  for (const table of [boundary.norms, boundary.mins, boundary.scales]) {
    for (const v of table) assert.ok(Number.isFinite(v), `stored table has non-finite entry ${v}`);
  }
  assert.throws(() => buildCodeRecord([{ embedding: [1e40] }], { keys: ['big'], epoch: 1 }), /overflows Float32/);
  assert.throws(() => buildCodeRecord([{ embedding: [1e-50] }], { keys: ['tiny'], epoch: 1 }), /underflows Float32/);
  assert.throws(() => buildCodeRecord([{ embedding: [0, 0] }], { keys: ['zero'], epoch: 1 }), /all-zero vector/);

  // Proof for the transient path: query weights are Float64 and stay finite
  // for q*scale products far beyond Float32 range.
  const { weights } = sq8QueryWeights([1e38], [0], [1e38 / 254]);
  assert.ok(weights instanceof Float64Array, 'query weights must be Float64Array, not a float32 narrowing');
  assert.ok(Number.isFinite(weights[0]) && weights[0] > 0, 'query weight overflowed');
});
