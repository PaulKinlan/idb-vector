// tests/unit/options-prototype-keys.test.mjs — the option allow-list sees the whole prototype chain.
//
// idb-vector-v743 (nightly repro verified on 7e835de): assertOptionKeys walked Object.keys(options), so a
// key inherited from the options object's prototype was invisible to the check while every call site
// reads options by property access, which does see it. `db.query(v, Object.create({ predicate }))`
// therefore passed validation and returned the unfiltered ranking that looked filtered — exactly the
// closed idb-vector-5a8 regression, and the I4 invariant utils/options.js's header claims to enforce.
// The list now walks the chain (for...in) and refuses an inherited key with the same message as an own
// one, naming where the key came from; an inherited key that IS on the list stays accepted, because
// property access does read it and the method does honour it. `__proto__` keeps the refusal convention
// the write boundary (utils/record-copy.js) and vectorPath already use: an own '__proto__' key names the
// prototype accessor rather than an option, so it is refused with a message that says so, and no
// allow-list entry can turn it into a prototype mutation.
//
// Pure unit: no IndexedDB, no browser, no sockets. Refusals happen before any connection or read, and the
// accept path is proven against a fake in-memory database.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VectorDB } from '../../index.js';
import { createPackedSnapshot } from '../../utils/packed-snapshot.js';
import { CANDIDATE_OPTION_KEYS, QUERY_OPTION_KEYS, SNAPSHOT_OPTION_KEYS, SNAPSHOT_QUERY_OPTION_KEYS, assertOptionKeys } from '../../utils/options.js';

// The unit tier has no IndexedDB, so this instance exists only to reach the option validation.
// Constructing it arms a pending open that WILL reject here, and `close()` disarms it before any
// assertion can await: an unhandled rejection would fail the whole runner. Closing also makes a query
// that passes validation fail deterministically with InvalidStateError, so "accepted" never depends on
// the host having a database.
const withValidatingOnlyDB = async (run) => {
  const db = new VectorDB({ dbName: 'unit-options-prototype', objectStore: 'vectors', vectorPath: 'embedding' });
  const closed = db.close().catch(() => {});
  try {
    return await run(db);
  } finally {
    await closed;
  }
};

// Cursor event ordering matches the IndexedDB calls createPackedSnapshot makes (same harness shape as
// tests/unit/packed-snapshot-validation.test.mjs, two rows: cheap enough for the fast tier).
const rows = [
  { key: 1, value: { embedding: [1, 0] } },
  { key: 2, value: { embedding: [0, 1] } },
  { key: 3, value: { embedding: [-1, 0] } },
];
const fakeDatabase = {
  transaction() {
    let position = 0;
    const tx = {
      objectStore: () => ({
        openCursor() {
          const request = {};
          const next = () => {
            const row = rows[position++];
            request.result = row && { key: row.key, value: row.value, continue: () => queueMicrotask(next) };
            request.onsuccess?.();
            if (!row) tx.oncomplete?.();
          };
          queueMicrotask(next);
          return request;
        },
      }),
    };
    return tx;
  },
};
const cosine = (a, b) => {
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  const norm = (vector) => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return dot / (norm(a) * norm(b));
};

test('a plain object of supported options is still accepted by every list', () => {
  assert.doesNotThrow(() => assertOptionKeys('query', { limit: 3, threshold: 0.5 }, QUERY_OPTION_KEYS, { absent: 'allow' }));
  assert.doesNotThrow(() => assertOptionKeys('queryCandidates', { limit: 3, index: 'category' }, CANDIDATE_OPTION_KEYS));
  assert.doesNotThrow(() => assertOptionKeys('createSnapshot', { maxBytes: 1024 }, SNAPSHOT_OPTION_KEYS));
  assert.doesNotThrow(() => assertOptionKeys('snapshot.query', { limit: 2 }, SNAPSHOT_QUERY_OPTION_KEYS, { absent: 'allow' }));
  assert.doesNotThrow(() => assertOptionKeys('query', {}, QUERY_OPTION_KEYS, { absent: 'allow' }));
});

