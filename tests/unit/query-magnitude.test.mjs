// tests/unit/query-magnitude.test.mjs — a query this library cannot score must be refused.
//
// Cosine similarity is scale-invariant, but its intermediates are not: the scoring arithmetic squares
// every coordinate, so any |coordinate| above ~1.34e154 (sqrt(Number.MAX_VALUE)) overflows Float64.
// The query magnitude then became Infinity, each score collapsed to finite/Infinity = 0, and
// SortedArray reported an all-tie corpus - insertion order returned as a confident ranking
// (idb-vector-utq). Every entry point must refuse such a query, and refuse it BEFORE opening the
// database: a refusal that needs a cursor is one a caller can miss, and it is also the only way to
// assert it in the fast unit tier, which has no IndexedDB.
//
// The unit tier has no IndexedDB, so each instance below exists only to reach argument validation.
// Constructing it arms a pending open that WILL reject here, and `close()` disarms it before any
// assertion can await: an unhandled rejection would fail the whole runner. Closing also makes a
// query that passes validation fail deterministically with InvalidStateError, so "accepted" never
// depends on the host having a database.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VectorDB } from '../../index.js';

const withValidatingOnlyDB = async (run) => {
  const db = new VectorDB({ dbName: 'unit-query-magnitude', objectStore: 'vectors', vectorPath: 'embedding' });
  const closed = db.close().catch(() => {});
  try {
    return await run(db);
  } finally {
    await closed;
  }
};

test('query(), queryCandidates() and querySideStore() all refuse a query whose L2 magnitude overflows Float64', async () => {
  await withValidatingOnlyDB(async (db) => {
    const overflowing = [0, 1e160];
    const entryPoints = [
      ['query', () => db.query(overflowing, { limit: 1 })],
      ['queryCandidates', () => db.queryCandidates(overflowing, { limit: 1 })],
      ['querySideStore', () => db.querySideStore(overflowing, { epoch: 1, getEpoch: async () => 1 })],
    ];

    for (const [name, run] of entryPoints) {
      await assert.rejects(run, (error) => {
        assert.ok(
          error instanceof TypeError,
          `${name}() must refuse an unscoreable query with a TypeError; got ${error?.constructor?.name}: ${error?.message}`
        );
        assert.match(
          error.message,
          /non-finite L2 magnitude \(Infinity\)/,
          `${name}() message must name the magnitude the caller cannot use: ${error.message}`
        );
        assert.match(
          error.message,
          /Normalize the vector first/,
          `${name}() message must say what to do instead: ${error.message}`
        );
        return true;
      }, `${name}() must refuse a query whose magnitude overflows Float64`);
    }
  });
});

test('a query below the overflow boundary is still accepted by all three entry points', async () => {
  // 1e150 squares to 1e300, which fits: the query must get past argument validation and fail only
  // because this harness has no database. Any TypeError here means the guard overshot.
  await withValidatingOnlyDB(async (db) => {
    const scoreable = [0, 1e150];
    const entryPoints = [
      ['query', () => db.query(scoreable, { limit: 1 })],
      ['queryCandidates', () => db.queryCandidates(scoreable, { limit: 1 })],
      ['querySideStore', () => db.querySideStore(scoreable, { epoch: 1, getEpoch: async () => 1 })],
    ];

    for (const [name, run] of entryPoints) {
      await assert.rejects(run, (error) => {
        assert.ok(
          !(error instanceof TypeError),
          `${name}() must not refuse a representable query; got TypeError: ${error?.message}`
        );
        return true;
      }, `${name}() must accept a representable query`);
    }
  });
});
