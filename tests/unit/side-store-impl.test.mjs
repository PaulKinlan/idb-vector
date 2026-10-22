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

test('scanSideStore and rerankCandidates refuse a query whose L2 magnitude overflows Float64 (idb-vector-utq)', () => {
  // 1e160 is a finite coordinate, so the query passes shape/finiteness validation, but squaring it
  // overflows: queryMagnitude became Infinity, every score finite/Infinity = 0, and the scan
  // returned insertion order ('wrong') while the true best is 'best' with cosine 1. The record side
  // already refuses an unrepresentable corpus loudly; the query side now does the same.
  const rows = [
    { embedding: [1, 0] },
    { embedding: [0, 1] },
    { embedding: [0.7, 0.7] },
  ];
  const keys = ['wrong', 'best', 'mid'];
  const record = buildCodeRecord(rows, { keys, epoch: 1 });
  const query = [0, 1e160];

  for (const [name, run] of [
    ['scanSideStore', () => scanSideStore(record, query, 1)],
    ['rerankCandidates', () => rerankCandidates(rows, 'embedding', query, 1, null, keys)],
  ]) {
    assert.throws(
      run,
      (error) => {
        assert.ok(error instanceof TypeError, `${name}() must throw a TypeError, got ${error?.constructor?.name}`);
        assert.match(error.message, /non-finite L2 magnitude \(Infinity\)/, `${name}() message must name the magnitude: ${error.message}`);
        assert.match(error.message, /Normalize the query first/, `${name}() message must say what to do instead: ${error.message}`);
        return true;
      },
      `${name}() must refuse a query whose magnitude overflows Float64`,
    );
  }

  // Either side of the boundary keeps working: 1e150 still ranks the true best, and an all-zero
  // query keeps its previous behaviour (every score 0) instead of dividing by zero.
  assert.equal(scanSideStore(record, [0, 1e150], 1)[0].key, 'best');
  assert.equal(rerankCandidates(rows, 'embedding', [0, 1e150], 1, null, keys)[0].key, 'best');
  assert.equal(scanSideStore(record, [0, 0], 1).length, 1);

  // NaN is falsy, so `Math.sqrt(normSq) || 1` used to turn an unscorable query into magnitude 1 and
  // score it against a bogus norm; the guard reads the raw magnitude, so NaN is refused too.
  assert.throws(
    () => scanSideStore(record, [Number.NaN, 1], 1),
    /non-finite L2 magnitude \(NaN\)/,
  );
});

