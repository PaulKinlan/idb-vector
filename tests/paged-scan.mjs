// tests/paged-scan.mjs — bounded paged scans and hoisted query norm parity vs cursor path
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';

const gitCommit = (() => {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  const result = await page.evaluate(async (measure, commit) => {
    const { VectorDB } = await import('/index.js');
    const { SortedArray } = await import('/utils/sortedarray.js');

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

    // Key representation for safe comparison (Array and Date keys cannot use ===)
    const keyStr = (k) => {
      if (k instanceof Date) return `Date:${k.toISOString()}:${k.getTime()}`;
      if (Array.isArray(k)) return JSON.stringify(k);
      return String(k);
    };

    const keysMatch = (rowsA, rowsB) => {
      if (rowsA.length !== rowsB.length) return false;
      return rowsA.every((row, i) => keyStr(row.key) === keyStr(rowsB[i].key));
    };

    // Float64 view for bit-exact similarity score comparison
    const scoreBytes = (rows) => {
      const floats = new Float64Array(rows.map((r) => r.similarity));
      return Array.from(new Uint8Array(floats.buffer)).join(',');
    };

    const assertParity = (cursorRows, pagedRows, label) => {
      check(cursorRows.length === pagedRows.length, `${label}: identical length (${cursorRows.length} === ${pagedRows.length})`);
      check(keysMatch(cursorRows, pagedRows), `${label}: positional key equality`);
      check(scoreBytes(cursorRows) === scoreBytes(pagedRows), `${label}: Float64-bit-identical scores`);
    };

    // Seeded deterministic PRNG for reproducible vectors
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

    try {
      // =========================================================================================
      // 1. KEY-TYPE MATRIX & 4. NO DUPLICATES, NO SKIPS
      // Compare cursor vs paged across four store configurations:
      // (a) library default autoIncrement store
      // (b) caller schema with string in-line keyPath
      // (c) out-of-line store with array/compound keys
      // (d) out-of-line store with Date keys
      // =========================================================================================
      const MATRIX_CORPUS_SIZE = 64;
      const matrixVectors = Array.from({ length: MATRIX_CORPUS_SIZE }, () => makeVector(32));
      const matrixQVec = makeVector(32);

      // (a) Library autoIncrement store
      const dbNameA = `matrix-auto-${crypto.randomUUID()}`;
      databasesToClean.push(dbNameA);
      const dbA = new VectorDB({ dbName: dbNameA, vectorPath: 'embedding' });
      for (let i = 0; i < MATRIX_CORPUS_SIZE; i++) {
        await dbA.insert({ title: `doc-${i}`, embedding: matrixVectors[i] });
      }

      // (b) Caller schema with string in-line keyPath
      const dbNameB = `matrix-string-inline-${crypto.randomUUID()}`;
      databasesToClean.push(dbNameB);
      const rawB = await openRaw(dbNameB, 1, (e) => {
        e.target.result.createObjectStore('documents', { keyPath: 'docId' });
      });
      const txB = rawB.transaction('documents', 'readwrite');
      const stB = txB.objectStore('documents');
      for (let i = 0; i < MATRIX_CORPUS_SIZE; i++) {
        stB.add({ docId: `doc-${String(i).padStart(4, '0')}`, title: `doc-${i}`, embedding: matrixVectors[i] });
      }
      await txComplete(txB);
      rawB.close();
      const dbB = new VectorDB({ dbName: dbNameB, objectStore: 'documents', vectorPath: 'embedding' });

      // (c) Out-of-line store with array/compound keys
      const dbNameC = `matrix-compound-out-${crypto.randomUUID()}`;
      databasesToClean.push(dbNameC);
      const rawC = await openRaw(dbNameC, 1, (e) => {
        e.target.result.createObjectStore('documents');
      });
      const txC = rawC.transaction('documents', 'readwrite');
      const stC = txC.objectStore('documents');
      const compoundKeys = [];
      for (let i = 0; i < MATRIX_CORPUS_SIZE; i++) {
        const k = [`tenant-${i % 4}`, i];
        compoundKeys.push(k);
        stC.add({ title: `doc-${i}`, embedding: matrixVectors[i] }, k);
      }
      await txComplete(txC);
      rawC.close();
      const dbC = new VectorDB({ dbName: dbNameC, objectStore: 'documents', vectorPath: 'embedding' });

      // (d) Out-of-line store with Date keys
      const dbNameD = `matrix-date-out-${crypto.randomUUID()}`;
      databasesToClean.push(dbNameD);
      const rawD = await openRaw(dbNameD, 1, (e) => {
        e.target.result.createObjectStore('documents');
      });
      const txD = rawD.transaction('documents', 'readwrite');
      const stD = txD.objectStore('documents');
      const dateKeys = [];
      for (let i = 0; i < MATRIX_CORPUS_SIZE; i++) {
        const k = new Date(1700000000000 + i * 60000);
        dateKeys.push(k);
        stD.add({ title: `doc-${i}`, embedding: matrixVectors[i] }, k);
      }
      await txComplete(txD);
      rawD.close();
      const dbD = new VectorDB({ dbName: dbNameD, objectStore: 'documents', vectorPath: 'embedding' });

      const matrixStores = [
        { label: 'autoIncrement store', db: dbA, expectedTotal: MATRIX_CORPUS_SIZE },
        { label: 'string in-line keyPath store', db: dbB, expectedTotal: MATRIX_CORPUS_SIZE },
        { label: 'compound array key store', db: dbC, expectedTotal: MATRIX_CORPUS_SIZE },
        { label: 'Date key store', db: dbD, expectedTotal: MATRIX_CORPUS_SIZE },
      ];

      for (const { label, db, expectedTotal } of matrixStores) {
        // Query top 10: cursor vs paged with pageSize 7
        const cursor10 = await db.query(matrixQVec, { limit: 10 });
        const paged10 = await db.query(matrixQVec, { limit: 10, pageSize: 7 });
        assertParity(cursor10, paged10, `key-matrix ${label} top-10`);

        // Query all: cursor vs paged with pageSize 5 (does not divide 64 evenly)
        const cursorAll = await db.query(matrixQVec, { limit: expectedTotal });
        const pagedAll = await db.query(matrixQVec, { limit: expectedTotal, pageSize: 5 });
        assertParity(cursorAll, pagedAll, `key-matrix ${label} all-${expectedTotal}`);

        // Coverage 4: No duplicates, no skips with limit larger than store
        const pagedOver = await db.query(matrixQVec, { limit: expectedTotal + 50, pageSize: 7 });
        check(pagedOver.length === expectedTotal, `${label}: limit > store returns exact record count (${expectedTotal})`);
        const keySet = new Set(pagedOver.map((r) => keyStr(r.key)));
        check(keySet.size === expectedTotal, `${label}: no duplicate keys returned`);
        const cursorOver = await db.query(matrixQVec, { limit: expectedTotal + 50 });
        assertParity(cursorOver, pagedOver, `${label}: limit > store cursor vs paged parity`);
      }

      // =========================================================================================
      // 2. PAGESIZE GRID
      // Grid: 1, 2, 3, 7, exactly corpus size, larger than corpus, and value dividing corpus evenly.
      // Corpus >= 60 records where count is not a multiple of pageSize (70 records).
      // =========================================================================================
      const GRID_CORPUS_SIZE = 70;
      const gridDbName = `grid-corpus-70-${crypto.randomUUID()}`;
      databasesToClean.push(gridDbName);
      const gridDB = new VectorDB({ dbName: gridDbName, vectorPath: 'embedding' });
      const gridVectors = Array.from({ length: GRID_CORPUS_SIZE }, () => makeVector(32));
      const gridQVec = makeVector(32);
      for (let i = 0; i < GRID_CORPUS_SIZE; i++) {
        await gridDB.insert({ id: i + 1, embedding: gridVectors[i] });
      }

      // 70 is not a multiple of 3 (70 = 23 * 3 + 1, so the last page is 1 record: short page)
      // 70 is divided evenly by 7 (10 pages) and 10 (7 pages)
      const pageSizeGrid = [1, 2, 3, 7, 10, GRID_CORPUS_SIZE, GRID_CORPUS_SIZE + 50];
      const gridCursorTop15 = await gridDB.query(gridQVec, { limit: 15 });
      const gridCursorAll = await gridDB.query(gridQVec, { limit: GRID_CORPUS_SIZE });

      for (const ps of pageSizeGrid) {
        // Test top-15 truncation
        const paged15 = await gridDB.query(gridQVec, { limit: 15, pageSize: ps });
        assertParity(gridCursorTop15, paged15, `grid pageSize ${ps} top-15`);

        // Test full corpus retrieval
        const pagedAll = await gridDB.query(gridQVec, { limit: GRID_CORPUS_SIZE, pageSize: ps });
        assertParity(gridCursorAll, pagedAll, `grid pageSize ${ps} full corpus (${GRID_CORPUS_SIZE})`);
      }

      // =========================================================================================
      // 3. TIES
      // Heavy score ties, including ties exactly at rank `limit` and across a page boundary.
      // =========================================================================================
      const tiesDbName = `ties-corpus-${crypto.randomUUID()}`;
      databasesToClean.push(tiesDbName);
      const tiesDB = new VectorDB({ dbName: tiesDbName, vectorPath: 'embedding' });
      const tieQ = makeVector(32);
      const topVec = tieQ.slice(); // cosine similarity exactly 1.0
      const tiedVec = makeVector(32); // identical vector across multiple records
      const lowVec = tiedVec.map((x) => -x); // low similarity

      // 25 records:
      // Record 1: topVec (rank 1)
      // Records 2..16 (15 records): tiedVec (ranks 2..16 all tie)
      // Records 17..25 (9 records): lowVec
      await tiesDB.insert({ id: 1, embedding: topVec });
      for (let i = 2; i <= 16; i++) {
        await tiesDB.insert({ id: i, embedding: tiedVec });
      }
      for (let i = 17; i <= 25; i++) {
        await tiesDB.insert({ id: i, embedding: lowVec });
      }

      // Query with limit 10, pageSize 5:
      // Page 1: records 1..5 (5 is in tie group)
      // Page 2: records 6..10 (10 is page boundary AND rank limit!)
      // Page 3: records 11..15 (boundary between 15 and 16)
      // Tie group spans pages 1, 2, 3 and straddles rank limit 10.
      const tiesCursor10 = await tiesDB.query(tieQ, { limit: 10 });
      const tiesPaged10 = await tiesDB.query(tieQ, { limit: 10, pageSize: 5 });
      assertParity(tiesCursor10, tiesPaged10, 'ties limit 10, pageSize 5');

      // Ties break by read order (primary key order): keys must be strictly 1..10
      const tiesPagedKeys10 = tiesPaged10.map((r) => r.key);
      check(JSON.stringify(tiesPagedKeys10) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        `ties paged preserved read order across limit: ${JSON.stringify(tiesPagedKeys10)}`);

      // Query full store (limit 25) with pageSize 4: page boundary falls inside tie group
      const tiesCursor25 = await tiesDB.query(tieQ, { limit: 25 });
      const tiesPaged25 = await tiesDB.query(tieQ, { limit: 25, pageSize: 4 });
      assertParity(tiesCursor25, tiesPaged25, 'ties limit 25, pageSize 4');
      const tiesPagedKeys25 = tiesPaged25.map((r) => r.key);
      check(new Set(tiesPagedKeys25).size === 25, 'ties full store has 25 unique keys');
      check(tiesPagedKeys25[0] === 1, 'rank 1 is record 1');
      // Tie group 2..16 must be complete and in order
      const tieGroupSlice = tiesPagedKeys25.slice(1, 16);
      check(JSON.stringify(tieGroupSlice) === JSON.stringify(Array.from({ length: 15 }, (_, i) => i + 2)),
        'tie group across page boundaries is complete and not duplicated');

      // =========================================================================================
      // 5. RULES SHARED BY BOTH PATHS
      // (a) Records with no value at vectorPath are skipped identically across page boundaries
      // (b) Invalid record (wrong dimension, empty, NaN, non-array) refused identically naming key
      // (c) Throwing predicate refused identically naming key
      // =========================================================================================
      const rulesDbName = `rules-shared-${crypto.randomUUID()}`;
      databasesToClean.push(rulesDbName);
      const rulesRaw = await openRaw(rulesDbName, 1, (e) => {
        e.target.result.createObjectStore('vectors', { autoIncrement: true });
      });
      const rulesTx = rulesRaw.transaction('vectors', 'readwrite');
      const rulesStore = rulesTx.objectStore('vectors');
      const validVec = makeVector(32);
      // Insert 20 records; keys 3, 6, 9, 12, 15, 18 have NO vectorPath property
      const missingKeys = [3, 6, 9, 12, 15, 18];
      for (let i = 1; i <= 20; i++) {
        if (missingKeys.includes(i)) {
          rulesStore.add({ id: i, title: `doc-${i}-missing-vector` });
        } else {
          rulesStore.add({ id: i, title: `doc-${i}`, embedding: validVec });
        }
      }
      await txComplete(rulesTx);
      rulesRaw.close();

      const rulesDB = new VectorDB({ dbName: rulesDbName, vectorPath: 'embedding' });
      const rulesCursor = await rulesDB.query(validVec, { limit: 20 });
      const rulesPaged = await rulesDB.query(validVec, { limit: 20, pageSize: 4 });
      assertParity(rulesCursor, rulesPaged, 'records with missing vectorPath skipped identically');
      check(rulesCursor.length === 14, `missing vectors skipped: expected 14 records, got ${rulesCursor.length}`);
      for (const mk of missingKeys) {
        check(!rulesCursor.some((r) => r.key === mk), `record ${mk} with missing vector was skipped by cursor`);
        check(!rulesPaged.some((r) => r.key === mk), `record ${mk} with missing vector was skipped by paged`);
      }

      // Invalid record refusal comparisons:
      const invalidCases = [
        {
          label: 'wrong dimension (16 coordinates instead of 32)',
          vector: makeVector(16),
          expectedConstructor: TypeError,
          includes: ["stored vectorPath 'embedding' for key 5", 'has 16 coordinates but the query vector has 32'],
        },
        {
          label: 'empty vector array',
          vector: [],
          expectedConstructor: TypeError,
          includes: ["stored vectorPath 'embedding' for key 5", 'is empty'],
        },
        {
          label: 'NaN coordinate',
          vector: [NaN, ...validVec.slice(1)],
          expectedConstructor: TypeError,
          includes: ["stored vectorPath 'embedding' for key 5", 'coordinate 0 is NaN, not a finite number'],
        },
        {
          label: 'non-array vector',
          vector: 'not-an-array',
          expectedConstructor: TypeError,
          includes: ["stored vectorPath 'embedding' for key 5", 'must be an Array of finite numbers'],
        },
      ];

      for (const inv of invalidCases) {
        const invDbName = `rules-inv-${crypto.randomUUID()}`;
        databasesToClean.push(invDbName);
        const invRaw = await openRaw(invDbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { autoIncrement: true });
        });
        const invTx = invRaw.transaction('vectors', 'readwrite');
        const invSt = invTx.objectStore('vectors');
        for (let i = 1; i <= 8; i++) {
          if (i === 5) {
            invSt.add({ id: 5, embedding: inv.vector });
          } else {
            invSt.add({ id: i, embedding: validVec });
          }
        }
        await txComplete(invTx);
        invRaw.close();

        const invDB = new VectorDB({ dbName: invDbName, vectorPath: 'embedding' });
        const cursorErr = await refusal(
          `cursor refusal for ${inv.label}`,
          () => invDB.query(validVec, { limit: 10 }),
          { type: inv.expectedConstructor, includes: inv.includes }
        );
        const pagedErr = await refusal(
          `paged refusal for ${inv.label}`,
          () => invDB.query(validVec, { limit: 10, pageSize: 2 }),
          { type: inv.expectedConstructor, includes: inv.includes }
        );
        check(cursorErr.message === pagedErr.message, `${inv.label}: cursor and paged emit identical error messages`);
      }

      // Throwing predicate refused identically
      const throwDbName = `rules-throwing-pred-${crypto.randomUUID()}`;
      databasesToClean.push(throwDbName);
      const throwDB = new VectorDB({ dbName: throwDbName, vectorPath: 'embedding' });
      for (let i = 1; i <= 6; i++) {
        await throwDB.insert({ id: i, embedding: validVec });
      }
      const throwingPredicate = (rec) => {
        if (rec.id === 4) throw new Error('user explosion in predicate');
        return true;
      };
      const predCursorErr = await refusal(
        'cursor throwing predicate',
        () => throwDB.queryCandidates(validVec, { predicate: throwingPredicate, limit: 10 }),
        { type: Error, includes: ['queryCandidates() predicate threw for key 4', 'user explosion in predicate'] }
      );
      const predPagedErr = await refusal(
        'paged throwing predicate',
        () => throwDB.queryCandidates(validVec, { predicate: throwingPredicate, limit: 10, pageSize: 2 }),
        { type: Error, includes: ['queryCandidates() predicate threw for key 4', 'user explosion in predicate'] }
      );
      check(predCursorErr.message === predPagedErr.message, 'throwing predicate: cursor and paged emit identical error messages');

      // =========================================================================================
      // 6. PREDICATE + PAGESIZE
      // Predicate filtering with pageSize equals cursor result; info.recordsRead and
      // info.recordsScored must be identical.
      // =========================================================================================
      const predFilterDbName = `predicate-filter-${crypto.randomUUID()}`;
      databasesToClean.push(predFilterDbName);
      const predFilterDB = new VectorDB({ dbName: predFilterDbName, vectorPath: 'embedding' });
      for (let i = 1; i <= 30; i++) {
        await predFilterDB.insert({
          id: i,
          category: i % 3 === 0 ? 'accepted' : 'filtered',
          embedding: makeVector(32),
        });
      }
      const filterPred = (rec) => rec.category === 'accepted';
      const predCursorResult = await predFilterDB.queryCandidates(validVec, { predicate: filterPred, limit: 10 });
      const predPagedResult = await predFilterDB.queryCandidates(validVec, { predicate: filterPred, limit: 10, pageSize: 4 });
      assertParity(predCursorResult.results, predPagedResult.results, 'predicate + pageSize result parity');
      check(predPagedResult.info.recordsRead === 30, `predicate paged visited all 30 records, got ${predPagedResult.info.recordsRead}`);
      check(predPagedResult.info.recordsScored === 10, `predicate paged scored exactly 10 matching records, got ${predPagedResult.info.recordsScored}`);
      check(predCursorResult.info.recordsRead === predPagedResult.info.recordsRead,
        `info.recordsRead identical: ${predCursorResult.info.recordsRead} === ${predPagedResult.info.recordsRead}`);
      check(predCursorResult.info.recordsScored === predPagedResult.info.recordsScored,
        `info.recordsScored identical: ${predCursorResult.info.recordsScored} === ${predPagedResult.info.recordsScored}`);

      // =========================================================================================
      // 7. DISCLOSURE
      // info.readMode === "paged" & info.pageSize === P when paging;
      // info.readMode === "cursor" & info.pageSize === null when not;
      // info.mode === "full-scan" in every paged case.
      // =========================================================================================
      const disclosureDbName = `disclosure-${crypto.randomUUID()}`;
      databasesToClean.push(disclosureDbName);
      const disclosureDB = new VectorDB({ dbName: disclosureDbName, vectorPath: 'embedding' });
      for (let i = 1; i <= 5; i++) {
        await disclosureDB.insert({ id: i, embedding: validVec });
      }

      const pagedDisclosure = await disclosureDB.queryCandidates(validVec, { limit: 3, pageSize: 2 });
      check(pagedDisclosure.info.readMode === 'paged', `paging discloses readMode: 'paged', got ${pagedDisclosure.info.readMode}`);
      check(pagedDisclosure.info.pageSize === 2, `paging discloses pageSize: 2, got ${pagedDisclosure.info.pageSize}`);
      check(pagedDisclosure.info.mode === 'full-scan', `paging discloses mode: 'full-scan', got ${pagedDisclosure.info.mode}`);
      check(pagedDisclosure.info.fullScanRequired === true, 'paging discloses fullScanRequired: true');

      const cursorDisclosure = await disclosureDB.queryCandidates(validVec, { limit: 3 });
      check(cursorDisclosure.info.readMode === 'cursor', `cursor discloses readMode: 'cursor', got ${cursorDisclosure.info.readMode}`);
      check(cursorDisclosure.info.pageSize === null, `cursor discloses pageSize: null, got ${cursorDisclosure.info.pageSize}`);
      check(cursorDisclosure.info.mode === 'full-scan', `cursor discloses mode: 'full-scan', got ${cursorDisclosure.info.mode}`);

      // =========================================================================================
      // 8. REFUSALS BY CONSTRUCTOR AND MESSAGE & STORE UNCHANGED
      // =========================================================================================
      const refusalsDbName = `refusals-test-${crypto.randomUUID()}`;
      databasesToClean.push(refusalsDbName);
      const refRaw = await openRaw(refusalsDbName, 1, (e) => {
        const store = e.target.result.createObjectStore('vectors', { autoIncrement: true });
        store.createIndex('category', 'category');
      });
      const refTx = refRaw.transaction('vectors', 'readwrite');
      const refSt = refTx.objectStore('vectors');
      for (let i = 1; i <= 10; i++) {
        refSt.add({ id: i, category: 'tech', embedding: validVec });
      }
      await txComplete(refTx);
      refRaw.close();

      const refusalDB = new VectorDB({ dbName: refusalsDbName, vectorPath: 'embedding' });

      // Count records before refusals
      const countBeforeReq = await openRaw(refusalsDbName);
      const countBefore = await reqPromise(countBeforeReq.transaction('vectors', 'readonly').objectStore('vectors').count());
      countBeforeReq.close();
      check(countBefore === 10, 'initial count is 10');

      // Invalid page sizes: RangeError
      const invalidPageSizes = [
        { val: 0, label: 'pageSize 0' },
        { val: -1, label: 'pageSize -1' },
        { val: 1.5, label: 'pageSize 1.5' },
        { val: '10', label: 'pageSize "10" (string)' },
        { val: NaN, label: 'pageSize NaN' },
        { val: Infinity, label: 'pageSize Infinity' },
      ];

      for (const { val, label } of invalidPageSizes) {
        await refusal(
          `query() ${label}`,
          () => refusalDB.query(validVec, { pageSize: val }),
          { type: RangeError, includes: ['pageSize must be a positive integer'] }
        );
        await refusal(
          `queryCandidates() ${label}`,
          () => refusalDB.queryCandidates(validVec, { pageSize: val }),
          { type: RangeError, includes: ['pageSize must be a positive integer'] }
        );
      }

      // Explicit null pageSize is accepted and falls back to cursor path
      const nullPageSizeQuery = await refusalDB.query(validVec, { pageSize: null });
      check(nullPageSizeQuery.length === 10, 'explicit null pageSize succeeds on query()');
      const nullPageSizeCand = await refusalDB.queryCandidates(validVec, { pageSize: null });
      check(nullPageSizeCand.info.readMode === 'cursor' && nullPageSizeCand.info.pageSize === null,
        'explicit null pageSize defaults to cursor path with pageSize null');

      // Huge-but-valid pageSize is accepted (e.g. 10_000_000 or max unsigned 32-bit int)
      const hugePageSizeCand = await refusalDB.queryCandidates(validVec, { pageSize: 10000000 });
      check(hugePageSizeCand.info.readMode === 'paged' && hugePageSizeCand.info.pageSize === 10000000,
        'huge-but-valid pageSize 10_000_000 is accepted as valid pageSize');

      // pageSize combined with IDBKeyRange: TypeError naming mode and mentioning cursor path
      await refusal(
        'pageSize combined with range',
        () => refusalDB.queryCandidates(validVec, { pageSize: 5, range: IDBKeyRange.bound(1, 5) }),
        {
          type: TypeError,
          includes: [
            'pageSize cannot be combined with an index or a key range',
            'mode store-range',
            'Omit pageSize to use the cursor path',
          ],
        }
      );

      // pageSize combined with index: TypeError naming mode and mentioning cursor path
      await refusal(
        'pageSize combined with index',
        () => refusalDB.queryCandidates(validVec, { pageSize: 5, index: 'category' }),
        {
          type: TypeError,
          includes: [
            'pageSize cannot be combined with an index or a key range',
            'mode index',
            'Omit pageSize to use the cursor path',
          ],
        }
      );

      // Verify refused calls left the store unchanged
      const countAfterReq = await openRaw(refusalsDbName);
      const countAfter = await reqPromise(countAfterReq.transaction('vectors', 'readonly').objectStore('vectors').count());
      countAfterReq.close();
      check(countAfter === countBefore, `refusals left store unchanged: ${countAfter} === ${countBefore}`);

      // =========================================================================================
      // 9. SNAPSHOT ISOLATION
      // Single transaction per paged read guarantees atomic snapshot:
      // (a) concurrent delete on a second connection is blocked until paged read finishes;
      //     read sees deleted record, no holes, all unique keys.
      // (b) concurrent insert on a second connection is blocked until read finishes;
      //     returned set is all-or-nothing (excludes concurrent inserts or contiguous prefix),
      //     keys are unique.
      // =========================================================================================
      const ISO_RECORDS = 10000;
      const isoDbName = `snapshot-isolation-${crypto.randomUUID()}`;
      databasesToClean.push(isoDbName);
      const isoRaw = await openRaw(isoDbName, 1, (e) => {
        e.target.result.createObjectStore('vectors', { autoIncrement: true });
      });
      // Insert 10,000 tiny records (2D vectors)
      const isoVec = [1, 0];
      const isoTx = isoRaw.transaction('vectors', 'readwrite');
      const isoSt = isoTx.objectStore('vectors');
      for (let i = 1; i <= ISO_RECORDS; i++) {
        isoSt.add({ id: i, embedding: isoVec });
      }
      await txComplete(isoTx);
      isoRaw.close();

      const isoDB = new VectorDB({ dbName: isoDbName, vectorPath: 'embedding' });
      // Warm up connection so VectorDB is ready
      await isoDB.query(isoVec, { limit: 1 });

      const isoDb2 = await openRaw(isoDbName);

      // (a) Delete variant: target key 9000 (which pageSize 1 takes many pages to reach)
      const targetDeleteKey = 9000;
      let deleteReadFinished = false;
      let deleteWriteCompletedBeforeRead = null;
      let deleteReadCompletionTime = 0;
      let deleteWriteCompletionTime = 0;

      const deleteReadStart = performance.now();
      const deleteReadPromise = isoDB.query(isoVec, { limit: ISO_RECORDS, pageSize: 1 }).then((rows) => {
        deleteReadCompletionTime = performance.now();
        deleteReadFinished = true;
        return rows;
      });

      // Yield microtasks so query() enters #rank and opens its transaction
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const deleteWriteStart = performance.now();
      const deleteWritePromise = new Promise((resolve, reject) => {
        const tx = isoDb2.transaction('vectors', 'readwrite');
        tx.objectStore('vectors').delete(targetDeleteKey);
        tx.oncomplete = () => {
          deleteWriteCompletionTime = performance.now();
          deleteWriteCompletedBeforeRead = !deleteReadFinished;
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });

      const [deleteReadRows] = await Promise.all([deleteReadPromise, deleteWritePromise]);
      const deleteReadMs = deleteReadCompletionTime - deleteReadStart;
      const deleteWriteMs = deleteWriteCompletionTime - deleteWriteStart;

      // Assertions:
      check(deleteReadRows.length === ISO_RECORDS, `snapshot isolation delete: read all ${ISO_RECORDS} records, got ${deleteReadRows.length}`);
      check(deleteReadRows.some((r) => r.key === targetDeleteKey), 'snapshot isolation delete: read still saw deleted record');
      const deleteKeySet = new Set(deleteReadRows.map((r) => r.key));
      check(deleteKeySet.size === ISO_RECORDS, 'snapshot isolation delete: all returned keys are unique');
      check(deleteWriteCompletedBeforeRead === false, 'snapshot isolation delete: write did NOT complete before read completed');
      check(deleteReadCompletionTime <= deleteWriteCompletionTime, 'snapshot isolation delete: read completed before write completion');

      // (b) Insert variant: append records 10001..10050 during paged read
      let insertReadFinished = false;
      let insertWriteCompletedBeforeRead = null;
      let insertReadCompletionTime = 0;
      let insertWriteCompletionTime = 0;

      const insertReadStart = performance.now();
      const insertReadPromise = isoDB.query(isoVec, { limit: ISO_RECORDS + 100, pageSize: 1 }).then((rows) => {
        insertReadCompletionTime = performance.now();
        insertReadFinished = true;
        return rows;
      });

      // Yield microtasks so read transaction opens
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const insertWriteStart = performance.now();
      const insertWritePromise = new Promise((resolve, reject) => {
        const tx = isoDb2.transaction('vectors', 'readwrite');
        const st = tx.objectStore('vectors');
        for (let i = ISO_RECORDS + 1; i <= ISO_RECORDS + 50; i++) {
          st.add({ id: i, embedding: isoVec });
        }
        tx.oncomplete = () => {
          insertWriteCompletionTime = performance.now();
          insertWriteCompletedBeforeRead = !insertReadFinished;
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      });

      const [insertReadRows] = await Promise.all([insertReadPromise, insertWritePromise]);
      const insertReadMs = insertReadCompletionTime - insertReadStart;
      const insertWriteMs = insertWriteCompletionTime - insertWriteStart;

      isoDb2.close();
      await isoDB.close();

      const seenInserts = insertReadRows.filter((r) => r.key > ISO_RECORDS).map((r) => r.key);
      if (seenInserts.length === 0) {
        check(insertReadRows.length === ISO_RECORDS, `snapshot isolation insert: read returned only the ${ISO_RECORDS} pre-existing records, got ${insertReadRows.length}`);
      } else {
        check(seenInserts.every((k, idx) => k === ISO_RECORDS + 1 + idx), 'snapshot isolation insert: contiguous prefix included with no holes');
      }
      check(new Set(insertReadRows.map((r) => r.key)).size === insertReadRows.length, 'snapshot isolation insert: returned keys are unique');
      check(insertWriteCompletedBeforeRead === false, 'snapshot isolation insert: write did NOT complete before read completed');

      const isolationReport = {
        deleteVariant: {
          readMs: deleteReadMs,
          writeMs: deleteWriteMs,
          writeBlocked: deleteWriteCompletedBeforeRead === false,
          deletedKeySeen: deleteReadRows.some((r) => r.key === targetDeleteKey),
          rowCount: deleteReadRows.length,
        },
        insertVariant: {
          readMs: insertReadMs,
          writeMs: insertWriteMs,
          writeBlocked: insertWriteCompletedBeforeRead === false,
          seenInsertsCount: seenInserts.length,
          allUnique: new Set(insertReadRows.map((r) => r.key)).size === insertReadRows.length,
        },
      };

      // =========================================================================================
      // 10. BATCH / REGRESSION
      // query(v, {}), {limit}, queryCandidates(v, {}) unchanged by bead;
      // empty store returns [] with recordsRead === 0 for both cursor and paged.
      // =========================================================================================
      const regDbName = `regression-${crypto.randomUUID()}`;
      databasesToClean.push(regDbName);
      const regDB = new VectorDB({ dbName: regDbName, vectorPath: 'embedding' });
      for (let i = 1; i <= 20; i++) {
        await regDB.insert({ id: i, embedding: makeVector(32) });
      }
      const regQ = makeVector(32);

      const qDefault = await regDB.query(regQ);
      const qEmptyObj = await regDB.query(regQ, {});
      const qLimit10 = await regDB.query(regQ, { limit: 10 });
      assertParity(qDefault, qEmptyObj, 'query(v) vs query(v, {}) parity');
      assertParity(qDefault, qLimit10, 'query(v) vs query(v, {limit: 10}) parity');

      const qcDefault = await regDB.queryCandidates(regQ);
      const qcEmptyObj = await regDB.queryCandidates(regQ, {});
      assertParity(qcDefault.results, qcEmptyObj.results, 'queryCandidates(v) vs queryCandidates(v, {}) parity');
      check(qcEmptyObj.info.recordsRead === 20, 'queryCandidates({}) recordsRead is 20');
      check(qcEmptyObj.info.recordsScored === 20, 'queryCandidates({}) recordsScored is 20');
      check(qcEmptyObj.info.readMode === 'cursor', 'candidate options {} readMode is cursor');
      check(qcEmptyObj.info.pageSize === null, 'candidate options {} pageSize is null');

      // Empty store
      const emptyDbName = `empty-store-${crypto.randomUUID()}`;
      databasesToClean.push(emptyDbName);
      const emptyDB = new VectorDB({ dbName: emptyDbName, vectorPath: 'embedding' });

      const emptyCursorQuery = await emptyDB.query(regQ);
      check(emptyCursorQuery.length === 0, 'empty store query() returns []');

      const emptyPagedQuery = await emptyDB.query(regQ, { pageSize: 5 });
      check(emptyPagedQuery.length === 0, 'empty store query({pageSize}) returns []');

      const emptyCursorCand = await emptyDB.queryCandidates(regQ);
      check(emptyCursorCand.results.length === 0, 'empty store queryCandidates() returns 0 results');
      check(emptyCursorCand.info.recordsRead === 0, 'empty store cursor recordsRead is 0');
      check(emptyCursorCand.info.recordsScored === 0, 'empty store cursor recordsScored is 0');

      const emptyPagedCand = await emptyDB.queryCandidates(regQ, { pageSize: 5 });
      check(emptyPagedCand.results.length === 0, 'empty store queryCandidates({pageSize}) returns 0 results');
      check(emptyPagedCand.info.recordsRead === 0, 'empty store paged recordsRead is 0');
      check(emptyPagedCand.info.recordsScored === 0, 'empty store paged recordsScored is 0');

      // =========================================================================================
      // 11. PAGESIZE WITH DELETED RECORDS AND GAPS
      // pageSize must not change results when corpus contains deleted records and gaps.
      // =========================================================================================
      const gapsDbName = `gaps-corpus-${crypto.randomUUID()}`;
      databasesToClean.push(gapsDbName);
      const gapsRaw = await openRaw(gapsDbName, 1, (e) => {
        e.target.result.createObjectStore('vectors', { autoIncrement: true });
      });
      const gapsTx = gapsRaw.transaction('vectors', 'readwrite');
      const gapsSt = gapsTx.objectStore('vectors');
      const gapsVectors = Array.from({ length: 80 }, () => makeVector(32));
      for (let i = 1; i <= 80; i++) {
        gapsSt.add({ id: i, embedding: gapsVectors[i - 1] });
      }
      await txComplete(gapsTx);

      // Delete a scattered subset of records to create holes/gaps
      const deletedKeys = [3, 7, 12, 13, 25, 34, 42, 50, 51, 63, 68, 79];
      const delTx = gapsRaw.transaction('vectors', 'readwrite');
      const delSt = delTx.objectStore('vectors');
      for (const dk of deletedKeys) {
        delSt.delete(dk);
      }
      await txComplete(delTx);
      gapsRaw.close();

      const gapsDB = new VectorDB({ dbName: gapsDbName, vectorPath: 'embedding' });
      const gapsQ = makeVector(32);
      const gapsCursor = await gapsDB.query(gapsQ, { limit: 40 });
      check(gapsCursor.length === 40, 'cursor retrieved 40 records over store with gaps');
      for (const dk of deletedKeys) {
        check(!gapsCursor.some((r) => r.key === dk), `cursor excluded deleted key ${dk}`);
      }

      const gapsPageSizes = [1, 2, 4, 7, 13, 50, 100];
      for (const ps of gapsPageSizes) {
        const gapsPaged = await gapsDB.query(gapsQ, { limit: 40, pageSize: ps });
        assertParity(gapsCursor, gapsPaged, `gaps corpus pageSize ${ps} top-40`);
      }

      // =========================================================================================
      // 12, 13, 14. MEASUREMENT (only behind --measure)
      // Three implementations timed on the SAME corpus:
      // (a) REFERENCE counter-factual: faithful copy of pre-bead cosineSimilarity (recomputes norm)
      // (b) library cursor: query(v, {limit: 10})
      // (c) library paged: query(v, {limit: 10, pageSize: 1000})
      // 128 dimensions at 1,000 / 10,000 / 100,000 records.
      // 3 repetitions per size with method order rotated per repetition.
      // Peak JS heap sampled via performance.memory.usedJSHeapSize.
      // =========================================================================================
      let measurements = null;

      if (measure) {
        // Faithful verbatim copy of the pre-bead cosineSimilarity
        // (recomputed aMagnitude for every record scored).
        // CLEARLY LABELLED AS A REFERENCE COPY, NOT THE LIBRARY.
        function counterFactualCosineSimilarity(a, b) {
          const dotProduct = a.reduce((sum, aVal, idx) => sum + aVal * b[idx], 0);
          const aMagnitude = Math.sqrt(a.reduce((sum, aVal) => sum + aVal * aVal, 0));
          const bMagnitude = Math.sqrt(b.reduce((sum, bVal) => sum + bVal * bVal, 0));
          return dotProduct / (aMagnitude * bMagnitude);
        }

        async function counterFactualCursorQuery(rawDb, storeName, vectorPath, queryVector, limit = 10) {
          const transaction = rawDb.transaction([storeName], 'readonly');
          const store = transaction.objectStore(storeName);
          const request = store.openCursor();
          const queryVectorLength = queryVector.length;
          const similarities = new SortedArray(limit, 'similarity');

          return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
              const cursor = event.target.result;
              if (cursor === null) {
                resolve(similarities.slice(0, limit));
                return;
              }
              const key = cursor.key;
              const record = cursor.value;
              if (!record || typeof record !== 'object' || Array.isArray(record) || Object.hasOwn(record, vectorPath) === false) {
                cursor.continue();
                return;
              }
              const vector = record[vectorPath];
              if (!Array.isArray(vector) || vector.length !== queryVectorLength) {
                reject(new TypeError(`invalid vector length for key ${JSON.stringify(key)}`));
                return;
              }
              const similarity = counterFactualCosineSimilarity(queryVector, vector);
              if (!Number.isFinite(similarity)) {
                reject(new TypeError(`non-finite similarity for key ${JSON.stringify(key)}`));
                return;
              }
              similarities.insert({ object: record, key, similarity });
              cursor.continue();
            };
            request.onerror = (event) => reject(event.target.error);
          });
        }

        const sampleHeap = () => {
          if (typeof performance !== 'undefined' && performance.memory && typeof performance.memory.usedJSHeapSize === 'number') {
            return performance.memory.usedJSHeapSize;
          }
          return null;
        };

        let peakHeap = null;
        const recordHeapSample = () => {
          const h = sampleHeap();
          if (h !== null) {
            peakHeap = peakHeap === null ? h : Math.max(peakHeap, h);
          }
        };

        const median = (values) => {
          const sorted = [...values].sort((a, b) => a - b);
          const mid = Math.floor(sorted.length / 2);
          return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
        };

        const DIM = 128;
        const measurePRNG = makePRNG(987654321);
        const makeMeasureVector = () => {
          const v = [];
          let sumSq = 0;
          for (let i = 0; i < DIM; i++) {
            const x = measurePRNG() * 2 - 1;
            v.push(x);
            sumSq += x * x;
          }
          const norm = Math.sqrt(sumSq) || 1;
          return v.map((x) => x / norm);
        };

        const measureDbName = `benchmark-128d-${crypto.randomUUID()}`;
        databasesToClean.push(measureDbName);
        const measureRaw = await openRaw(measureDbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { autoIncrement: true });
        });

        const measureVDB = new VectorDB({ dbName: measureDbName, vectorPath: 'embedding' });
        const queryVector128 = makeMeasureVector();

        const appendBatch = async (startIdx, count) => {
          const BATCH = 5000;
          for (let b = 0; b < count; b += BATCH) {
            const batchSize = Math.min(BATCH, count - b);
            const tx = measureRaw.transaction('vectors', 'readwrite');
            const st = tx.objectStore('vectors');
            for (let i = 0; i < batchSize; i++) {
              st.add({ id: startIdx + b + i + 1, embedding: makeMeasureVector() });
            }
            await txComplete(tx);
          }
        };

        const sizes = [1000, 10000, 100000];
        let currentRecordCount = 0;
        const sizeResults = {};

        for (const targetCount of sizes) {
          const recordsToAdd = targetCount - currentRecordCount;
          await appendBatch(currentRecordCount, recordsToAdd);
          currentRecordCount = targetCount;

          const refTimes = [];
          const cursorTimes = [];
          const pagedTimes = [];
          let allParityPass = true;

          // 3 repetitions with method order rotated per repetition
          const REPETITIONS = 3;
          for (let rep = 0; rep < REPETITIONS; rep++) {
            // Method rotation order:
            // rep 0: ref, cursor, paged
            // rep 1: cursor, paged, ref
            // rep 2: paged, ref, cursor
            const order = rep === 0
              ? ['ref', 'cursor', 'paged']
              : rep === 1
                ? ['cursor', 'paged', 'ref']
                : ['paged', 'ref', 'cursor'];

            let repRefResult = null;
            let repCursorResult = null;
            let repPagedResult = null;

            for (const method of order) {
              recordHeapSample();
              if (method === 'ref') {
                const t0 = performance.now();
                repRefResult = await counterFactualCursorQuery(measureRaw, 'vectors', 'embedding', queryVector128, 10);
                const t1 = performance.now();
                refTimes.push(t1 - t0);
              } else if (method === 'cursor') {
                const t0 = performance.now();
                repCursorResult = await measureVDB.query(queryVector128, { limit: 10 });
                const t1 = performance.now();
                cursorTimes.push(t1 - t0);
              } else if (method === 'paged') {
                const t0 = performance.now();
                repPagedResult = await measureVDB.query(queryVector128, { limit: 10, pageSize: 1000 });
                const t1 = performance.now();
                pagedTimes.push(t1 - t0);
              }
              recordHeapSample();
            }

            // Assert bit-identical parity and key parity across all three
            const parityRefVsCursor = keysMatch(repRefResult, repCursorResult) &&
              scoreBytes(repRefResult) === scoreBytes(repCursorResult);
            const parityCursorVsPaged = keysMatch(repCursorResult, repPagedResult) &&
              scoreBytes(repCursorResult) === scoreBytes(repPagedResult);

            if (!parityRefVsCursor || !parityCursorVsPaged) {
              allParityPass = false;
              throw new Error(`measurement parity failed at size ${targetCount}, rep ${rep}: ref/cursor/paged results differed`);
            }
          }

          sizeResults[targetCount] = {
            records: targetCount,
            refTimes,
            cursorTimes,
            pagedTimes,
            refMedian: median(refTimes),
            refMin: Math.min(...refTimes),
            refMax: Math.max(...refTimes),
            cursorMedian: median(cursorTimes),
            cursorMin: Math.min(...cursorTimes),
            cursorMax: Math.max(...cursorTimes),
            pagedMedian: median(pagedTimes),
            pagedMin: Math.min(...pagedTimes),
            pagedMax: Math.max(...pagedTimes),
            parity: allParityPass,
          };
        }

        measureRaw.close();
        await measureVDB.close();

        measurements = {
          commit,
          browser: navigator.userAgent,
          dimensions: DIM,
          recordCounts: sizes,
          repetitions: 3,
          sizes: sizeResults,
          peakHeapBytes: peakHeap,
          heapDescription: peakHeap !== null
            ? 'sampled performance.memory.usedJSHeapSize before and after each timed run (page JS heap, not process RSS)'
            : 'performance.memory.usedJSHeapSize unavailable in this browser environment',
          limitations: 'All three implementations timed on the SAME corpus in the SAME browser session with 128-dimensional vectors. Order of execution rotated across 3 repetitions per corpus size. JIT warm-up, garbage collection, and OS background tasks affect individual times; median with min/max reported. One machine, not an external benchmark.',
        };
      }

      return {
        checks: checks.length,
        refusals,
        isolation: isolationReport,
        measurements,
      };
    } finally {
      for (const name of databasesToClean) {
        try {
          indexedDB.deleteDatabase(name);
        } catch {}
      }
    }
  }, process.argv.includes('--measure'), gitCommit);

  assert.ok(result.checks >= 100, `expected full test battery, ran ${result.checks} checks`);

  console.log(`PASS: ${result.checks} paged-scan checks in a real browser`);

  if (result.measurements === null) {
    console.log('Timing measurement skipped: pass --measure to run 1k/10k/100k benchmarks.');
  } else {
    if (process.env.IDB_VECTOR_PAGED_REPORT) {
      await writeFile(
        process.env.IDB_VECTOR_PAGED_REPORT,
        JSON.stringify(result.measurements, null, 2),
        'utf8',
      );
    }

    const m = result.measurements;
    console.log(`Measurements (${m.dimensions} dimensions, ${m.repetitions} rotated repetitions, commit ${m.commit}):`);
    for (const size of m.recordCounts) {
      const s = m.sizes[size];
      console.log(`  Corpus size: ${size} records (parity: ${s.parity ? 'MATCH' : 'FAIL'}):`);
      console.log(`    (a) Reference pre-bead cursor: median ${s.refMedian.toFixed(1)} ms (range [${s.refMin.toFixed(1)}, ${s.refMax.toFixed(1)}] ms)`);
      console.log(`    (b) Library cursor (query):     median ${s.cursorMedian.toFixed(1)} ms (range [${s.cursorMin.toFixed(1)}, ${s.cursorMax.toFixed(1)}] ms)`);
      console.log(`    (c) Library paged (page 1000):  median ${s.pagedMedian.toFixed(1)} ms (range [${s.pagedMin.toFixed(1)}, ${s.pagedMax.toFixed(1)}] ms)`);
    }
    const peakHeapMB = m.peakHeapBytes !== null ? `${(m.peakHeapBytes / (1024 * 1024)).toFixed(2)} MB` : 'null';
    console.log(`  Peak JS heap: ${peakHeapMB} (${m.heapDescription})`);
    console.log(`  ${m.limitations}`);
  }

  console.log('Snapshot isolation timings:');
  console.log(`  Delete test: read ${result.isolation.deleteVariant.readMs.toFixed(1)} ms, write ${result.isolation.deleteVariant.writeMs.toFixed(1)} ms (write blocked: ${result.isolation.deleteVariant.writeBlocked})`);
  console.log(`  Insert test: read ${result.isolation.insertVariant.readMs.toFixed(1)} ms, write ${result.isolation.insertVariant.writeMs.toFixed(1)} ms (write blocked: ${result.isolation.insertVariant.writeBlocked})`);

  console.log('Sample refusals:');
  for (const [label, msg] of Object.entries(result.refusals).slice(0, 5)) {
    console.log(`  ${label} -> ${msg}`);
  }
} finally {
  await page?.close();
  await new Promise((resolve) => server.close(resolve));
}
