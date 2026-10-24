import assert from 'node:assert/strict';
import test from 'node:test';
import { createPackedSnapshot } from '../../utils/packed-snapshot.js';

// Cursor/transaction event ordering matches the IndexedDB operations used by the snapshot.
function database(rows) {
  return {
    transaction() {
      let position = 0;
      const tx = {
        objectStore() {
          return {
            openCursor() {
              const request = {};
              const next = () => {
                const row = rows[position++];
                request.result = row && {
                  key: row.key,
                  value: row.value,
                  continue: () => queueMicrotask(next),
                };
                request.onsuccess?.();
                if (!row) tx.oncomplete?.();
              };
              queueMicrotask(next);
              return request;
            },
          };
        },
      };
      return tx;
    },
  };
}

const cosine = (a, b) => {
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  const norm = vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return dot / (norm(a) * norm(b));
};

test('live fallback preserves string keys but never ranks malformed or undefined-score vectors', async () => {
  const rows = [
    { key: 1, value: { embedding: [1, 0] } },
    { key: 2, value: { embedding: [NaN, 0] } },
    { key: 3, value: { embedding: [Infinity, 0] } },
    { key: 4, value: { embedding: '10' } },
    { key: 5, value: { title: 'missing' } },
    { key: 6, value: { embedding: [0, 0] } },
    { key: 8, value: { embedding: [1] } },
    { key: 'string-key', value: { embedding: [0, 1] } },
  ];
  const snapshot = await createPackedSnapshot(database(rows), 'vectors', 'embedding', { maxBytes: 0 }, cosine);
  assert.equal(snapshot.mode, 'live');
  assert.equal(snapshot.reason, 'memory-budget');
  assert.deepEqual(Array.from((await snapshot.query([1, 0])).results), [
    { key: 1, similarity: 1 },
    { key: 'string-key', similarity: 0 },
  ]);
  snapshot.close();
});

test('packed mode does not rank undefined cosine scores', async () => {
  const rows = [
    { key: 1, value: { embedding: [1, 0] } },
    { key: 2, value: { embedding: [0, 0] } },
  ];
  const snapshot = await createPackedSnapshot(database(rows), 'vectors', 'embedding', { maxBytes: 128 }, cosine);
  assert.equal(snapshot.mode, 'snapshot');
  assert.deepEqual(Array.from((await snapshot.query([1, 0])).results), [{ key: 1, similarity: 1 }]);
  snapshot.close();
});

test('a supplied query validator runs before either path reads anything (idb-vector-2yi)', async () => {
  // index.js passes its own query validator so a snapshot query is refused exactly as query() is.
  // The order matters as much as the refusal: validating after the cursor starts is what made the
  // live path throw inside onsuccess and escape the surrounding promise.
  const rows = [{ key: 1, value: { embedding: [1, 0] } }];
  const fake = database(rows);
  let transactions = 0;
  const counting = { transaction: (...args) => { transactions += 1; return fake.transaction(...args); } };
  const calls = [];
  const validate = (query, label) => { calls.push([query, label]); throw new TypeError('refused by the query validator'); };

  const snapshot = await createPackedSnapshot(counting, 'vectors', 'embedding', { maxBytes: 0 }, cosine, validate);
  assert.equal(snapshot.mode, 'live');
  const openedByRefresh = transactions;
  await assert.rejects(snapshot.query([1, 0]), /refused by the query validator/);
  assert.deepEqual(calls, [[[1, 0], 'Snapshot query']], 'the validator sees the query and a label it can name');
  assert.equal(transactions, openedByRefresh, 'no transaction may be opened before the validator refuses');
  snapshot.close();
});

