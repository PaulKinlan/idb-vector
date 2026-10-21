import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildCodeRecord,
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

test('buildCodeRecord stores ranking-relevant metadata in Float64: extreme-but-finite corpora rank correctly', () => {
  // Coord ruling (idb-vector-rrq): the code-record path must not narrow
  // ranking-relevant values to Float32 at all. 1e40-magnitude corpora used to
  // store Infinity norms; now they build and rank exactly.
  const huge = buildCodeRecord(
    [
      { embedding: [0, 1e40] },
      { embedding: [1e40, 0] },
    ],
    { keys: ['best', 'wrong'], epoch: 1 },
  );
  assert.ok(huge.norms instanceof Float64Array);
  const hugeTop = scanSideStore(huge, [0, 1], 1);
  assert.equal(hugeTop[0].key, 'best');
  assert.ok(Math.abs(hugeTop[0].score - 1) < 1e-6);

  // Tripwire: an f64 non-finite norm (coordinates ~1e154+) is still refused.
  assert.throws(
    () => buildCodeRecord([{ embedding: [1e200] }], { keys: ['absurd'], epoch: 1 }),
    /non-finite L2 norm/,
  );

  // Boundary: values just beyond the old Float32 range read back finite.
  const boundary = buildCodeRecord(
    [{ embedding: [1e38, -1e38] }],
    { keys: ['edge'], epoch: 1 },
  );
  assert.equal(boundary.count, 1);
  for (const table of [boundary.norms, boundary.mins, boundary.scales]) {
    assert.ok(table instanceof Float64Array);
    for (const v of table) assert.ok(Number.isFinite(v));
  }
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

test('buildCodeRecord keeps tiny corpora rankable: zero norms are only zero vectors or f64 underflow (idb-vector-b1a)', () => {
  // 1e-50 corpora used to underflow the stored Float32 norm to 0; with Float64
  // storage they build and rank exactly.
  const tiny = buildCodeRecord(
    [
      { embedding: [1e-50, 0] },
      { embedding: [0, 1e-50] },
    ],
    { keys: ['wrong', 'best'], epoch: 1 },
  );
  const tinyTop = scanSideStore(tiny, [0, 1e-50], 1);
  assert.equal(tinyTop[0].key, 'best');
  assert.ok(Math.abs(tinyTop[0].score - 1) < 1e-6);

  // Tripwire: a normSq that underflows even Float64 (squares vanish below
  // ~1e-162 coordinates) is refused, not silently stored as 0.
  assert.throws(
    () => buildCodeRecord([{ embedding: [1e-320, 0] }], { keys: ['subtiny'], epoch: 1 }),
    /underflows even Float64/,
  );

  // A genuine all-zero vector is still refused: cosine is undefined/NaN and
  // the exact rerank refuses it, so no legitimate record stores a 0 norm.
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

test('sweep: no Float32 narrowing of ranking-relevant values remains (structural end of the bug class)', () => {
  // The same failure pattern was found five times (norm overflow, norm
  // underflow, legacy zero, query-weight overflow, scale underflow) — every
  // one a Float32 narrowing of a ranking-relevant value. Coord ruling: the
  // code-record path must not narrow ranking-relevant values to Float32 at
  // all. The inventory is therefore EMPTY: any new Float32Array or Math.fround
  // in this file fails here until it is justified and guarded in its own
  // right.
  const source = readFileSync(
    fileURLToPath(new URL('../../utils/side-store.js', import.meta.url)),
    'utf8',
  );

  assert.ok(!source.includes('new Float32Array('), 'new Float32Array found in side-store.js: ranking-relevant values must not be narrowed to Float32');
  assert.ok(!source.includes('Math.fround'), 'Math.fround (float32 narrowing) found in side-store.js');

  // Positive proof on a live record: every ranking-relevant table is Float64,
  // every entry positive-finite where the domain requires it, and the only
  // lossy table left is the deliberate Int8 SQ8 quantization.
  const boundary = buildCodeRecord([{ embedding: [1e38, -1e38] }], { keys: ['edge'], epoch: 1 });
  assert.ok(boundary.norms instanceof Float64Array);
  assert.ok(boundary.mins instanceof Float64Array);
  assert.ok(boundary.scales instanceof Float64Array);
  assert.ok(boundary.codes instanceof Int8Array);
  for (const v of boundary.norms) {
    assert.ok(Number.isFinite(v) && v > 0, `stored norm must be positive and finite, got ${v}`);
  }
  for (const v of boundary.scales) {
    assert.ok(Number.isFinite(v) && v > 0, `stored scale must be positive and finite, got ${v}`);
  }

  // Scan-side guards stay load-bearing for LEGACY records published by older
  // versions with degenerate f32 tables: poisoned norms and scales must fail
  // loudly with a rebuild instruction, never silently mis-rank.
  const record = buildCodeRecord([{ embedding: [1, 0] }], { keys: ['a'], epoch: 1 });
  record.norms[0] = Infinity;
  assert.throws(() => scanSideStore(record, [1, 0], 10), /non-finite or zero norm/);
  record.norms[0] = 0;
  assert.throws(() => scanSideStore(record, [1, 0], 10), /non-finite or zero norm/);
  record.norms[0] = 1;
  record.scales[0] = 0;
  assert.throws(() => scanSideStore(record, [1, 0], 10), /non-positive or non-finite scale/);
});

test('buildCodeRecord keeps tiny-range dimensions rankable: scales are Float64 (idb-vector-rrq regression)', () => {
  // Norms are positive f32 denormals here (~9.8e-45) and range/254 (~7.7e-47)
  // used to round to a stored Float32 scale of 0, poisoning the codes. With
  // Float64 scales the corpus builds and ranks exactly.
  const tiny = buildCodeRecord(
    [
      { embedding: [1e-44, 0] },
      { embedding: [0, 1e-44] },
    ],
    { keys: ['wrong', 'best'], epoch: 1 },
  );
  assert.ok(tiny.scales instanceof Float64Array);
  assert.ok(tiny.scales[0] > 0 && Number.isFinite(tiny.scales[0]));
  const tinyTop = scanSideStore(tiny, [0, 1e-44], 1);
  assert.equal(tinyTop[0].key, 'best');
  assert.ok(Math.abs(tinyTop[0].score - 1) < 1e-6);

  // A constant dimension (range === 0) is not underflow: the || 1 fallback
  // stores scale 1 and the dimension contributes a harmless constant.
  const constant = buildCodeRecord(
    [
      { embedding: [5, 7] },
      { embedding: [9, 7] },
    ],
    { keys: ['a', 'b'], epoch: 1 },
  );
  assert.equal(constant.scales[0] > 0, true);
  assert.equal(constant.scales[1], 1);
});

test('scanSideStore refuses stored code records with non-positive or non-finite scales', () => {
  const record = buildCodeRecord(
    [{ embedding: [1, 0] }],
    { keys: ['a'], epoch: 1 },
  );
  // Simulate a record published before scale validation existed: underflow
  // rounds a positive range's scale to stored 0. No legitimate build stores 0
  // (subnormal ranges take the || 1 fallback), so fail loudly.
  record.scales[0] = 0;
  assert.throws(
    () => scanSideStore(record, [1, 0], 10),
    /non-positive or non-finite scale/,
  );
});

test('build-side scale invariants need no guard: || 1 stores 1 and the norm tripwire fires first (idb-vector-blj)', () => {
  // buildCodeRecord() used to carry two scale guards that could never fire:
  // `!Number.isFinite(scales[d])` needed a non-finite range, and
  // `range > 0 && scales[d] === 0` needed the quotient to be observed before
  // the `|| 1` fallback replaced it. Both were removed, so these assertions are
  // the argument the comment now makes - executable.
  const rows = [
    { embedding: [5e-324, 1, 0] },
    { embedding: [1e-323, 0.70710678, 0.70710678] },
    { embedding: [5e-324, 1e-320, 1] },
  ];
  const keys = ['best', 'mid', 'worst'];
  const query = [0, 1, 0];
  const record = buildCodeRecord(rows, { keys, epoch: 1 });

  // Dimension 0 spans only subnormals (~5e-324), so `range / 254` underflows to
  // a zero quotient and the fallback stores exactly 1. The removed guard tested
  // for a stored 0 that the fallback had already ruled out, so it was dead.
  assert.equal(record.scales[0], 1);
  for (const v of record.scales) {
    assert.ok(Number.isFinite(v) && v > 0, `stored scale must be positive and finite, got ${v}`);
  }

  // Falling back to scale 1 costs nothing: a subnormal range is ~140 orders of
  // magnitude below any coordinate big enough to keep the L2 norm representable,
  // so the quantization error it leaves behind cannot reorder candidates. The
  // scan still returns the exact rerank order on a corpus that does discriminate.
  const scanned = scanSideStore(record, query, 3).map((r) => r.key);
  const exact = rerankCandidates(rows, 'embedding', query, 3, null, keys).map((r) => r.key);
  assert.deepEqual(scanned, ['best', 'mid', 'worst']);
  assert.deepEqual(scanned, exact);

  // The non-finite-scale case cannot reach the scale loop either: overflowing a
  // per-dimension range needs `max - min > 1.79e308`, i.e. a coordinate above
  // ~8.9e307, whose square already overflows, so the non-finite L2 norm check in
  // the first pass throws before any scale is computed.
  assert.throws(
    () => buildCodeRecord(
      [
        { embedding: [1.7e308, -1.7e308] },
        { embedding: [-1.7e308, 1.7e308] },
      ],
      { keys: ['high', 'low'], epoch: 1 },
    ),
    /non-finite L2 norm/,
  );
});
