// tests/unit/write-proto-safety.test.mjs — the write boundary respects own-property semantics.
//
// idb-vector-56b (nightly threat-model row, repro verified on c971bb2): insert()/update() rebuilt
// the persisted record with bracket assignment on a plain {}, so an own enumerable '__proto__'
// field (JSON.parse produces one) invoked the inherited setter — the field was silently DROPPED
// and the copy's [[Prototype]] became the caller's value, which the structured clone then dropped.
// No pollution escaped, but the store silently lost caller data on the path whose contract is
// "what was validated is what is persisted". The copy is now null-prototype (no inherited setter),
// and vectorPath '__proto__' is refused outright because plain-record property access could never
// read it as an own value.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { copyRecordForStore } from '../../utils/record-copy.js';
import { VectorDB } from '../../index.js';

test("an own '__proto__' field is kept as data, never routed through the prototype setter", () => {
  const source = JSON.parse('{"a":1,"__proto__":{"polluted":1}}');
  const vector = [1, 0];
  const record = copyRecordForStore(source, 'embedding', vector);

  assert.ok(Object.hasOwn(record, '__proto__'), 'the field survives the copy as an own property');
  assert.deepEqual(record['__proto__'], { polluted: 1 });
  assert.equal(Object.getPrototypeOf(record), null, 'no inherited setter exists on the copy');
  assert.equal({}.polluted, undefined, 'nothing polluted the shared prototype');
  assert.equal(record.a, 1);
  assert.equal(record.embedding, vector, 'the snapshot is set, not re-read from the caller');

  // The store round-trip: structured clone keeps own data properties regardless of name.
  const clone = structuredClone(record);
  assert.ok(Object.hasOwn(clone, '__proto__'), 'structured clone does not drop the field');
  assert.deepEqual(clone['__proto__'], { polluted: 1 });
  assert.equal(Object.getPrototypeOf(clone), Object.prototype, 'the clone is an ordinary object');
  assert.equal(clone.embedding[0], 1);
});

test('a legitimate record round-trips whole, including other dunder-adjacent names', () => {
  const source = { constructor: 'field', prototype: 42, hasOwnProperty: 'shadowed', name: 'ok' };
  const record = copyRecordForStore(source, 'embedding', [0, 1]);
  const clone = structuredClone(record);
  for (const key of Object.keys(source)) {
    assert.ok(Object.hasOwn(clone, key), `${key} survives`);
    assert.equal(clone[key], source[key]);
  }
});

test("vectorPath '__proto__' is refused with an actionable error", () => {
  assert.throws(
    () => new VectorDB({ dbName: 'unit-proto', objectStore: 'vectors', vectorPath: '__proto__' }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /must not be '__proto__'/);
      assert.match(error.message, /normal property name/, 'the message says what to do instead');
      return true;
    },
  );
});

test("the published vectorPath contract documents both construction refusals", () => {
  // index.js's validation comment says the contract is 'documented in README.md'; a refusal the
  // README does not name is a surprise at construction (review finding idb-vector-6lz).
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  assert.match(readme, /dotted name[^\n]*refused/i, 'the dotted-name refusal is documented');
  assert.match(readme, /"__proto__"[^\n]*refused/i, 'the __proto__ refusal is documented');
});

test("insert() accepts a record whose own '__proto__' field is data, and still fails only at the store", async () => {
  const db = new VectorDB({ dbName: 'unit-proto-write', objectStore: 'vectors', vectorPath: 'embedding' });
  const closed = db.close().catch(() => {});
  try {
    const source = JSON.parse('{"a":1,"__proto__":{"kept":true},"embedding":[1,0]}');
    // With the database closed the write can only fail at the transaction; a TypeError here would
    // mean the write path rejected or mishandled the field name instead of copying it.
    await assert.rejects(db.insert(source), (error) => {
      assert.doesNotMatch(String(error), /__proto__/);
      return true;
    });
  } finally {
    await closed;
  }
});
