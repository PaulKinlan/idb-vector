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
