// tests/unit/vector-path-refusal.test.mjs — a record missing its configured vectorPath is
// REFUSED on both read/write paths, never silently re-read from a different field.
//
// idb-vector-5mt: the side-store build (utils/side-store.js) fell back to '?? rec.vector' when
// the configured vectorPath was absent, so it scored whatever happened to live in .vector — a
// field the caller never configured — while the main path (index.js insert()) refuses that
// record. Both paths must refuse the same way, and a legitimate record must still work on both.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodeRecord } from '../../utils/side-store.js';
import { VectorDB } from '../../index.js';

const missing = { embedding2: [1, 0] }; // no 'embedding' property; a stray .vector must not rescue it
const stray = { vector: [9, 9] };

test('buildCodeRecord refuses a record that lacks the configured vectorPath, even with a .vector field', () => {
  for (const record of [missing, stray]) {
    assert.throws(
      () => buildCodeRecord([record], { keys: ['k'], epoch: 1 }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /no 'embedding' property/);
        assert.match(error.message, /vectorPath/, 'the message names the fix');
        return true;
      },
    );
  }
  // A custom vectorPath is honoured by name, not by fallback:
  assert.throws(
    () => buildCodeRecord([{ embedding: [1, 0] }], { keys: ['k'], epoch: 1, vectorPath: 'vec' }),
    /no 'vec' property/,
  );
});

test('insert() refuses the same record the same way (main path parity)', async () => {
  const db = new VectorDB({ dbName: 'unit-vpath', objectStore: 'vectors', vectorPath: 'embedding' });
  const closed = db.close().catch(() => {});
  try {
    for (const record of [missing, stray]) {
      await assert.rejects(db.insert(record), (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /no 'embedding' property/);
        return true;
      });
    }
  } finally {
    await closed;
  }
});

test('a legitimate record is accepted on both paths, unchanged in shape', async () => {
  const good = [{ embedding: [1, 0] }, { embedding: [0, 1] }];
  const record = buildCodeRecord(good, { keys: ['a', 'b'], epoch: 1 });
  assert.equal(record.count, 2);
  assert.equal(record.dims, 2);
  assert.ok(record.codes instanceof Int8Array && record.norms instanceof Float64Array);

  const db = new VectorDB({ dbName: 'unit-vpath-ok', objectStore: 'vectors', vectorPath: 'embedding' });
  const closed = db.close().catch(() => {});
  try {
    // Validation must PASS; with the database closed the write can only fail at the transaction.
    await assert.rejects(db.insert(good[0]), (error) => {
      assert.doesNotMatch(String(error), /vectorPath|no 'embedding'/);
      return true;
    });
  } finally {
    await closed;
  }
});