test('an unknown OWN option keeps the established refusal, word for word', () => {
  assert.throws(
    () => assertOptionKeys('query', { predicate: () => true }, QUERY_OPTION_KEYS, { absent: 'allow' }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, 'query() option "predicate" is not supported; query() options are limit, threshold.');
      return true;
    },
  );
});

// --- the regression case (idb-vector-v743) ------------------------------------------------------
test('an option inherited through the prototype chain is REFUSED, not silently dropped', () => {
  // The shape the defect let through: a mixin/prototype-supplied key that property access honours and
  // Object.keys never saw. Accepting it here is the unfiltered-result regression.
  const inheritedPredicate = Object.create({ predicate: () => true });
  assert.equal(Object.keys(inheritedPredicate).length, 0, 'the inherited key is invisible to Object.keys — the old check');
  assert.throws(
    () => assertOptionKeys('query', inheritedPredicate, QUERY_OPTION_KEYS, { absent: 'allow' }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /^query\(\) option "predicate" is not supported \(the key is inherited through the options object's prototype\);/);
      assert.match(error.message, /query\(\) options are limit, threshold\./);
      return true;
    },
    'Object.create({ predicate }) must not pass the allow-list that guards query()',
  );

  // An inherited key the list never heard of is refused the same way, including from a chain that is
  // more than one link deep.
  assert.throws(
    () => assertOptionKeys('query', Object.create({ unknownOption: true }), QUERY_OPTION_KEYS, { absent: 'allow' }),
    /option "unknownOption" is not supported \(the key is inherited/
  );
  const twoLevels = Object.create(Object.create({ unknownOption: true }));
  assert.throws(() => assertOptionKeys('query', twoLevels, QUERY_OPTION_KEYS, { absent: 'allow' }), /option "unknownOption" is not supported \(the key is inherited/);

  // An own supported key does not hide a disallowed inherited sibling.
  const mixed = Object.create({ predicate: () => true });
  mixed.limit = 2;
  assert.throws(() => assertOptionKeys('query', mixed, QUERY_OPTION_KEYS, { absent: 'allow' }), /option "predicate" is not supported \(the key is inherited/);

  // Object.prototype itself is not a source of options: its members are non-enumerable, so a plain
  // object and a null-prototype object both pass exactly as before.
  assert.doesNotThrow(() => assertOptionKeys('query', Object.create(null), QUERY_OPTION_KEYS, { absent: 'allow' }));
});

test('a class instance is judged by its enumerable members: instance fields are options, prototype methods are not', () => {
  // Defined behaviour for the class shape: an option a caller hangs on the prototype (enumerable, so
  // property access reads it) is refused exactly like the mixin above.
  class Options {}
  Options.prototype.predicate = () => true;
  const inherited = new Options();
  assert.throws(
    () => assertOptionKeys('query', inherited, QUERY_OPTION_KEYS, { absent: 'allow' }),
    /option "predicate" is not supported \(the key is inherited through the options object's prototype\)/
  );

  // The legitimate class shape still works: fields are own + enumerable (so they are checked), methods
  // are non-enumerable prototype members (so they are not options and are not refused).
  class QueryOptions {
    limit = 3;
    threshold = 0.5;
    toJSON() { return { limit: this.limit }; }
  }
  assert.doesNotThrow(() => assertOptionKeys('query', new QueryOptions(), QUERY_OPTION_KEYS, { absent: 'allow' }));
});

test('an inherited option that IS allowed stays accepted, and the method honours it', async () => {
  // The allow-list agrees with property access in both directions: what the method reads, it validates.
  const inheritedLimit = Object.create({ limit: 1 });
  assert.doesNotThrow(() => assertOptionKeys('snapshot.query', inheritedLimit, SNAPSHOT_QUERY_OPTION_KEYS, { absent: 'allow' }));
  const snapshot = await createPackedSnapshot(fakeDatabase, 'vectors', 'embedding', { maxBytes: 0 }, cosine);
  try {
    const inherited = await snapshot.query([1, 0], inheritedLimit);
    assert.equal(inherited.results.length, 1, 'the inherited limit is honoured rather than dropped');
    assert.equal(inherited.results[0].key, 1);
    const own = await snapshot.query([1, 0], { limit: 2 });
    assert.equal(own.results.length, 2);
  } finally {
    snapshot.close();
  }
});

// --- __proto__ (the existing refusal convention) ------------------------------------------------
test("an own '__proto__' key is refused as the prototype accessor and never mutates a prototype", () => {
  const polluting = JSON.parse('{"__proto__":{"polluted":1}}');
  assert.ok(Object.hasOwn(polluting, '__proto__'), 'JSON.parse gives an own enumerable __proto__ data property');
  assert.throws(
    () => assertOptionKeys('query', polluting, QUERY_OPTION_KEYS, { absent: 'allow' }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.match(error.message, /must not carry a '__proto__' key/);
      assert.match(error.message, /prototype accessor rather than an option/);
      assert.match(error.message, /Use a normal option name \(limit, threshold\)\./, 'the message names the options that do exist');
      return true;
    },
  );
  assert.equal(Object.getPrototypeOf(polluting), Object.prototype, "the options object's prototype is untouched");
  assert.equal({}.polluted, undefined, 'nothing polluted the shared Object.prototype');

  // Non-enumerable and null-prototype spellings are refused too: hasOwn sees what for...in skips.
  const nullPrototype = Object.create(null);
  nullPrototype['__proto__'] = { polluted: 3 }; // no inherited setter on a null-prototype object: a plain own data property
  for (const options of [
    Object.defineProperty({ limit: 1 }, '__proto__', { value: { polluted: 2 }, enumerable: false }),
    nullPrototype,
  ]) {
    assert.throws(() => assertOptionKeys('query', options, QUERY_OPTION_KEYS, { absent: 'allow' }), /must not carry a '__proto__' key/);
  }
  assert.equal({}.polluted, undefined, 'still nothing polluted the shared Object.prototype');
});

// --- the entry points the defect was reported against -------------------------------------------
test('query() refuses an inherited candidate-only option instead of returning an unfiltered ranking', async () => {
  await withValidatingOnlyDB(async (db) => {
    for (const [label, options] of [
      ['a mixin prototype', Object.create({ predicate: () => true })],
      ['a two-link chain', Object.create(Object.create({ index: 'category' }))],
    ]) {
      await assert.rejects(
        () => db.query([1, 0], options),
        (error) => {
          assert.ok(error instanceof TypeError, `${label}: expected a TypeError, got ${error?.constructor?.name}: ${error?.message}`);
          assert.match(error.message, /is not supported \(the key is inherited through the options object's prototype\)/);
          assert.match(error.message, /Use queryCandidates\(\)/, `${label}: the refusal still points at the method that honours the key`);
          return true;
        },
        `${label}: query() must refuse an inherited key rather than rank as if it were applied`,
      );
    }
  });
});

test('snapshot.query() refuses an inherited key it cannot honour', async () => {
  const snapshot = await createPackedSnapshot(fakeDatabase, 'vectors', 'embedding', { maxBytes: 0 }, cosine);
  try {
    for (const [label, options] of [
      ['threshold', Object.create({ threshold: 0.5 })],
      ['predicate', Object.create({ predicate: () => true })],
    ]) {
      await assert.rejects(
        () => snapshot.query([1, 0], options),
        (error) => {
          assert.ok(error instanceof TypeError);
          assert.match(error.message, /^snapshot\.query\(\) option "(threshold|predicate)" is not supported \(the key is inherited/);
          return true;
        },
        `snapshot.query() must refuse an inherited ${label}`,
      );
    }
    // The inherited __proto__ spelling cannot reach the reader either.
    await assert.rejects(() => snapshot.query([1, 0], JSON.parse('{"__proto__":{"limit":1}}')), /must not carry a '__proto__' key/);
  } finally {
    snapshot.close();
  }
});
