// tests/unit/write-magnitude.test.mjs — the WRITE boundary refuses vectors cosine cannot score.
//
// Cosine similarity is scale-invariant, but its arithmetic is not: scoring squares every coordinate,
// so any |coordinate| above ~1.34e154 (sqrt(Number.MAX_VALUE)) overflows Float64, and any coordinate
// below ~2.2e-162 squares to 0. insert() and update() used to check only shape, finiteness and the
// all-zero rule (idb-vector-1d3), so a vector whose squared magnitude overflowed stored fine — and
// then every query that scanned it rejected WHOLESALE through storedVectorError(): one write made
// the whole store unqueryable, and insert() accepted the same vector again, so the store could not
// even heal itself. The write boundary now enforces the same scoreability the query boundary does
// (assertScoreableStoredVector), BEFORE the transaction opens, so a refused write stores nothing.
//
// The unit tier has no IndexedDB, so each instance below exists only to reach argument validation.
// Constructing it arms a pending open that WILL reject here, and `close()` disarms it before any
// assertion can await: an unhandled rejection would fail the whole runner. Closing also makes a
// write that passes validation fail deterministically with InvalidStateError, so "accepted" never
// depends on the host having a database.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VectorDB } from '../../index.js';

const withValidatingOnlyDB = async (run) => {
  const db = new VectorDB({ dbName: 'unit-write-magnitude', objectStore: 'vectors', vectorPath: 'embedding' });
  const closed = db.close().catch(() => {});
  try {
    return await run(db);
  } finally {
    await closed;
  }
};

test('insert() and update() refuse a vector whose squared magnitude overflows Float64 (idb-vector-1d3)', async () => {
  await withValidatingOnlyDB(async (db) => {
    const overflowing = [0, 1e160];
    const writes = [
      ['insert', () => db.insert({ embedding: overflowing })],
      ['update', () => db.update(1, { embedding: overflowing })],
    ];

    for (const [name, run] of writes) {
      await assert.rejects(run, (error) => {
        assert.ok(
          error instanceof TypeError,
          `${name}() must refuse an unscoreable vector with a TypeError; got ${error?.constructor?.name}: ${error?.message}`
        );
        assert.match(
          error.message,
          /non-finite L2 magnitude \(Infinity\)/,
          `${name}() message must name the magnitude the store cannot use: ${error.message}`
        );
        assert.match(
          error.message,
          /Normalize the vector first/,
          `${name}() message must say what to do instead: ${error.message}`
        );
        return true;
      }, `${name}() must refuse a vector whose squared magnitude overflows Float64`);
    }
  });
});

test('insert() and update() refuse a vector whose squared magnitude underflows to 0', async () => {
  // 1e-200 squares to 0 in Float64, so the magnitude is 0 and every cosine score against the stored
  // record would be dot / (queryNorm * 0) = Infinity — the same wholesale query rejection as the
  // overflow case, so the write boundary refuses it for the same reason.
  await withValidatingOnlyDB(async (db) => {
    const underflowing = [1e-200, 0];
    const writes = [
      ['insert', () => db.insert({ embedding: underflowing })],
      ['update', () => db.update(1, { embedding: underflowing })],
    ];

    for (const [name, run] of writes) {
      await assert.rejects(run, (error) => {
        assert.ok(
          error instanceof TypeError,
          `${name}() must refuse an underflowing vector with a TypeError; got ${error?.constructor?.name}: ${error?.message}`
        );
        assert.match(error.message, /underflows Float64/, `${name}() message must name the underflow: ${error.message}`);
        assert.match(error.message, /Normalize or scale the vector before storing it/, `${name}() message must say what to do: ${error.message}`);
        assert.ok(!/stored vectorPath/.test(error.message), `${name}() must not blame a stored record for the caller's vector: ${error.message}`);
        return true;
      }, `${name}() must refuse a vector whose magnitude underflows to 0`);
    }
  });
});

test('insert() and update() read an accessor-backed vector exactly once (idb-vector-qnh)', async () => {
  // An accessor can return a different array on every read: [0, 1] on the first, [1e200, 0]
  // afterwards. A write path that reads the property once to validate and again to snapshot would
  // validate the first array and persist the second - the bypass the reviewer reproduced. The
  // write path must take ONE read pass; the assertion below counts the getter invocations.
  await withValidatingOnlyDB(async (db) => {
    for (const [name, run] of [
      ['insert', (row) => db.insert(row)],
      ['update', (row) => db.update(1, row)],
    ]) {
      const state = { reads: 0 };
      const row = {};
      Object.defineProperty(row, 'embedding', {
        enumerable: true,
        get() {
          state.reads += 1;
          return state.reads === 1 ? [0, 1] : [1e200, 0];
        },
      });
      // The harness has no database: a write that passes validation rejects with
      // InvalidStateError (non-TypeError). Any second read of the property would return the
      // overflowing array - and either a TypeError from validation or a persisted overflow.
      await assert.rejects(run(row), (error) => {
        assert.ok(!(error instanceof TypeError), `${name}() must not refuse the vector it read on the single pass; got ${error?.message}`);
        return true;
      }, `${name}() must validate exactly the vector it snapshotted`);
      assert.equal(state.reads, 1, `${name}() must read the caller's vector exactly once, got ${state.reads}`);
    }
  });
});

test('a vector below the overflow boundary is still accepted by both write paths', async () => {
  // 1e150 squares to 1e300, which fits, and 1e-160 squares to the smallest subnormal: both must get
  // past argument validation and fail only because this harness has no database. Any TypeError here
  // means the guard overshot and would reject legitimate embeddings.
  await withValidatingOnlyDB(async (db) => {
    const writes = [
      ['insert', (vector) => db.insert({ embedding: vector })],
      ['update', (vector) => db.update(1, { embedding: vector })],
    ];

    for (const [name, run] of writes) {
      for (const scoreable of [[0, 1e150], [1e-160, 1]]) {
        await assert.rejects(run(scoreable), (error) => {
          assert.ok(
            !(error instanceof TypeError),
            `${name}() must not refuse a representable vector ${JSON.stringify(scoreable)}; got TypeError: ${error?.message}`
          );
          return true;
        }, `${name}() must accept a representable vector`);
      }
    }
  });
});