test('scanSideStore refuses a truncated or legacy code record before it can mis-rank (idb-vector-bmq)', () => {
  // A persisted record is untrusted: IndexedDB can hand back one written by an
  // older layout or cut short. Every indexed read assumes count keys, count
  // norms, count*dims codes and dims mins/scales, so a short table read
  // `undefined`, turned the dot product into NaN, and SortedArray inserted the
  // NaN score — a plausible wrong top-k instead of a refusal.
  const rows = [
    { embedding: [1, 0] },
    { embedding: [0, 1] },
  ];
  const keys = ['best', 'worst'];
  const fresh = () => buildCodeRecord(rows, { keys, epoch: 1 });

  // Each mutation below is a real truncation: the read the scan would reach is
  // genuinely `undefined`, which is the mechanism of the silent NaN.
  const truncations = [
    ['codes', (r) => { r.codes = r.codes.slice(0, r.count * r.dims - 1); }, 3],
    ['keys', (r) => { r.keys = r.keys.slice(0, r.count - 1); }, 1],
    ['norms', (r) => { r.norms = r.norms.slice(0, r.count - 1); }, 1],
    ['mins', (r) => { r.mins = r.mins.slice(0, r.dims - 1); }, 1],
    ['scales', (r) => { r.scales = r.scales.slice(0, r.dims - 1); }, 1],
  ];

  for (const [table, truncate, lastIndex] of truncations) {
    const record = fresh();
    truncate(record);
    assert.equal(record[table][lastIndex], undefined, `${table} truncation must leave an unread slot undefined`);
    assert.throws(
      () => scanSideStore(record, [1, 0], 10),
      (error) => {
        assert.ok(error instanceof TypeError, `truncated ${table} must throw a TypeError, got ${error?.constructor?.name}`);
        assert.match(error.message, new RegExp(`${table}\\.length`), `message must name the truncated table: ${error.message}`);
        assert.match(error.message, /Rebuild the side-store/, `message must say what to do instead: ${error.message}`);
        return true;
      },
      `scanSideStore() must refuse a truncated ${table} table`,
    );
  }

  // A record from an older layout that simply lacks the tables is the same bug
  // with a whole table missing, not a different one.
  for (const table of ['keys', 'norms', 'codes', 'mins', 'scales']) {
    const record = fresh();
    delete record[table];
    assert.throws(
      () => scanSideStore(record, [1, 0], 10),
      /not scorable: .*Rebuild the side-store/s,
      `scanSideStore() must refuse a record with no ${table} table`,
    );
  }

  // The epoch/revision envelope is part of the shape too: an unstamped record
  // cannot be tied to the corpus being queried (ADR 0001 Invariant 8). Every
  // build since this format existed stamps both, so refusing a missing one
  // rejects only a foreign or hand-built record.
  for (const field of ['epoch', 'revision']) {
    const record = fresh();
    delete record[field];
    assert.throws(
      () => scanSideStore(record, [1, 0], 10),
      new RegExp(`the ${field} stamp is missing`),
      `scanSideStore() must refuse a record with no ${field} stamp`,
    );
    record[field] = null;
    assert.throws(() => scanSideStore(record, [1, 0], 10), new RegExp(`the ${field} stamp is missing`));
  }

  // keys is the container of exact primary keys, so a non-array cannot be
  // indexed safely even when its `length` happens to look right.
  const stringKeys = fresh();
  stringKeys.keys = 'best,worst';
  assert.throws(() => scanSideStore(stringKeys, [1, 0], 10), /keys must be an Array or a typed array/);

  // count/dims must be integers the array lengths can be checked against, and
  // count * dims must be exact or the codes length comparison proves nothing.
  for (const [patch, pattern] of [
    [{ count: 2.5 }, /count must be a non-negative integer/],
    [{ count: -1 }, /count must be a non-negative integer/],
    [{ count: '2' }, /count must be a non-negative integer/],
    [{ dims: 0 }, /dims must be a positive integer/],
    [{ dims: 2.5 }, /dims must be a positive integer/],
    [{ count: Number.MAX_SAFE_INTEGER, dims: 3 }, /is not a safe integer/],
  ]) {
    const record = fresh();
    Object.assign(record, patch);
    assert.throws(() => scanSideStore(record, [1, 0], 10), pattern, `shape check must refuse ${JSON.stringify(patch)}`);
  }
  assert.throws(() => scanSideStore(null, [1, 0], 10), /expected a code-record object, got null/);

  // The guard is truncation-only, so a padded record (extra trailing entries
  // that no index below count/dims ever reads) still ranks exactly as before.
  const padded = fresh();
  padded.keys = [...padded.keys, 'extra'];
  padded.norms = new Float64Array([...padded.norms, 99]);
  padded.codes = new Int8Array([...padded.codes, 99, 99]);
  padded.mins = new Float64Array([...padded.mins, -42]);
  padded.scales = new Float64Array([...padded.scales, 42]);
  const paddedTop = scanSideStore(padded, [1, 0], 2).map((c) => c.key);
  const exactTop = scanSideStore(fresh(), [1, 0], 2).map((c) => c.key);
  assert.deepEqual(paddedTop, exactTop);
  assert.equal(paddedTop[0], 'best');

  // An empty corpus stays a no-op rather than a shape error: its tables are
  // genuinely empty and the scan returns [] before reading anything.
  const empty = buildCodeRecord([], { keys: [], epoch: 1 });
  assert.deepEqual(scanSideStore(empty, [], 10), []);
  assert.deepEqual(scanSideStore(fresh(), [1, 0], 0), []);
});

