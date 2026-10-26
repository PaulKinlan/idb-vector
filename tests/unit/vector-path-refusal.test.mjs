// tests/unit/vector-path-refusal.test.mjs — vectorPath resolution in the side-store build.
//
// idb-vector-5mt (restated after the FAIL on 1a1a5df): the rule has two branches.
//  * vectorPath OMITTED: the legacy public shape — read the default property, else the legacy
//    'vector' column. Unchanged behaviour; buildCodeRecord([{vector:[...]}], ...) must keep working.
//  * vectorPath SUPPLIED: strict — the record must have that own property, refused with the
//    missing property and key named; a stray 'vector' column is ignored, never silently scored.
// The main write path (index.js insert()) always has a configured vectorPath and refuses the
// same record; a legitimate record still works on both paths.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodeRecord } from '../../utils/side-store.js';
import { VectorDB } from '../../index.js';

test('legacy branch: vectorPath omitted accepts the vector column and the default property', () => {
  const legacy = buildCodeRecord([{ vector: [3, 4] }], { keys: ['k'], epoch: 1 });
  assert.equal(legacy.dims, 2);
  assert.ok(Math.abs(legacy.norms[0] - 5) < 1e-12, 'the legacy .vector column is what gets scored');

  const def = buildCodeRecord([{ embedding: [1, 0] }], { keys: ['k'], epoch: 1 });
  assert.equal(def.dims, 2);
  // Default property wins over a stray vector column, as before:
  const both = buildCodeRecord([{ embedding: [1, 0], vector: [9, 9] }], { keys: ['k'], epoch: 1 });
  assert.ok(Math.abs(both.norms[0] - 1) < 1e-12);
});

test('strict branch: vectorPath supplied refuses a record that lacks it, even with a stray vector column', () => {
  for (const record of [{ embedding2: [1, 0] }, { vector: [9, 9] }]) {
    assert.throws(
      () => buildCodeRecord([record], { keys: ['k'], epoch: 1, vectorPath: 'embedding' }),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /no own 'embedding' property/, 'names the missing property');
        assert.match(error.message, /"k"/, 'names the record key');
        assert.match(error.message, /stray 'vector' column is not read/, 'says the fallback is gone');
        return true;
      },
    );
  }
  // Supplied and present: accepted, and the stray column is still ignored.
  const strict = buildCodeRecord([{ embedding: [1, 0], vector: [9, 9] }], { keys: ['k'], epoch: 1, vectorPath: 'embedding' });
  assert.ok(Math.abs(strict.norms[0] - 1) < 1e-12);
});

test('insert() refuses the missing-vectorPath record like the strict branch (main path parity)', async () => {
  const db = new VectorDB({ dbName: 'unit-vpath', objectStore: 'vectors', vectorPath: 'embedding' });
  const closed = db.close().catch(() => {});
  try {
    await assert.rejects(db.insert({ vector: [9, 9] }), (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /no 'embedding' property/);
      return true;
    });
    // A legitimate record passes validation; with the database closed the write fails only at
    // the transaction.
    await assert.rejects(db.insert({ embedding: [1, 0] }), (error) => {
      assert.doesNotMatch(String(error), /vectorPath|no 'embedding'/);
      return true;
    });
  } finally {
    await closed;
  }
});
