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