test('an array-like table with only a length is not a shape, and codes is refused by type (bmq review finding)', () => {
  // Review finding on idb-vector-bmq (P2): the first version of this guard only
  // compared lengths, and `{ length: count * dims }` is storable in IndexedDB
  // with the right length and no elements at all - so the NaN came straight
  // back. A table must now be a real indexed container.
  const rows = [
    { embedding: [1, 0] },
    { embedding: [0, 1] },
  ];
  const keys = ['best', 'worst'];
  const fresh = () => buildCodeRecord(rows, { keys, epoch: 1 });

  for (const [table, length, pattern] of [
    ['codes', 4, /codes must be a real Int8Array/],
    ['norms', 2, /norms must be an Array or a typed array/],
    ['mins', 2, /mins must be an Array or a typed array/],
    ['scales', 2, /scales must be an Array or a typed array/],
    ['keys', 2, /keys must be an Array or a typed array/],
  ]) {
    const record = fresh();
    record[table] = { length };
    assert.throws(
      () => scanSideStore(record, [1, 0], 10),
      pattern,
      `a ${table} table that only reports a length has nothing to read and must be refused`,
    );
  }

  // codes is the only table too big to value-check on the hot path, so it is
  // pinned to the format's own type: a float table can hold NaN with the exact
  // right length, and an integer container cannot.
  const floatCodes = fresh();
  floatCodes.codes = new Float64Array(floatCodes.count * floatCodes.dims);
  floatCodes.codes[0] = Number.NaN;
  assert.throws(() => scanSideStore(floatCodes, [1, 0], 10), /codes must be a real Int8Array/);

  // A NaN min would poison baseOffset for every score, which no per-row tripwire
  // can see, so mins is value-checked up front (dims long, off the hot loop).
  const nanMin = fresh();
  nanMin.mins = Float64Array.from(nanMin.mins);
  nanMin.mins[1] = Number.NaN;
  assert.throws(() => scanSideStore(nanMin, [1, 0], 10), /mins\[1\] is NaN/);

  // Legacy Float32 tables with sane values still scan: only the container shape
  // is strict, the value tripwires stay the ones that refuse a degenerate record.
  const legacy = fresh();
  legacy.norms = Float32Array.from(legacy.norms);
  legacy.mins = Float32Array.from(legacy.mins);
  legacy.scales = Float32Array.from(legacy.scales);
  assert.deepEqual(scanSideStore(legacy, [1, 0], 2).map((c) => c.key), ['best', 'worst']);
});

test('codes identity is the internal slot, not a forgeable brand, and a sparse keys table is refused (idb-vector-44v)', () => {
  // Review finding idb-vector-44v: Symbol.toStringTag is an own property, so a
  // SPARSE Array wearing a forged 'Int8Array' tag passed the previous brand
  // check and ranked [{"key":"worst","score":"NaN"},{"key":"best","score":"NaN"}].
  const rows = [
    { embedding: [1, 0] },
    { embedding: [0, 1] },
  ];
  const keys = ['best', 'worst'];
  const fresh = () => buildCodeRecord(rows, { keys, epoch: 1 });

  const forged = fresh();
  const sparse = new Array(forged.count * forged.dims);
  Object.defineProperty(sparse, Symbol.toStringTag, { value: 'Int8Array' });
  assert.equal(Object.prototype.toString.call(sparse), '[object Int8Array]', 'the tag really does fool toString');
  assert.deepEqual(scanSideStore(fresh(), [1, 0], 2).map((c) => c.key), ['best', 'worst'], 'the pristine record scans');
  forged.codes = sparse;
  assert.throws(() => scanSideStore(forged, [1, 0], 2), /codes must be a real Int8Array/,
    'a sparse Array with a forged tag is not an Int8Array');

  // A prototype-only fake passes `instanceof` but has no internal slot.
  const fakeProto = fresh();
  fakeProto.codes = Object.create(Int8Array.prototype);
  Object.defineProperty(fakeProto.codes, 'length', { value: fakeProto.count * fakeProto.dims });
  assert.throws(() => scanSideStore(fakeProto, [1, 0], 2), /codes must be a real Int8Array/);

  // An object with only a tag and a length is not a container at all.
  const taggedObject = fresh();
  taggedObject.codes = { length: taggedObject.count * taggedObject.dims, [Symbol.toStringTag]: 'Int8Array' };
  assert.throws(() => scanSideStore(taggedObject, [1, 0], 2), /codes must be a real Int8Array/);

  // A genuine Int8Array still scans: the check refuses forgeries, not the format.
  assert.deepEqual(scanSideStore(fresh(), [1, 0], 2).map((c) => c.key), ['best', 'worst']);

  // Sparse metadata tables: holes are refused where they are read, so no sparse
  // table can produce a candidate set built from undefined values.
  const sparseExpectations = [
    ['norms', 2, /non-finite or zero norm/],
    ['mins', 2, /mins\[0\] is undefined/],
    ['scales', 2, /non-positive or non-finite scale/],
    ['keys', 2, /no primary key at index 0/],
  ];
  for (const [table, length, pattern] of sparseExpectations) {
    const record = fresh();
    record[table] = new Array(length); // holes, correct length
    assert.throws(() => scanSideStore(record, [1, 0], 2), pattern,
      `a sparse ${table} table must be refused, not ranked from undefined`);
  }
});

