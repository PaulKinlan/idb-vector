// tests/candidates.mjs — queryCandidates() candidate selection contract, caller schemas and index cost
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  const result = await page.evaluate(async (measure) => {
    const { VectorDB } = await import('/index.js');

    const checks = [];
    const check = (condition, message) => {
      if (!condition) throw new Error(message);
      checks.push(message);
    };

    const reqPromise = (req) => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const txComplete = (tx) => new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    });

    const openRaw = (name, version, onupgradeneeded) => new Promise((resolve, reject) => {
      const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
      if (onupgradeneeded) req.onupgradeneeded = onupgradeneeded;
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const refusals = {};
    const refusal = async (label, run, expected) => {
      let error = null;
      try {
        await run();
      } catch (caught) {
        error = caught;
      }
      check(error !== null, `${label}: rejects`);
      check(error.constructor === expected.type, `${label}: rejects with ${expected.type.name}, got ${error?.constructor?.name} (${error?.message})`);
      for (const fragment of expected.includes) {
        check(error.message.includes(fragment), `${label}: message names ${JSON.stringify(fragment)} (${error.message})`);
      }
      refusals[label] = `${error.constructor.name}: ${error.message}`;
      return error;
    };

    // Float64 view for bit-exact key and similarity score comparison, exactly as in packed-snapshot.mjs
    const bits = (rows) => {
      const bytes = new Float64Array(rows.length * 2);
      rows.forEach((row, i) => {
        bytes[2 * i] = typeof row.key === 'number' ? row.key : 0;
        bytes[2 * i + 1] = row.similarity;
      });
      return Array.from(new Uint8Array(bytes.buffer)).join(',');
    };

    const keysMatch = (rowsA, rowsB) => {
      if (rowsA.length !== rowsB.length) return false;
      return rowsA.every((row, i) => row.key === rowsB[i].key);
    };

    // Seeded deterministic PRNG for reproducible 32-dimensional vectors
    function makePRNG(seed = 123456789) {
      let s = seed >>> 0;
      return () => {
        s = (Math.imul(1664525, s) + 1013904223) >>> 0;
        return s / 4294967296;
      };
    }

    const prng = makePRNG(42);
    const makeVector = (dim = 32) => {
      const v = [];
      let sumSq = 0;
      for (let i = 0; i < dim; i++) {
        const x = prng() * 2 - 1;
        v.push(x);
        sumSq += x * x;
      }
      const norm = Math.sqrt(sumSq) || 1;
      return v.map((x) => x / norm);
    };

    const databasesToClean = [];

    // --- 1. Results shape and descending similarity ordering ---------------------------------
    const shapeDbName = `candidates-shape-${crypto.randomUUID()}`;
    databasesToClean.push(shapeDbName);
    const shapeDB = new VectorDB({ dbName: shapeDbName, vectorPath: 'embedding' });
    for (let i = 1; i <= 6; i++) {
      await shapeDB.insert({ id: i, title: `doc-${i}`, embedding: makeVector(32) });
    }

    const testQVec = makeVector(32);
    const { results: shapeResults, info: shapeInfo } = await shapeDB.queryCandidates(testQVec, { limit: 5 });
    check(Array.isArray(shapeResults), 'results is an Array');
    check(shapeResults.length === 5, 'limit 5 returns 5 results');
    for (let i = 0; i < shapeResults.length; i++) {
      const row = shapeResults[i];
      check(typeof row === 'object' && row !== null, `result ${i} is an object`);
      check(row.key !== undefined && row.key !== null, `result ${i} has a key`);
      check(typeof row.similarity === 'number' && Number.isFinite(row.similarity), `result ${i} has finite numeric similarity`);
      check(typeof row.object === 'object' && row.object !== null, `result ${i} has object`);
      if (i > 0) {
        check(shapeResults[i - 1].similarity >= row.similarity, `results ordered by descending similarity: ${shapeResults[i - 1].similarity} >= ${row.similarity}`);
      }
    }

    // query() and queryCandidates() key and score parity on full scan
    const queryDefaultResults = await shapeDB.query(testQVec, { limit: 5 });
    check(keysMatch(shapeResults, queryDefaultResults), 'query() and queryCandidates() return identical keys in identical order');
    check(bits(shapeResults) === bits(queryDefaultResults), 'query() and queryCandidates() return byte-identical scores and keys via bits()');

    // --- 2 & 3. Candidate selection reads fewer records, missing index field, and info metadata -
    const infoDbName = `candidates-info-${crypto.randomUUID()}`;
    databasesToClean.push(infoDbName);
    const infoRaw = await openRaw(infoDbName, 1, (e) => {
      const store = e.target.result.createObjectStore('vectors', { autoIncrement: true });
      store.createIndex('embedding', 'embedding');
      store.createIndex('category', 'category');
    });
    infoRaw.close();

    const infoDB = new VectorDB({ dbName: infoDbName, vectorPath: 'embedding' });
    // 20 records with category 'sci', 20 records with category 'art', 10 records with missing category
    for (let i = 1; i <= 20; i++) {
      await infoDB.insert({ id: i, category: 'sci', value: i, embedding: makeVector(32) });
    }
    for (let i = 21; i <= 40; i++) {
      await infoDB.insert({ id: i, category: 'art', value: i, embedding: makeVector(32) });
    }
    for (let i = 41; i <= 50; i++) {
      await infoDB.insert({ id: i, value: i, embedding: makeVector(32) }); // no category property
    }

    // (a) Index candidate query: recordsRead visits only 'sci' records; records lacking 'category' are not candidates
    const sciQ = await infoDB.queryCandidates(testQVec, {
      index: 'category',
      range: IDBKeyRange.only('sci'),
      limit: 10,
    });
    check(sciQ.info.mode === 'index', 'info.mode is "index"');
    check(sciQ.info.index === 'category', 'info.index is "category"');
    check(sciQ.info.range.lower === 'sci' && sciQ.info.range.upper === 'sci', 'info.range reflects IDBKeyRange.only("sci")');
    check(sciQ.info.range.lowerOpen === false && sciQ.info.range.upperOpen === false, 'info.range open flags false');
    check(sciQ.info.predicate === false, 'info.predicate is false when not supplied');
    check(sciQ.info.limit === 10, 'info.limit is 10');
    check(sciQ.info.fullScanRequired === false, 'fullScanRequired is false for index selection');
    check(sciQ.info.reason === null, 'reason is null when fullScanRequired is false');
    check(sciQ.info.recordsRead === 20, `index read exactly the 20 'sci' records, got ${sciQ.info.recordsRead}`);
    check(sciQ.info.recordsScored === 20, `all 20 read candidates scored, got ${sciQ.info.recordsScored}`);
    check(sciQ.results.length === 10, 'returned 10 results');
    check(sciQ.results.every((r) => r.object.category === 'sci'), 'all results have category "sci"');

    // (b) Predicate reduces recordsScored below recordsRead
    const sciFiltered = await infoDB.queryCandidates(testQVec, {
      index: 'category',
      range: IDBKeyRange.only('sci'),
      predicate: (r) => r.value > 12,
      limit: 10,
    });
    check(sciFiltered.info.predicate === true, 'info.predicate is true when supplied');
    check(sciFiltered.info.recordsRead === 20, 'recordsRead is still 20 (all "sci" records visited)');
    check(sciFiltered.info.recordsScored === 8, `recordsScored is 8 (only records with value > 12 scored), got ${sciFiltered.info.recordsScored}`);
    check(sciFiltered.info.recordsScored < sciFiltered.info.recordsRead, 'recordsScored is strictly less than recordsRead when predicate filters candidates');

    // (c) Store range (index is null, range is supplied)
    const storeRangeQ = await infoDB.queryCandidates(testQVec, {
      range: IDBKeyRange.bound(1, 15),
      limit: 10,
    });
    check(storeRangeQ.info.mode === 'store-range', 'info.mode is "store-range"');
    check(storeRangeQ.info.index === null, 'info.index is null for store-range');
    check(storeRangeQ.info.fullScanRequired === false, 'fullScanRequired is false for store-range');
    check(storeRangeQ.info.reason === null, 'reason is null for store-range');
    check(storeRangeQ.info.range.lower === 1 && storeRangeQ.info.range.upper === 15, 'info.range reflects store key bounds');
    check(storeRangeQ.info.recordsRead === 15, `store-range read exactly 15 records, got ${storeRangeQ.info.recordsRead}`);

    // (d) Full scan without predicate
    const fullScanNoPred = await infoDB.queryCandidates(testQVec, { limit: 10 });
    check(fullScanNoPred.info.mode === 'full-scan', 'info.mode is "full-scan"');
    check(fullScanNoPred.info.index === null, 'info.index is null for full-scan');
    check(fullScanNoPred.info.range === null, 'info.range is null for full-scan');
    check(fullScanNoPred.info.fullScanRequired === true, 'fullScanRequired is true when index and range are both null');
    check(fullScanNoPred.info.reason === 'no index or key range: every record in the store is read', 'reason matches expected sentence for full-scan without predicate');
    check(fullScanNoPred.info.recordsRead === 50, 'full scan reads every record in the store including missing-category records');
    check(fullScanNoPred.info.recordsScored === 50, 'full scan scores every valid record in the store');

    // (e) Full scan with predicate
    const fullScanWithPred = await infoDB.queryCandidates(testQVec, {
      predicate: (r) => Boolean(r.category),
      limit: 10,
    });
    check(fullScanWithPred.info.mode === 'full-scan', 'info.mode is "full-scan" with predicate');
    check(fullScanWithPred.info.fullScanRequired === true, 'fullScanRequired is true for predicate-only scan');
    check(fullScanWithPred.info.reason === 'predicate without an index or key range: every record in the store is read', 'reason matches expected sentence for predicate without index or key range');
    check(fullScanWithPred.info.recordsRead === 50, 'reads every record in the store');
    check(fullScanWithPred.info.recordsScored === 40, 'scores only the 40 records with category');

    // --- 4. Predicate applied BEFORE ranking (not a top-k-then-filter truncation) -------------
    const predDbName = `candidates-pred-${crypto.randomUUID()}`;
    databasesToClean.push(predDbName);
    const predDB = new VectorDB({ dbName: predDbName, vectorPath: 'embedding' });
    const targetQ = [1, 0, 0, 0];
    // 40 common records very close to targetQ ([1, 0, 0, 0]), category 'common'
    for (let i = 1; i <= 40; i++) {
      await predDB.insert({ id: i, category: 'common', embedding: [1, 0.001 * i, 0, 0] });
    }
    // 3 rare records far from targetQ, category 'rare'
    await predDB.insert({ id: 41, category: 'rare', embedding: [0.3, 0.7, 0, 0] });
    await predDB.insert({ id: 42, category: 'rare', embedding: [0.5, 0.5, 0, 0] });
    await predDB.insert({ id: 43, category: 'rare', embedding: [0.4, 0.6, 0, 0] });

    // A top-k-then-filter with limit 2 would take top 2 overall (common) and filter them out to 0.
    // Filter before ranking must return the top 2 rare records!
    const predResult = await predDB.queryCandidates(targetQ, {
      limit: 2,
      predicate: (r) => r.category === 'rare',
    });
    check(predResult.results.length === 2, `predicate before ranking returns exactly 2 records, got ${predResult.results.length}`);
    check(predResult.results.every((r) => r.object.category === 'rare'), 'all results pass the selective predicate');
    check(predResult.results[0].object.id === 42, 'top rare record is id 42 (highest similarity among rare set)');
    check(predResult.results[1].object.id === 43, 'second rare record is id 43');

    // --- 5. Refusals and validation ---------------------------------------------------------
    // (a) Missing index on a store that has indexes: names the store, lists available indexes
    await refusal('missing index names store and available indexes',
      () => infoDB.queryCandidates(testQVec, { index: 'nonexistent' }),
      { type: TypeError, includes: ["'vectors'", '"nonexistent"', 'category'] });

    // Missing index on a store with NO indexes: names "none"
    const noIndexDbName = `candidates-noindex-${crypto.randomUUID()}`;
    databasesToClean.push(noIndexDbName);
    const noIndexRaw = await openRaw(noIndexDbName, 1, (e) => {
      e.target.result.createObjectStore('vectors', { autoIncrement: true });
    });
    noIndexRaw.close();
    const noIndexDB = new VectorDB({ dbName: noIndexDbName, vectorPath: 'embedding' });
    await noIndexDB.insert({ id: 1, embedding: makeVector(32) });
    await refusal('missing index on store with no indexes lists none',
      () => noIndexDB.queryCandidates(testQVec, { index: 'nope' }),
      { type: TypeError, includes: ["'vectors'", '"nope"', 'available indexes: none'] });

    // multiEntry index is refused to prevent silent duplicate ranking
    const multiEntryDbName = `candidates-multientry-${crypto.randomUUID()}`;
    databasesToClean.push(multiEntryDbName);
    const multiEntryRaw = await openRaw(multiEntryDbName, 1, (e) => {
      const s = e.target.result.createObjectStore('vectors', { autoIncrement: true });
      s.createIndex('tags', 'tags', { multiEntry: true });
    });
    multiEntryRaw.close();
    const multiEntryDB = new VectorDB({ dbName: multiEntryDbName, vectorPath: 'embedding' });
    await multiEntryDB.insert({ tags: ['a', 'b'], embedding: makeVector(32) });
    await refusal('multiEntry index rejected with TypeError',
      () => multiEntryDB.queryCandidates(testQVec, { index: 'tags' }),
      { type: TypeError, includes: ['multiEntry index', '"tags"', 'visits one record once per matching entry'] });

    // (b) Unknown option key
    await refusal('unknown option key rejected',
      () => shapeDB.queryCandidates(testQVec, { unsupportedOption: true }),
      { type: TypeError, includes: ['queryCandidates() option "unsupportedOption" is not supported', 'limit, index, range, predicate'] });

    // (c) Non-string index
    await refusal('numeric index rejected',
      () => shapeDB.queryCandidates(testQVec, { index: 123 }),
      { type: TypeError, includes: ['index must be a non-empty string', '123'] });
    await refusal('empty string index rejected',
      () => shapeDB.queryCandidates(testQVec, { index: '' }),
      { type: TypeError, includes: ['index must be a non-empty string'] });

    // (d) Non-IDBKeyRange range
    await refusal('array range rejected',
      () => shapeDB.queryCandidates(testQVec, { range: [1, 2] }),
      { type: TypeError, includes: ['range must be an IDBKeyRange built with IDBKeyRange.only/bound/lowerBound/upperBound', 'an Array of length 2'] });
    await refusal('string range rejected',
      () => shapeDB.queryCandidates(testQVec, { range: '1..10' }),
      { type: TypeError, includes: ['range must be an IDBKeyRange built with IDBKeyRange.only/bound/lowerBound/upperBound', '"1..10"'] });

    // (e) Non-function predicate
    await refusal('string predicate rejected',
      () => shapeDB.queryCandidates(testQVec, { predicate: 'record => true' }),
      { type: TypeError, includes: ['predicate must be a function of one record returning a boolean', '"record => true"'] });
    await refusal('object predicate rejected',
      () => shapeDB.queryCandidates(testQVec, { predicate: { active: true } }),
      { type: TypeError, includes: ['predicate must be a function of one record returning a boolean', 'an object'] });

    // (f) Non-positive integer limit (RangeError)
    await refusal('limit 0 rejected',
      () => shapeDB.queryCandidates(testQVec, { limit: 0 }),
      { type: RangeError, includes: ['limit must be a positive integer', '0'] });
    await refusal('limit -5 rejected',
      () => shapeDB.queryCandidates(testQVec, { limit: -5 }),
      { type: RangeError, includes: ['limit must be a positive integer', '-5'] });
    await refusal('limit 3.14 rejected',
      () => shapeDB.queryCandidates(testQVec, { limit: 3.14 }),
      { type: RangeError, includes: ['limit must be a positive integer', '3.14'] });
    await refusal('string limit rejected',
      () => shapeDB.queryCandidates(testQVec, { limit: '10' }),
      { type: RangeError, includes: ['limit must be a positive integer', '"10"'] });
    await refusal('NaN limit rejected',
      () => shapeDB.queryCandidates(testQVec, { limit: NaN }),
      { type: RangeError, includes: ['limit must be a positive integer', 'NaN'] });
    await refusal('Infinity limit rejected',
      () => shapeDB.queryCandidates(testQVec, { limit: Infinity }),
      { type: RangeError, includes: ['limit must be a positive integer', 'Infinity'] });

    // (g) Invalid query vector
    await refusal('empty query vector rejected',
      () => shapeDB.queryCandidates([], { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector must not be empty'] });
    await refusal('zero query vector rejected',
      () => shapeDB.queryCandidates([0, 0, 0, 0], { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector must not be all zeros'] });
    await refusal('NaN coordinate query vector rejected',
      () => shapeDB.queryCandidates([1, NaN, 0, 0], { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector coordinate 1 must be a finite number', 'NaN'] });
    await refusal('Infinity coordinate query vector rejected',
      () => shapeDB.queryCandidates([1, Infinity, 0, 0], { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector coordinate 1 must be a finite number', 'Infinity'] });
    await refusal('non-array query vector rejected',
      () => shapeDB.queryCandidates('1,0,0,0', { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector must be an Array'] });

    // (h) Predicate that throws: must name the offending record key and preserve original message
    await refusal('predicate that throws names key and keeps message',
      () => shapeDB.queryCandidates(testQVec, {
        predicate: (r) => {
          if (r.id === 3) throw new Error('user predicate explosion');
          return true;
        },
      }),
      { type: Error, includes: ['queryCandidates() predicate threw for key 3', 'user predicate explosion'] });

    // --- 6. Caller-owned schema (in-line and out-of-line) ------------------------------------
    // (a) v2 caller database, vector store with in-line keyPath plus extra store with keyPath
    const callerV2InlineName = `caller-v2-inline-${crypto.randomUUID()}`;
    databasesToClean.push(callerV2InlineName);
    const callerRaw = await openRaw(callerV2InlineName, 2, (e) => {
      const db = e.target.result;
      const meta = db.createObjectStore('metadata', { keyPath: 'metaId' });
      meta.createIndex('type', 'type');
      const docs = db.createObjectStore('documents', { keyPath: 'docId' });
      docs.createIndex('category', 'category');
    });
    callerRaw.close();

    const callerDB = new VectorDB({
      dbName: callerV2InlineName,
      objectStore: 'documents',
      vectorPath: 'embedding',
    });

    // Insert on in-line-key store
    const doc1Key = await callerDB.insert({
      docId: 101,
      category: 'legal',
      title: 'Contract A',
      embedding: makeVector(32),
    });
    check(doc1Key === 101, `insert on in-line store returned key 101, got ${doc1Key}`);
    await callerDB.insert({
      docId: 102,
      category: 'legal',
      title: 'Contract B',
      embedding: makeVector(32),
    });
    await callerDB.insert({
      docId: 103,
      category: 'hr',
      title: 'Handbook',
      embedding: makeVector(32),
    });

    // Update on in-line-key store: key matches record's docId
    const updatedKey = await callerDB.update(101, {
      docId: 101,
      category: 'legal',
      title: 'Contract A (Amended)',
      embedding: makeVector(32),
    });
    check(updatedKey === 101, `update returned key 101, got ${updatedKey}`);

    // Update refusal on key mismatch: key 999 vs record docId 101
    await refusal('in-line store update key mismatch rejected with TypeError',
      () => callerDB.update(999, {
        docId: 101,
        category: 'legal',
        title: 'Contract Mismatched',
        embedding: makeVector(32),
      }),
      { type: TypeError, includes: ['999', '101', 'does not match', 'docId'] });

    // Update refusal on missing keyPath property
    await refusal('in-line store update missing keyPath rejected with TypeError',
      () => callerDB.update(101, {
        category: 'legal',
        title: 'No docId',
        embedding: makeVector(32),
      }),
      { type: TypeError, includes: ['no value at this store\'s in-line keyPath', 'docId'] });

    // Candidate query on caller-owned v2 schema
    const callerQuery = await callerDB.queryCandidates(testQVec, {
      index: 'category',
      range: IDBKeyRange.only('legal'),
      limit: 10,
    });
    check(callerQuery.results.length === 2, `queryCandidates on caller v2 returned 2 legal docs, got ${callerQuery.results.length}`);
    const amendedDoc = callerQuery.results.find((r) => r.key === 101);
    check(amendedDoc !== undefined, 'doc 101 is found');
    check(amendedDoc.object.title === 'Contract A (Amended)', 'refused updates left stored record unchanged with amended title');

    // Delete on caller-owned schema
    await callerDB.delete(102);
    const callerQueryAfterDel = await callerDB.queryCandidates(testQVec, {
      index: 'category',
      range: IDBKeyRange.only('legal'),
      limit: 10,
    });
    check(callerQueryAfterDel.results.length === 1, 'delete removed doc 102 from caller store');

    // Verify database is STILL version 2 with exactly the same store names
    const verifyRaw = await openRaw(callerV2InlineName);
    check(verifyRaw.version === 2, `database is still version 2, got ${verifyRaw.version}`);
    const actualStores = Array.from(verifyRaw.objectStoreNames).sort();
    check(JSON.stringify(actualStores) === JSON.stringify(['documents', 'metadata']), `objectStoreNames unchanged: ${JSON.stringify(actualStores)}`);
    verifyRaw.close();

    // (b) Caller-owned store with out-of-line keys ({ autoIncrement: true })
    const callerV2OutName = `caller-v2-out-${crypto.randomUUID()}`;
    databasesToClean.push(callerV2OutName);
    const callerOutRaw = await openRaw(callerV2OutName, 2, (e) => {
      const db = e.target.result;
      db.createObjectStore('extra');
      const store = db.createObjectStore('items', { autoIncrement: true });
      store.createIndex('tag', 'tag');
    });
    callerOutRaw.close();

    const callerOutDB = new VectorDB({
      dbName: callerV2OutName,
      objectStore: 'items',
      vectorPath: 'embedding',
    });
    const itemKey1 = await callerOutDB.insert({ tag: 't1', embedding: makeVector(32), name: 'Item 1' });
    check(itemKey1 === 1, `out-of-line store insert returned key 1, got ${itemKey1}`);
    const itemUpKey = await callerOutDB.update(itemKey1, { tag: 't1', embedding: makeVector(32), name: 'Item 1 Updated' });
    check(itemUpKey === itemKey1, 'out-of-line update succeeds');
    const outQ = await callerOutDB.queryCandidates(testQVec, { index: 'tag', range: IDBKeyRange.only('t1') });
    check(outQ.results.length === 1 && outQ.results[0].object.name === 'Item 1 Updated', 'queryCandidates sees updated item');
    await callerOutDB.delete(itemKey1);
    const outQAfterDel = await callerOutDB.queryCandidates(testQVec, { index: 'tag', range: IDBKeyRange.only('t1') });
    check(outQAfterDel.results.length === 0, 'delete on out-of-line caller store succeeds');
    const verifyOutRaw = await openRaw(callerV2OutName);
    check(verifyOutRaw.version === 2, 'out-of-line DB is still version 2');
    check(JSON.stringify(Array.from(verifyOutRaw.objectStoreNames).sort()) === JSON.stringify(['extra', 'items']), 'stores unchanged on out-of-line DB');
    verifyOutRaw.close();

    // (c) Database that exists without the requested store: rejects naming missing store and existing stores, does not create it
    const callerMissingStoreDbName = `caller-missing-store-${crypto.randomUUID()}`;
    databasesToClean.push(callerMissingStoreDbName);
    const existingRaw = await openRaw(callerMissingStoreDbName, 2, (e) => {
      e.target.result.createObjectStore('alpha');
      e.target.result.createObjectStore('beta');
    });
    existingRaw.close();

    const missingStoreDB = new VectorDB({
      dbName: callerMissingStoreDbName,
      objectStore: 'gamma',
      vectorPath: 'embedding',
    });
    await refusal('missing store in existing schema rejects naming missing store and existing stores',
      () => missingStoreDB.query(testQVec),
      { type: Error, includes: ["objectStore 'gamma' is not in database", 'version 2', 'alpha, beta', 'This library never adds a store'] });

    const checkMissingRaw = await openRaw(callerMissingStoreDbName);
    check(checkMissingRaw.version === 2, 'database still version 2 after refused connection');
    const storesAfterMissing = Array.from(checkMissingRaw.objectStoreNames).sort();
    check(JSON.stringify(storesAfterMissing) === JSON.stringify(['alpha', 'beta']), 'missing store was not created by the library');
    checkMissingRaw.close();

    // --- 7, 8, 9, 10, 11. Corpus of 2000 records, 32D: compound keys, duplicates, range endpoints & selectivity parity
    const corpusDbName = `candidates-corpus-2000-${crypto.randomUUID()}`;
    databasesToClean.push(corpusDbName);
    const corpusRaw = await openRaw(corpusDbName, 1, (e) => {
      const db = e.target.result;
      const store = db.createObjectStore('vectors', { autoIncrement: true });
      store.createIndex('embedding', 'embedding');
      store.createIndex('category', 'category');
      store.createIndex('tenant_category', ['tenant', 'category']);
      store.createIndex('cluster', 'cluster');
    });
    corpusRaw.close();

    const corpusDB = new VectorDB({ dbName: corpusDbName, vectorPath: 'embedding' });
    const CORPUS_SIZE = 2000;
    // Populate corpus with deterministic vectors
    // Records 1..2000:
    // - category: i % 100 (0..99)
    // - tenant: i % 2 === 0 ? 'a' : 'b'
    // - records 101..140 (40 records) share cluster: 'duplicate-group'
    // - records 1991..2000 have NO category property
    const rawConn = await openRaw(corpusDbName);
    for (let offset = 0; offset < CORPUS_SIZE; offset += 500) {
      const tx = rawConn.transaction('vectors', 'readwrite');
      const st = tx.objectStore('vectors');
      for (let i = offset + 1; i <= Math.min(offset + 500, CORPUS_SIZE); i++) {
        const rec = {
          id: i,
          tenant: i % 2 === 0 ? 'a' : 'b',
          embedding: makeVector(32),
        };
        if (i <= 1990) {
          rec.category = i % 100;
        }
        if (i >= 101 && i <= 140) {
          rec.cluster = 'duplicate-group';
        }
        st.put(rec, i);
      }
      await txComplete(tx);
    }
    rawConn.close();

    const corpusQVec = makeVector(32);
    // Independently computed oracle: full exact scan over entire corpus
    const fullOracle = await corpusDB.query(corpusQVec, { limit: CORPUS_SIZE });
    check(fullOracle.length === CORPUS_SIZE, `full oracle contains all ${CORPUS_SIZE} records`);

    // --- Range endpoints: inclusive vs exclusive IDBKeyRange on store keys vs oracle -------
    const rangeCases = [
      {
        label: 'bound [300, 700] inclusive/inclusive',
        range: IDBKeyRange.bound(300, 700, false, false),
        filter: (r) => r.key >= 300 && r.key <= 700,
      },
      {
        label: 'bound (300, 700] exclusive/inclusive',
        range: IDBKeyRange.bound(300, 700, true, false),
        filter: (r) => r.key > 300 && r.key <= 700,
      },
      {
        label: 'bound [300, 700) inclusive/exclusive',
        range: IDBKeyRange.bound(300, 700, false, true),
        filter: (r) => r.key >= 300 && r.key < 700,
      },
      {
        label: 'bound (300, 700) exclusive/exclusive',
        range: IDBKeyRange.bound(300, 700, true, true),
        filter: (r) => r.key > 300 && r.key < 700,
      },
      {
        label: 'lowerBound [1500, inf) inclusive',
        range: IDBKeyRange.lowerBound(1500, false),
        filter: (r) => r.key >= 1500,
      },
      {
        label: 'lowerBound (1500, inf) exclusive',
        range: IDBKeyRange.lowerBound(1500, true),
        filter: (r) => r.key > 1500,
      },
      {
        label: 'upperBound (-inf, 500] inclusive',
        range: IDBKeyRange.upperBound(500, false),
        filter: (r) => r.key <= 500,
      },
      {
        label: 'upperBound (-inf, 500) exclusive',
        range: IDBKeyRange.upperBound(500, true),
        filter: (r) => r.key < 500,
      },
      {
        label: 'only [777]',
        range: IDBKeyRange.only(777),
        filter: (r) => r.key === 777,
      },
    ];

    for (const testCase of rangeCases) {
      const cand = await corpusDB.queryCandidates(corpusQVec, { range: testCase.range, limit: 10 });
      const oracle = fullOracle.filter(testCase.filter).slice(0, 10);
      check(keysMatch(cand.results, oracle), `${testCase.label}: keys match oracle`);
      check(bits(cand.results) === bits(oracle), `${testCase.label}: bit-exact similarity scores match oracle`);
    }

    // --- Compound keys: ['tenant', 'category'] index with IDBKeyRange.bound(['a', 1], ['a', 9])
    const compoundCand = await corpusDB.queryCandidates(corpusQVec, {
      index: 'tenant_category',
      range: IDBKeyRange.bound(['a', 1], ['a', 9]),
      limit: 15,
    });
    const compoundOracle = fullOracle.filter((r) => r.object.tenant === 'a' && r.object.category >= 1 && r.object.category <= 9).slice(0, 15);
    check(compoundCand.info.recordsRead === fullOracle.filter((r) => r.object.tenant === 'a' && r.object.category >= 1 && r.object.category <= 9).length, `compound index reads exactly its eligible records, got ${compoundCand.info.recordsRead}`);
    check(keysMatch(compoundCand.results, compoundOracle), 'compound index keys match oracle');
    check(bits(compoundCand.results) === bits(compoundOracle), 'compound index bit-exact scores match oracle');
    check(compoundCand.results.every((r) => r.object.tenant === 'a' && r.object.category >= 1 && r.object.category <= 9), 'compound index returned only tenant "a" in category 1..9');

    // --- Index duplicates: 40 records sharing one index key (cluster: 'duplicate-group') ------
    const dupsCand = await corpusDB.queryCandidates(corpusQVec, {
      index: 'cluster',
      range: IDBKeyRange.only('duplicate-group'),
      limit: 50,
    });
    const dupsOracle = fullOracle.filter((r) => r.object.cluster === 'duplicate-group').slice(0, 50);
    check(dupsCand.info.recordsRead === 40, `duplicate index read all 40 candidates, got ${dupsCand.info.recordsRead}`);
    check(dupsCand.info.recordsScored === 40, `duplicate index scored all 40 candidates, got ${dupsCand.info.recordsScored}`);
    check(dupsCand.results.length === 40, `all 40 duplicates preserved and returned, got ${dupsCand.results.length}`);
    check(keysMatch(dupsCand.results, dupsOracle), 'duplicate index top-k keys equal oracle');
    check(bits(dupsCand.results) === bits(dupsOracle), 'duplicate index bit-exact scores equal oracle');

    // --- Selectivity: 1%, 10% and 100% eligible ----------------------------------------------
    // 1% selectivity: category 42 is assigned to i % 100 === 42 (exactly 20 records out of 2000 = 1%)
    const sel1Cand = await corpusDB.queryCandidates(corpusQVec, {
      index: 'category',
      range: IDBKeyRange.only(42),
      limit: 10,
    });
    const sel1Oracle = fullOracle.filter((r) => r.object.category === 42).slice(0, 10);
    check(sel1Cand.info.recordsRead === 20, `1% selectivity read exactly 20 candidates, got ${sel1Cand.info.recordsRead}`);
    check(keysMatch(sel1Cand.results, sel1Oracle), '1% selectivity keys match oracle');
    check(bits(sel1Cand.results) === bits(sel1Oracle), '1% selectivity scores match oracle');

    // 10% selectivity: category 10..19 (20 records each * 10 = 200 records out of 2000 = 10%)
    const sel10Cand = await corpusDB.queryCandidates(corpusQVec, {
      index: 'category',
      range: IDBKeyRange.bound(10, 19),
      limit: 10,
    });
    const sel10Oracle = fullOracle.filter((r) => r.object.category >= 10 && r.object.category <= 19).slice(0, 10);
    check(sel10Cand.info.recordsRead === 200, `10% selectivity read exactly 200 candidates, got ${sel10Cand.info.recordsRead}`);
    check(keysMatch(sel10Cand.results, sel10Oracle), '10% selectivity keys match oracle');
    check(bits(sel10Cand.results) === bits(sel10Oracle), '10% selectivity scores match oracle');

    // 100% selectivity: no predicate/index narrowing (entire corpus eligible)
    const sel100Cand = await corpusDB.queryCandidates(corpusQVec, { limit: 10 });
    const sel100Oracle = fullOracle.slice(0, 10);
    check(sel100Cand.info.fullScanRequired === true, '100% selectivity sets fullScanRequired true');
    check(sel100Cand.info.recordsRead === CORPUS_SIZE, `100% selectivity read all ${CORPUS_SIZE} records`);
    check(keysMatch(sel100Cand.results, sel100Oracle), '100% selectivity keys match unfiltered oracle');
    check(bits(sel100Cand.results) === bits(sel100Oracle), '100% selectivity bit-exact scores match unfiltered oracle');

    // --- 12. Cost measurement (10,000 records, 32 dimensions; only with --measure) -----------
    // Kept out of the default run because it writes 40,000 records. The STORAGE phase writes each
    // store on its own because navigator.storage.estimate() can only attribute growth between two
    // samples; the TIMING phase then interleaves the two stores and alternates which is written
    // first, so a warm-up advantage cannot be mistaken for an index cost.
    const measureCosts = async () => {
      const MEASURE_RECORDS = 10000;
      const BATCH_SIZE = 500;
      const BATCHES = MEASURE_RECORDS / BATCH_SIZE; // 20 batches of 500
      const noIndexCostName = `cost-noindex-${crypto.randomUUID()}`;
      const withIndexCostName = `cost-withindex-${crypto.randomUUID()}`;
      databasesToClean.push(noIndexCostName, withIndexCostName);

      // estimate() is origin-wide, coarse and lags writes: a read right after a transaction can
      // still report the previous value, or a lower one after internal compaction. Poll until two
      // consecutive readings agree, and treat a decrease as "below the platform's resolution"
      // rather than reporting a negative size.
      const estimateUsage = async () => {
        let previous = (await navigator.storage.estimate()).usage ?? 0;
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const current = (await navigator.storage.estimate()).usage ?? 0;
          if (current === previous) return current;
          previous = current;
        }
        return previous;
      };
      const storageDelta = (from, to) => (to >= from ? to - from : null);

      const createCostStore = (name, withIndex) => openRaw(name, 1, (event) => {
        const store = event.target.result.createObjectStore('vectors', { autoIncrement: true });
        if (withIndex) store.createIndex('label', 'label');
      });
      const corpus = [];
      for (let i = 1; i <= MEASURE_RECORDS * 2; i++) {
        // The index under measurement is over a 96-character string key: an index over a numeric
        // key at this size is smaller than navigator.storage.estimate() can resolve.
        corpus.push({ id: i, category: i % 50, label: `label-${String(i).padStart(6, '0')}-${'x'.repeat(96)}`, embedding: makeVector(32) });
      }
      const writeBatches = async (db, times) => {
        for (let b = 0; b < BATCHES; b++) {
          const batch = corpus.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
          const started = performance.now();
          const transaction = db.transaction('vectors', 'readwrite');
          const store = transaction.objectStore('vectors');
          for (const record of batch) store.add(record);
          await txComplete(transaction);
          times.push(performance.now() - started);
        }
      };

      (await createCostStore(noIndexCostName, false)).close();
      (await createCostStore(withIndexCostName, true)).close();

      // Storage phase: the same 10,000 records into each store, sampled between phases.
      const storageStart = await estimateUsage();
      const storageNoIndexDb = await openRaw(noIndexCostName);
      await writeBatches(storageNoIndexDb, []);
      storageNoIndexDb.close();
      const storageAfterNoIndexWrites = await estimateUsage();
      const storageWithIndexDb = await openRaw(withIndexCostName);
      await writeBatches(storageWithIndexDb, []);
      storageWithIndexDb.close();
      const storageAfterWithIndexWrites = await estimateUsage();
      const storageDeltaWithoutIndex = storageDelta(storageStart, storageAfterNoIndexWrites);
      const storageDeltaWithIndex = storageDelta(storageAfterNoIndexWrites, storageAfterWithIndexWrites);
      // Two origin-wide readings of the same corpus differ by less than estimate()'s resolution when
      // the second one comes out smaller. That is an unresolved measurement, not a negative size.
      const storageIndexOverhead = storageDeltaWithoutIndex === null || storageDeltaWithIndex === null || storageDeltaWithIndex < storageDeltaWithoutIndex
        ? null
        : storageDeltaWithIndex - storageDeltaWithoutIndex;
      const storageIndexOverheadReason = storageIndexOverhead !== null ? null
        : 'the same corpus written with and without the index differed by less than navigator.storage.estimate() resolves at this size (the build delta over a populated store was still measurable)';

      // Timing phase: both stores already hold the same 10,000 records, one of them with the index
      // from the start; the next 10,000 go in through identical 500-record transactions.
      const dbNoIdx = await openRaw(noIndexCostName);
      const dbWithIdx = await openRaw(withIndexCostName);
      const noIndexBatches = [];
      const withIndexBatches = [];
      for (let b = 0; b < BATCHES; b++) {
        const batch = corpus.slice(MEASURE_RECORDS + b * BATCH_SIZE, MEASURE_RECORDS + (b + 1) * BATCH_SIZE);
        const order = b % 2 === 0
          ? [[dbNoIdx, noIndexBatches], [dbWithIdx, withIndexBatches]]
          : [[dbWithIdx, withIndexBatches], [dbNoIdx, noIndexBatches]];
        for (const [db, times] of order) {
          const started = performance.now();
          const transaction = db.transaction('vectors', 'readwrite');
          const store = transaction.objectStore('vectors');
          for (const record of batch) store.add(record);
          await txComplete(transaction);
          times.push(performance.now() - started);
        }
      }
      dbNoIdx.close();
      dbWithIdx.close();

      // Index build: add the index to a populated store that never had one, timed to completion.
      const storageBeforeIndexBuild = await estimateUsage();
      const upgradeStart = performance.now();
      const upgrade = indexedDB.open(noIndexCostName, 2);
      upgrade.onupgradeneeded = (event) => {
        event.target.transaction.objectStore('vectors').createIndex('label', 'label');
      };
      const upgraded = await new Promise((resolve, reject) => {
        upgrade.onsuccess = () => resolve(upgrade.result);
        upgrade.onerror = () => reject(upgrade.error);
      });
      const indexBuildMs = performance.now() - upgradeStart;
      upgraded.close();
      const storageAfterIndexBuild = await estimateUsage();
      const storageDeltaIndexBuild = storageDelta(storageBeforeIndexBuild, storageAfterIndexBuild);

      const total = (times) => times.reduce((sum, ms) => sum + ms, 0);
      return {
        storageRecordCount: MEASURE_RECORDS,
        timedRecordCount: MEASURE_RECORDS,
        indexBuildRecordCount: MEASURE_RECORDS * 2,
        dimensions: 32,
        batchSize: BATCH_SIZE,
        batchCount: BATCHES,
        indexBuildMs,
        writeWithoutIndexMs: total(noIndexBatches),
        writeWithIndexMs: total(withIndexBatches),
        avgBatchWithoutIndexMs: total(noIndexBatches) / BATCHES,
        avgBatchWithIndexMs: total(withIndexBatches) / BATCHES,
        storageDeltaWithoutIndex,
        storageDeltaWithIndex,
        indexKey: 'label (96-character string)',
        storageIndexOverhead,
        storageIndexOverheadReason,
        storageDeltaIndexBuild,
        storageUsage: {
          start: storageStart,
          afterNoIndexWrites: storageAfterNoIndexWrites,
          afterWithIndexWrites: storageAfterWithIndexWrites,
          beforeIndexBuild: storageBeforeIndexBuild,
          afterIndexBuild: storageAfterIndexBuild,
        },
        limitations: 'STORAGE: the index is over a 96-character string key because a numeric-key index at this size is smaller than navigator.storage.estimate() can resolve; that estimate is origin-wide, coarse and lags writes, so a null delta means the estimate decreased between samples of an unchanged corpus and is reported as unresolved, not as a size. TIMING: the two stores are written in 500-record transactions with the write order alternating per batch, both already holding the same 10,000 records. One machine, not a benchmark.',
      };
    };

    const measurements = measure ? await measureCosts() : null;

    // Cleanup databases
    for (const name of databasesToClean) {
      indexedDB.deleteDatabase(name);
    }

    return {
      checks: checks.length,
      refusals,
      measurements,
    };
  }, process.argv.includes('--measure'));

  assert.ok(result.checks >= 50, `expected full test battery, ran ${result.checks} checks`);

  const bytesOrUnresolved = (value) => value === null
    ? 'not resolvable (the origin usage estimate decreased between samples)'
    : `${value} bytes`;

  if (result.measurements === null) {
    console.log(`PASS: ${result.checks} candidate query checks in a real browser`);
    console.log('Cost measurement skipped: run `npm run measure:candidates` for index build, write and storage numbers.');
  } else {
    assert.ok(Number.isFinite(result.measurements.indexBuildMs) && result.measurements.indexBuildMs > 0, 'index build time measured');
    assert.ok(result.measurements.writeWithoutIndexMs > 0 && result.measurements.writeWithIndexMs > 0, 'write costs measured');
    if (process.env.IDB_VECTOR_CANDIDATES_REPORT) {
      await writeFile(
        process.env.IDB_VECTOR_CANDIDATES_REPORT,
        JSON.stringify(result.measurements, null, 2),
        'utf8',
      );
    }

    const measurements = result.measurements;
    console.log(`PASS: ${result.checks} candidate query checks in a real browser`);
    console.log(`Candidate query cost (${measurements.storageRecordCount} records written per store, then ${measurements.timedRecordCount} more per store for timing; ${measurements.dimensions} dimensions):`);
    console.log(`  Index build time over a populated store (${measurements.indexBuildRecordCount} records): ${measurements.indexBuildMs.toFixed(1)} ms`);
    console.log(`  Write cost without index: ${measurements.writeWithoutIndexMs.toFixed(1)} ms total (${measurements.avgBatchWithoutIndexMs.toFixed(2)} ms/batch of ${measurements.batchSize})`);
    console.log(`  Write cost with index: ${measurements.writeWithIndexMs.toFixed(1)} ms total (${measurements.avgBatchWithIndexMs.toFixed(2)} ms/batch of ${measurements.batchSize})`);
    console.log(`  Write overhead with index: ${((measurements.writeWithIndexMs / measurements.writeWithoutIndexMs - 1) * 100).toFixed(1)}%`);
    console.log(`  Storage growth writing ${measurements.storageRecordCount} records without an index: ${bytesOrUnresolved(measurements.storageDeltaWithoutIndex)}`);
    console.log(`  Storage growth writing the same records with the index from the start: ${bytesOrUnresolved(measurements.storageDeltaWithIndex)} (index overhead for a ${measurements.indexKey} key: ${bytesOrUnresolved(measurements.storageIndexOverhead)}${measurements.storageIndexOverheadReason ? `: ${measurements.storageIndexOverheadReason}` : ''})`);
    console.log(`  Storage growth adding the index to the populated store (${measurements.indexBuildRecordCount} records): ${bytesOrUnresolved(measurements.storageDeltaIndexBuild)}`);
    console.log(`  Raw origin usage samples: ${JSON.stringify(measurements.storageUsage)}`);
    console.log(`  ${measurements.limitations}`);
  }

  console.log('Sample refusals:');
  for (const [label, msg] of Object.entries(result.refusals).slice(0, 5)) {
    console.log(`  ${label} -> ${msg}`);
  }
} finally {
  await page?.close();
  await new Promise((resolve) => server.close(resolve));
}