test('snapshot queries report how many stored records they skipped, by cause (idb-vector-6bq)', async () => {
  // Refusing an unusable record is deliberate (idb-vector-bob), but the refusal
  // used to be invisible: a caller could not tell "no match" from "part of this
  // corpus can never be searched". Every skip is now counted by cause.
  const rows = [
    { key: 1, value: { embedding: [1, 0] } },
    { key: 2, value: { embedding: [NaN, 0] } }, // not a finite vector
    { key: 3, value: { embedding: [1] } }, // finite, but the wrong dimension
    { key: 4, value: { embedding: [0, 0] } }, // cosine is 0/0
    { key: 5, value: { title: 'missing' } }, // no vector at all
  ];

  // Live fallback: nothing is packed, so every refusal happens per record here.
  const live = await createPackedSnapshot(database(rows), 'vectors', 'embedding', { maxBytes: 0 }, cosine);
  assert.equal(live.mode, 'live');
  const liveResult = await live.query([1, 0]);
  assert.deepEqual(Array.from(liveResult.results), [{ key: 1, similarity: 1 }], 'a skipped record must never enter top-k');
  assert.deepEqual(liveResult.skipped, {
    total: 4,
    dimensionMismatch: 1,
    unsupportedVector: 2,
    nonFiniteSimilarity: 1,
  });
  live.close();

  // Snapshot mode: a non-finite or missing vector evicts the packed cache
  // entirely (refresh's `reason`), so the per-record skips that remain are a
  // wrong-length record and a zero vector.
  const packedRows = [
    { key: 1, value: { embedding: [1, 0] } },
    { key: 3, value: { embedding: [1] } },
    { key: 4, value: { embedding: [0, 0] } },
  ];
  const packed = await createPackedSnapshot(database(packedRows), 'vectors', 'embedding', { maxBytes: 128 }, cosine);
  assert.equal(packed.mode, 'snapshot');
  const packedResult = await packed.query([1, 0]);
  assert.deepEqual(Array.from(packedResult.results), [{ key: 1, similarity: 1 }]);
  assert.deepEqual(packedResult.skipped, {
    total: 2,
    dimensionMismatch: 1,
    unsupportedVector: 0,
    nonFiniteSimilarity: 1,
  });
  packed.close();

  // A clean corpus reports zero skips, so an incomplete result set is never guessed at.
  const clean = await createPackedSnapshot(database([{ key: 1, value: { embedding: [1, 0] } }]), 'vectors', 'embedding', { maxBytes: 128 }, cosine);
  const cleanResult = await clean.query([1, 0]);
  assert.deepEqual(cleanResult.skipped, { total: 0, dimensionMismatch: 0, unsupportedVector: 0, nonFiniteSimilarity: 0 });
  clean.close();
});

test('a record whose squared magnitude overflows Float64 is refused by key, not ranked at 0 (idb-vector-c2o)', { timeout: 10000 }, async () => {
  // idb-vector-c2o: query() refuses such a record by key (idb-vector-cfr), but the snapshot entry
  // point left both of its modes ranking it at exactly 0 - indistinguishable from a genuinely
  // orthogonal record, and invisible to Number.isFinite() because the score really is 0.
  const rows = [
    { key: 1, value: { embedding: [1, 0] } }, // similarity 1
    { key: 2, value: { embedding: [0, 1] } }, // legitimately orthogonal: a real 0
    { key: 54, value: { embedding: [1e200, 0] } }, // finite coordinates, squared magnitude overflows
  ];
  const refusal = (error) => {
    assert.ok(error instanceof TypeError, `expected a TypeError, got ${error?.constructor?.name}`);
    assert.match(error.message, /key 54/, `the refusal must name the record: ${error.message}`);
    assert.match(error.message, /overflows cosine similarity/, `the refusal must name the cause: ${error.message}`);
    assert.match(error.message, /Scale that vector to a sane magnitude or delete it/, `the refusal must say what to do: ${error.message}`);
    return true;
  };

  const packed = await createPackedSnapshot(database(rows), 'vectors', 'embedding', { maxBytes: 1024 }, cosine);
  assert.equal(packed.mode, 'snapshot');
  await assert.rejects(packed.query([1, 0]), refusal, 'snapshot mode must refuse the overflowing record');
  packed.close();

  // The live path's refusal happens inside an IndexedDB callback, so it has to REJECT the query
  // promise: a throw there would escape the promise and leave the query pending (idb-vector-2yi).
  const live = await createPackedSnapshot(database(rows), 'vectors', 'embedding', { maxBytes: 0 }, cosine);
  assert.equal(live.mode, 'live');
  await assert.rejects(live.query([1, 0]), refusal, 'live mode must refuse the overflowing record, not hang');
  live.close();

  // idb-vector-dy5: a representable but large QUERY (1e150) makes the dot product overflow to
  // Infinity while the record's own norm also overflows, so cosine is Infinity/Infinity = NaN
  // rather than 0. Checking only the 0 shape let the live path skip the record instead of refusing
  // it, while snapshot mode refused it. Both shapes must name the record.
  const overflowRows = [{ key: 54, value: { embedding: [1e200, 0] } }];
  const hugeQuery = [1e150, 0];
  const packedHuge = await createPackedSnapshot(database(overflowRows), 'vectors', 'embedding', { maxBytes: 1024 }, cosine);
  assert.equal(packedHuge.mode, 'snapshot');
  await assert.rejects(packedHuge.query(hugeQuery), refusal, 'snapshot mode must refuse it for a large query too');
  packedHuge.close();
  const liveHuge = await createPackedSnapshot(database(overflowRows), 'vectors', 'embedding', { maxBytes: 0 }, cosine);
  assert.equal(liveHuge.mode, 'live');
  await assert.rejects(liveHuge.query(hugeQuery), refusal, 'live mode must refuse it, not skip it as a non-finite score');
  liveHuge.close();

  // A zero vector still skips (its norm is representable; NaN is a corpus-shape fact, not this bug).
  const zero = await createPackedSnapshot(database([{ key: 7, value: { embedding: [0, 0] } }]), 'vectors', 'embedding', { maxBytes: 0 }, cosine);
  const zeroResult = await zero.query(hugeQuery);
  assert.deepEqual(zeroResult.skipped, { total: 1, dimensionMismatch: 0, unsupportedVector: 0, nonFiniteSimilarity: 1 });
  zero.close();

  // The refusal is about magnitude, not about a zero score: an orthogonal record with a
  // representable magnitude still ranks 0 and is reported as a match.
  const clean = await createPackedSnapshot(database(rows.slice(0, 2)), 'vectors', 'embedding', { maxBytes: 1024 }, cosine);
  const cleanResult = await clean.query([1, 0]);
  assert.deepEqual(Array.from(cleanResult.results), [{ key: 1, similarity: 1 }, { key: 2, similarity: 0 }]);
  assert.equal(cleanResult.skipped.total, 0);
  clean.close();
});