test('codes length comes from the intrinsic getter, so an own length cannot lie (idb-vector-5xr)', () => {
  // Coord ruling after the third review round: read the length through
  // %TypedArray%.prototype's accessor, because `length` is configurable on an
  // instance and an own property shadows it. On f10746d this exact object
  // passed ArrayBuffer.isView + instanceof + the .length comparison and ranked
  // [{"key":"worst","score":"NaN"},{"key":"best","score":"NaN"}].
  const rows = [
    { embedding: [1, 0] },
    { embedding: [0, 1] },
  ];
  const keys = ['best', 'worst'];
  const fresh = () => buildCodeRecord(rows, { keys, epoch: 1 });

  const shadowed = fresh();
  shadowed.codes = new Int8Array(1);
  Object.defineProperty(shadowed.codes, 'length', { value: shadowed.count * shadowed.dims });
  assert.equal(shadowed.codes.length, 4, 'the own property really does report a length the buffer does not have');
  assert.throws(
    () => scanSideStore(shadowed, [1, 0], 2),
    /codes\.length is 1, expected at least 4/,
    'the buffer is one byte long, whatever the own property claims',
  );

  // The converse pins that the intrinsic getter is what the guard uses: a full
  // buffer wearing a small own length is still the full buffer.
  const lyingSmall = fresh();
  Object.defineProperty(lyingSmall.codes, 'length', { value: 1 });
  assert.deepEqual(scanSideStore(lyingSmall, [1, 0], 2).map((c) => c.key), ['best', 'worst']);

  // THREAT MODEL (documented in assertCodeRecordShape): this guard covers the
  // persist/read-back path - structured clone preserves type and intrinsic
  // length and drops own non-index properties - not an adversarial object built
  // in the caller's own realm. Both directions above are cheap to close, so
  // they are closed; further built-in shadowing is out of scope by ruling.
});

test('a DataView metadata table gets rebuild guidance, not a raw receiver error (idb-vector-usa)', () => {
  // Review finding idb-vector-usa (P3): a DataView survives structured clone and
  // ArrayBuffer.isView accepts it, so the typed-array intrinsic length getter was
  // called on it and threw "Method get TypedArray.prototype.length called on
  // incompatible receiver #<DataView>" before any actionable message. Refusing a
  // record is correct; leaking the engine's error is not.
  const rows = [{ embedding: [1, 0] }];
  const keys = ['best'];
  const fresh = () => buildCodeRecord(rows, { keys, epoch: 1 });

  for (const [table, bytes] of [['norms', 8], ['mins', 8], ['scales', 8], ['keys', 8]]) {
    const record = fresh();
    record[table] = new DataView(new ArrayBuffer(bytes));
    assert.throws(
      // structuredClone mirrors the read-back path the guard exists for.
      () => scanSideStore(structuredClone(record), [1, 0], 2),
      (error) => {
        assert.ok(error instanceof TypeError, `${table}: expected a TypeError, got ${error?.constructor?.name}`);
        assert.doesNotMatch(error.message, /incompatible receiver/, `${table}: must not leak the engine's receiver error: ${error.message}`);
        assert.match(error.message, new RegExp(`^Stored code record is not scorable: ${table} is a DataView`), `${table}: must name the field: ${error.message}`);
        assert.match(error.message, /no typed-array elements to read/, `${table}: must say what is wrong: ${error.message}`);
        assert.match(error.message, /Rebuild the side-store/, `${table}: must say what to do: ${error.message}`);
        return true;
      },
      `${table}: a DataView must be refused with rebuild guidance`,
    );
  }

  // codes already refused a DataView by element type; keep both on one message family.
  const codesView = fresh();
  codesView.codes = new DataView(new ArrayBuffer(1));
  assert.throws(() => scanSideStore(structuredClone(codesView), [1, 0], 2), /codes must be a real Int8Array/);

  // A real Float32Array (legacy tables) is still a typed array and still scans.
  const legacy = fresh();
  legacy.norms = Float32Array.from(legacy.norms);
  legacy.mins = Float32Array.from(legacy.mins);
  legacy.scales = Float32Array.from(legacy.scales);
  assert.deepEqual(scanSideStore(structuredClone(legacy), [1, 0], 2).map((c) => c.key), ['best']);
});
