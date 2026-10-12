// tests/validation.mjs — the numeric, options and path CONTRACT, driven in a real browser.
//
// Why a separate file: `tests/browser.mjs` drives the demo UI; this file drives the library's
// refusal behaviour, and it must not depend on that demo's dataset or on any test that ran before
// it. One browser, one page, one evaluate, no shared state beyond the databases it creates itself.
//
// The contract under test (README.md, "Contract and validation"):
//   1. vectorPath names ONE top-level property; a dotted name is refused at construction.
//   2. a vector is a non-empty Array of finite numbers with at least one nonzero coordinate.
//   3. limit is a positive integer and missing options mean limit 10.
//   4. every vector in a store shares one dimension; a record that is present but invalid makes
//      query() reject and NAME the offending key, instead of silently skipping it and letting a
//      NaN score rank ahead of real matches.
//   5. a record with no vector at vectorPath is not part of the corpus (IDB index key-path rule).
//   6. a refused insert/update writes nothing.
import assert from 'node:assert/strict';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const { VectorDB } = await import('/index.js');

    const checks = [];
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
      checks.push(message);
    };

    const open = (name) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const count = async (name) => {
      const db = await open(name);
      const counted = await new Promise((resolve, reject) => {
        const tx = db.transaction('vectors');
        const request = tx.objectStore('vectors').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return counted;
    };

    // A write that bypasses the library: exactly how a second connection, an older version of
    // this package, or a migration can put a bad record in an otherwise healthy store.
    const rawPut = async (name, record, key) => {
      const db = await open(name);
      const tx = db.transaction('vectors', 'readwrite');
      tx.objectStore('vectors').put(record, key);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error ?? new Error('raw write aborted'));
      });
      db.close();
    };

    const rawDelete = async (name, key) => {
      const db = await open(name);
      const tx = db.transaction('vectors', 'readwrite');
      tx.objectStore('vectors').delete(key);
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error ?? new Error('raw delete aborted'));
      });
      db.close();
    };

    const refusals = {};
    // `expected` is { type, includes }: the error class and fragments that must appear in the
    // message, because "rejected" is not actionable and "rejected, saying why" is.
    const refusal = async (label, run, expected) => {
      let error = null;
      try {
        await run();
      } catch (caught) {
        error = caught;
      }
      check(error !== null, `${label}: rejects`);
      check(error.constructor === expected.type, `${label}: rejects with ${expected.type.name}, got ${error.constructor.name} (${error.message})`);
      for (const fragment of expected.includes) {
        check(error.message.includes(fragment), `${label}: message names ${JSON.stringify(fragment)} (${error.message})`);
      }
      refusals[label] = `${error.constructor.name}: ${error.message}`;
      return error;
    };

    // --- 1. path contract -------------------------------------------------------------------
    await refusal('dotted vectorPath is refused before any database is opened',
      async () => new VectorDB({ dbName: 'validation-dotted', vectorPath: 'nested.vector' }),
      { type: TypeError, includes: ['top-level', 'nested.vector', "'.'"] });
    const databases = (await indexedDB.databases()).map(({ name }) => name);
    check(databases.includes('validation-dotted') === false, 'refused vectorPath never creates a database');
    await refusal('empty vectorPath is refused',
      async () => new VectorDB({ dbName: 'validation-empty', vectorPath: '' }),
      { type: TypeError, includes: ['non-empty string'] });
    await refusal('non-string vectorPath is refused',
      async () => new VectorDB({ dbName: 'validation-number', vectorPath: 5 }),
      { type: TypeError, includes: ['non-empty string', '5'] });

    // --- 2/3/6. write validation and no partial writes ---------------------------------------
    const name = `validation-writes-${crypto.randomUUID()}`;
    const db = new VectorDB({ dbName: name, vectorPath: 'embedding' });

    await refusal('zero vector insert',
      () => db.insert({ embedding: [0, 0] }),
      { type: TypeError, includes: ['all zeros', 'NaN'] });
    await refusal('empty vector insert',
      () => db.insert({ embedding: [] }),
      { type: TypeError, includes: ['must not be empty'] });
    await refusal('NaN coordinate insert',
      () => db.insert({ embedding: [1, NaN] }),
      { type: TypeError, includes: ['coordinate 1', 'finite'] });
    await refusal('Infinity coordinate insert',
      () => db.insert({ embedding: [1, Infinity] }),
      { type: TypeError, includes: ['coordinate 1', 'finite'] });
    await refusal('non-numeric coordinate insert',
      () => db.insert({ embedding: [1, '2'] }),
      { type: TypeError, includes: ['coordinate 1', 'finite'] });
    await refusal('non-array vector insert',
      () => db.insert({ embedding: '1,2' }),
      { type: TypeError, includes: ['an Array'] });
    await refusal('missing vector property insert',
      () => db.insert({ text: 'no vector here' }),
      { type: TypeError, includes: ["'embedding'", 'no '] });
    await refusal('non-record insert',
      () => db.insert([1, 0]),
      { type: TypeError, includes: ['record object'] });
    check((await count(name)) === 0, 'no refused insert wrote a record');

    const keys = [];
    for (let index = 0; index < 12; index++) keys.push(await db.insert({ embedding: [1, index], id: index }));
    check((await count(name)) === 12, 'twelve valid inserts wrote twelve records');

    await refusal('zero vector update',
      () => db.update(keys[0], { embedding: [0, 0] }),
      { type: TypeError, includes: ['all zeros'] });
    const afterRefusedUpdate = await db.query([1, 0], { limit: 12 });
    check(afterRefusedUpdate.length === 12, 'a refused update left twelve records queryable');
    check((await count(name)) === 12, 'a refused update wrote nothing');

    // --- 3. query options: default 10, and only a positive integer is a limit -----------------
    await refusal('limit 0', () => db.query([1, 0], { limit: 0 }), { type: RangeError, includes: ['positive integer', '0'] });
    await refusal('limit -1', () => db.query([1, 0], { limit: -1 }), { type: RangeError, includes: ['positive integer'] });
    await refusal('limit 2.5', () => db.query([1, 0], { limit: 2.5 }), { type: RangeError, includes: ['positive integer'] });
    await refusal('limit "10"', () => db.query([1, 0], { limit: '10' }), { type: RangeError, includes: ['positive integer'] });
    await refusal('limit null', () => db.query([1, 0], { limit: null }), { type: RangeError, includes: ['positive integer', 'null'] });
    await refusal('limit Infinity', () => db.query([1, 0], { limit: Infinity }), { type: RangeError, includes: ['positive integer'] });
    await refusal('less than 1 result limit', () => db.query([1, 0], { limit: 0.5 }), { type: RangeError, includes: ['positive integer'] });
    await refusal('non-object options', () => db.query([1, 0], 5), { type: TypeError, includes: ['options must be an object'] });
    check((await db.query([1, 0])).length === 10, 'query(vector) defaults to ten results');
    check((await db.query([1, 0], {})).length === 10, 'query(vector, {}) defaults to ten results');
    check((await db.query([1, 0], { limit: 3 })).length === 3, 'explicit limit is honoured');
    check((await db.query([1, 0], { limit: 20 })).length === 12, 'a limit above the corpus returns the whole corpus');

    // --- 2. query vector validation -----------------------------------------------------------
    await refusal('zero query vector', () => db.query([0, 0]), { type: TypeError, includes: ['query() vector', 'all zeros'] });
    await refusal('empty query vector', () => db.query([]), { type: TypeError, includes: ['query() vector', 'must not be empty'] });
    await refusal('Infinity query vector', () => db.query([1, Infinity]), { type: TypeError, includes: ['query() vector', 'finite'] });
    await refusal('NaN query vector', () => db.query([1, NaN]), { type: TypeError, includes: ['query() vector', 'finite'] });
    await refusal('non-array query vector', () => db.query('1,0'), { type: TypeError, includes: ['query() vector', 'an Array'] });

    // --- 4. dimension contract: loud, named, not a silent skip --------------------------------
    const dimensionName = `validation-dimension-${crypto.randomUUID()}`;
    const dimensionDB = new VectorDB({ dbName: dimensionName, vectorPath: 'embedding' });
    await dimensionDB.insert({ embedding: [1, 0], id: 'two-dimensions' });
    await rawPut(dimensionName, { embedding: [1, 0, 0], id: 'three-dimensions' }, 99);
    const mismatch = await refusal('stored vector of another dimension fails the query and names its key',
      () => dimensionDB.query([1, 0]),
      { type: TypeError, includes: ['99', '3 coordinates', '2', 'must share one dimension'] });
    check(mismatch.message.includes('re-insert') || mismatch.message.includes('delete'), 'dimension refusal says what to do next');
    await rawDelete(dimensionName, 99);
    check((await dimensionDB.query([1, 0])).length === 1, 'query works again once the mismatched record is deleted');

    // --- 4. the original poison: zero and non-finite stored vectors now fail loudly -----------
    const poisonName = `validation-poison-${crypto.randomUUID()}`;
    const poisonDB = new VectorDB({ dbName: poisonName, vectorPath: 'embedding' });
    await poisonDB.insert({ embedding: [1, 0], id: 'healthy' });
    await rawPut(poisonName, { embedding: [0, 0], id: 'zero' }, 50);
    const poisoned = await refusal('stored zero vector fails the query instead of scoring NaN first',
      () => poisonDB.query([1, 0]),
      { type: TypeError, includes: ['50', 'all zeros'] });
    check(poisoned.message.includes('Delete') || poisoned.message.includes('delete'), 'zero-vector refusal says what to do next');
    await rawDelete(poisonName, 50);
    await rawPut(poisonName, { embedding: [1, Infinity], id: 'infinity' }, 51);
    const infinite = await refusal('stored Infinity vector fails the query and names its key',
      () => poisonDB.query([1, 0]),
      { type: TypeError, includes: ['51', 'finite number'] });
    check(infinite.message.includes('NaN'), 'Infinity refusal explains the NaN ranking hazard');
    await rawDelete(poisonName, 51);
    await rawPut(poisonName, { embedding: 'not-a-vector', id: 'string' }, 52);
    await refusal('stored non-array vector fails the query and names its key',
      () => poisonDB.query([1, 0]),
      { type: TypeError, includes: ['52', 'an Array'] });
    await rawDelete(poisonName, 52);

    // --- 5. a record without the vector is not part of the corpus -----------------------------
    await rawPut(poisonName, { id: 'metadata-only' }, 53);
    const withoutVector = await poisonDB.query([1, 0], { limit: 10 });
    check(withoutVector.length === 1 && withoutVector[0].object.id === 'healthy', 'a record with no vector at vectorPath is skipped, not an error');
    await rawDelete(poisonName, 53);

    for (const database of ['validation-dotted', 'validation-empty', 'validation-number', name, dimensionName, poisonName]) {
      indexedDB.deleteDatabase(database);
    }

    return { checks: checks.length, refusals };
  });

  assert.ok(result.checks >= 50, `expected the full contract battery, ran ${result.checks} checks`);
  assert.equal(typeof result.refusals['dotted vectorPath is refused before any database is opened'], 'string');
  console.log(`PASS: ${result.checks} validation checks in a real browser`);
  console.log('Rejection samples:');
  for (const [label, message] of Object.entries(result.refusals)) console.log(`  ${label} -> ${message}`);
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
}