// idb-vector-cej: the writer and the reader validated different option lists, so a key nobody honoured
// was silently dropped. `createSnapshot({ maxBytes, limit })` created a snapshot the caller believed was
// bounded by limit; `snapshot.query(v, { limit: NaN })` disabled SortedArray's truncation test (the
// ranking grows with the corpus) and a negative limit inverted slice(0, limit). Both entry points now
// read the shared contract in utils/options.js and refuse, so a typo is an error rather than a silently
// different result set. The accept path is proven by reaching the cursor, the reject path by never
// touching the database at all.
const untouched = { transaction() { throw new Error('the database must not be touched'); } };

test('createSnapshot refuses options it does not honour instead of dropping them', async () => {
  await assert.rejects(
    createPackedSnapshot(untouched, 'vectors', 'embedding', { maxBytes: 0, limit: 5 }, cosine),
    { name: 'TypeError', message: /createSnapshot\(\) option "limit" is not supported; createSnapshot\(\) options are maxBytes\. Query options \(limit, threshold\) belong on the returned snapshot's query\(\)/ },
  );
  await assert.rejects(
    createPackedSnapshot(untouched, 'vectors', 'embedding', { maxBytes: 0, threshold: 0.5 }, cosine),
    { name: 'TypeError', message: /createSnapshot\(\) option "threshold" is not supported/ },
  );
  // A missing or non-object options argument names the shape it wants, rather than destructuring undefined.
  for (const absent of [undefined, null, 4, 'maxBytes', [1024]]) {
    await assert.rejects(
      createPackedSnapshot(untouched, 'vectors', 'embedding', absent, cosine),
      { name: 'TypeError', message: /createSnapshot\(\) options must be an object such as \{ maxBytes: 64 \* 1024 \* 1024 \}/ },
      `expected a refusal for ${JSON.stringify(absent)}`,
    );
  }
  // The budget itself keeps its limits, now with a message that says what the number is for.
  for (const maxBytes of [NaN, -1, 1.5, '1024', Infinity]) {
    await assert.rejects(
      createPackedSnapshot(untouched, 'vectors', 'embedding', { maxBytes }, cosine),
      { name: 'TypeError', message: /createSnapshot\(\) maxBytes must be a nonnegative safe integer byte budget/ },
      `expected a refusal for maxBytes ${String(maxBytes)}`,
    );
  }
});

test('snapshot.query applies the query limit contract and refuses keys it cannot honour', async () => {
  const rows = [{ key: 1, value: { embedding: [1, 0] } }, { key: 2, value: { embedding: [0, 1] } }];
  const snapshot = await createPackedSnapshot(database(rows), 'vectors', 'embedding', { maxBytes: 0 }, cosine);
  try {
    // Reject path: the same limit refusal db.query() gives, before any read happens.
    for (const limit of [NaN, 0, -3, 3.14, '10', Infinity]) {
      await assert.rejects(
        snapshot.query([1, 0], { limit }),
        { name: 'RangeError', message: /limit must be a positive integer/ },
        `expected a limit refusal for ${String(limit)}`,
      );
    }
    await assert.rejects(
      snapshot.query([1, 0], { threshold: 0.5 }),
      { name: 'TypeError', message: /snapshot\.query\(\) option "threshold" is not supported; snapshot\.query\(\) options are limit\./ },
    );
    await assert.rejects(
      snapshot.query([1, 0], { maxBytes: 128 }),
      { name: 'TypeError', message: /snapshot\.query\(\) option "maxBytes" is not supported/ },
    );
    for (const options of [4, 'limit', [10]]) {
      await assert.rejects(
        snapshot.query([1, 0], options),
        { name: 'TypeError', message: /snapshot\.query\(\) options must be an object such as \{ limit: 10 \}/ },
        `expected an options-shape refusal for ${JSON.stringify(options)}`,
      );
    }

    // Accept path: the default limit and an explicit one both rank exactly as before.
    const all = await snapshot.query([1, 0]);
    assert.deepEqual(Array.from(all.results), [{ key: 1, similarity: 1 }, { key: 2, similarity: 0 }]);
    const one = await snapshot.query([1, 0], { limit: 1 });
    assert.deepEqual(Array.from(one.results), [{ key: 1, similarity: 1 }]);
  } finally {
    snapshot.close();
  }
});
