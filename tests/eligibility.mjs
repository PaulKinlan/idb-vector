// tests/eligibility.mjs — eligibility before top-k and honest eligibility/recall disclosure
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

    const getAllRaw = (name, storeName = 'vectors') => new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const getReq = store.getAll();
        getReq.onsuccess = () => {
          db.close();
          resolve(getReq.result);
        };
        getReq.onerror = () => {
          db.close();
          reject(getReq.error);
        };
      };
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

    const cosineSimilarity = (a, b) => {
      const dotProduct = a.reduce((sum, aVal, idx) => sum + aVal * b[idx], 0);
      const aMagnitude = Math.sqrt(a.reduce((sum, aVal) => sum + aVal * aVal, 0));
      const bMagnitude = Math.sqrt(b.reduce((sum, bVal) => sum + bVal * bVal, 0));
      return dotProduct / (aMagnitude * bMagnitude);
    };

    // In-page oracle from full scan + plain JS filter and stable sort
    const makeOracle = (corpus, queryVec, { threshold = null, predicate = null, indexFilter = null, limit = 10 } = {}) => {
      let recordsRead = 0;
      let recordsScored = 0;
      const scored = [];
      for (const r of corpus) {
        if (indexFilter && !indexFilter(r)) continue;
        recordsRead++;
        if (!r || !r.embedding) continue;
        if (predicate && !predicate(r)) continue;
        const sim = cosineSimilarity(queryVec, r.embedding);
        if (threshold !== null && sim < threshold) continue;
        recordsScored++;
        scored.push({ object: r, key: r.id, similarity: sim });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return {
        recordsRead,
        recordsScored,
        results: scored.slice(0, limit),
      };
    };

    const databasesToClean = [];
    const dbInstances = [];

    // =========================================================================================
    // 1. Threshold correctness at 1% / 10% / 100% eligibility, uniform & correlated distributions,
    //    inclusive boundary, and limit grid (Req 1, 2, 3)
    // =========================================================================================

    // --- 1A. Uniform random vector distribution (100 records) --------------------------------
    const uniformDbName = `eligibility-uniform-${crypto.randomUUID()}`;
    databasesToClean.push(uniformDbName);
    const uniformRaw = await openRaw(uniformDbName, 1, (e) => {
      e.target.result.createObjectStore('vectors', { keyPath: 'id' });
    });
    const uniformCorpus = [];
    for (let i = 1; i <= 100; i++) {
      uniformCorpus.push({ id: i, value: i, embedding: makeVector(32) });
    }
    const uniformTx = uniformRaw.transaction('vectors', 'readwrite');
    const uniformStore = uniformTx.objectStore('vectors');
    for (const r of uniformCorpus) uniformStore.add(r);
    await txComplete(uniformTx);
    uniformRaw.close();

    const uniformDB = new VectorDB({ dbName: uniformDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(uniformDB);

    const qUniform = makeVector(32);
    const uniformAllScored = uniformCorpus.map((r) => ({
      object: r,
      key: r.id,
      similarity: cosineSimilarity(qUniform, r.embedding),
    }));
    uniformAllScored.sort((a, b) => b.similarity - a.similarity);

    // (a) 100% eligibility: threshold -1.0 keeps all 100 records
    const oracleU100 = makeOracle(uniformCorpus, qUniform, { threshold: -1.0, limit: 15 });
    check(oracleU100.recordsScored === 100, 'oracle 100% scores all 100 records');
    const candU100 = await uniformDB.queryCandidates(qUniform, { threshold: -1.0, limit: 15 });
    check(candU100.info.recordsRead === 100, 'cand 100% uniform recordsRead is 100');
    check(candU100.info.recordsScored === 100, 'cand 100% uniform recordsScored is 100');
    check(candU100.info.threshold === -1.0, 'cand 100% uniform info.threshold is -1.0');
    check(candU100.info.limit === 15, 'cand 100% uniform info.limit is 15');
    check(candU100.info.mode === 'full-scan', 'cand 100% uniform mode is full-scan');
    check(candU100.info.fullScanRequired === true, 'cand 100% uniform fullScanRequired is true');
    check(candU100.results.length === 15, 'cand 100% uniform returns 15 results');
    check(keysMatch(candU100.results, oracleU100.results), 'cand 100% uniform keys match oracle');
    check(bits(candU100.results) === bits(oracleU100.results), 'cand 100% uniform scores bit-identical to oracle');
    for (let i = 1; i < candU100.results.length; i++) {
      check(candU100.results[i - 1].similarity >= candU100.results[i].similarity, `cand 100% uniform scores non-increasing: index ${i}`);
    }
    const queryU100 = await uniformDB.query(qUniform, { threshold: -1.0, limit: 15 });
    check(keysMatch(candU100.results, queryU100), 'query() and queryCandidates() key match at 100% uniform');
    check(bits(candU100.results) === bits(queryU100), 'query() and queryCandidates() bit match at 100% uniform');

    // (b) 10% eligibility: threshold derived from 10th score
    const thresholdU10 = uniformAllScored[9].similarity;
    const oracleU10Small = makeOracle(uniformCorpus, qUniform, { threshold: thresholdU10, limit: 5 });
    check(oracleU10Small.recordsScored === 10, 'oracle 10% uniform has exactly 10 eligible records');
    const candU10Small = await uniformDB.queryCandidates(qUniform, { threshold: thresholdU10, limit: 5 });
    check(candU10Small.info.recordsRead === 100, 'cand 10% uniform small limit recordsRead is 100');
    check(candU10Small.info.recordsScored === 10, 'cand 10% uniform small limit recordsScored is 10');
    check(candU10Small.results.length === 5, 'cand 10% uniform small limit returns 5 results (min(5, 10))');
    check(keysMatch(candU10Small.results, oracleU10Small.results), 'cand 10% uniform small limit keys match oracle');
    check(bits(candU10Small.results) === bits(oracleU10Small.results), 'cand 10% uniform small limit scores bit-identical');
    for (let i = 0; i < candU10Small.results.length; i++) {
      check(candU10Small.results[i].similarity >= thresholdU10, `cand 10% uniform small result ${i} >= threshold`);
      if (i > 0) {
        check(candU10Small.results[i - 1].similarity >= candU10Small.results[i].similarity, `cand 10% uniform small non-increasing ${i}`);
      }
    }

    // Limit large (limit 25 > recordsScored 10): must not truncate below eligible count
    const oracleU10Large = makeOracle(uniformCorpus, qUniform, { threshold: thresholdU10, limit: 25 });
    const candU10Large = await uniformDB.queryCandidates(qUniform, { threshold: thresholdU10, limit: 25 });
    check(candU10Large.info.recordsScored === 10, 'cand 10% uniform large limit recordsScored is 10');
    check(candU10Large.results.length === 10, 'cand 10% uniform large limit returns all 10 records (min(25, 10))');
    check(keysMatch(candU10Large.results, oracleU10Large.results), 'cand 10% uniform large limit keys match oracle');
    check(bits(candU10Large.results) === bits(oracleU10Large.results), 'cand 10% uniform large limit scores bit-identical');
    for (let i = 0; i < candU10Large.results.length; i++) {
      check(candU10Large.results[i].similarity >= thresholdU10, `cand 10% uniform large result ${i} >= threshold`);
    }

    // (c) 1% eligibility: threshold derived from 1st score (top 1%)
    const thresholdU1 = uniformAllScored[0].similarity;
    const oracleU1 = makeOracle(uniformCorpus, qUniform, { threshold: thresholdU1, limit: 10 });
    check(oracleU1.recordsScored === 1, 'oracle 1% uniform has exactly 1 eligible record');
    const candU1 = await uniformDB.queryCandidates(qUniform, { threshold: thresholdU1, limit: 10 });
    check(candU1.info.recordsRead === 100, 'cand 1% uniform recordsRead is 100');
    check(candU1.info.recordsScored === 1, 'cand 1% uniform recordsScored is 1');
    check(candU1.results.length === 1, 'cand 1% uniform returns 1 result');
    check(keysMatch(candU1.results, oracleU1.results), 'cand 1% uniform key matches oracle');
    check(candU1.results[0].similarity >= thresholdU1, 'cand 1% uniform result similarity >= threshold');
    const queryU1 = await uniformDB.query(qUniform, { threshold: thresholdU1, limit: 10 });
    check(keysMatch(candU1.results, queryU1), 'query() and queryCandidates() match at 1% uniform');

    // --- 1B. Correlated score distribution (100 records) -------------------------------------
    // Vectors along a circular arc: similarity monotonically decreases with record index i
    const corrDbName = `eligibility-corr-${crypto.randomUUID()}`;
    databasesToClean.push(corrDbName);
    const corrRaw = await openRaw(corrDbName, 1, (e) => {
      e.target.result.createObjectStore('vectors', { keyPath: 'id' });
    });
    const corrCorpus = [];
    for (let i = 0; i < 100; i++) {
      const theta = (i / 100) * Math.PI;
      const v = new Array(32).fill(0);
      v[0] = Math.cos(theta);
      v[1] = Math.sin(theta);
      corrCorpus.push({ id: i + 1, index: i, embedding: v });
    }
    const corrTx = corrRaw.transaction('vectors', 'readwrite');
    const corrStore = corrTx.objectStore('vectors');
    for (const r of corrCorpus) corrStore.add(r);
    await txComplete(corrTx);
    corrRaw.close();

    const corrDB = new VectorDB({ dbName: corrDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(corrDB);

    const qCorr = new Array(32).fill(0);
    qCorr[0] = 1; // query vector along x-axis; cosine sim to v_i is exactly cos(theta_i)

    const corrAllScored = corrCorpus.map((r) => ({
      object: r,
      key: r.id,
      similarity: cosineSimilarity(qCorr, r.embedding),
    }));
    corrAllScored.sort((a, b) => b.similarity - a.similarity);

    // Correlated 100% eligibility
    const oracleC100 = makeOracle(corrCorpus, qCorr, { threshold: -1.0, limit: 20 });
    check(oracleC100.recordsScored === 100, 'oracle correlated 100% scores 100 records');
    const candC100 = await corrDB.queryCandidates(qCorr, { threshold: -1.0, limit: 20 });
    check(candC100.info.recordsScored === 100, 'cand correlated 100% recordsScored is 100');
    check(candC100.results.length === 20, 'cand correlated 100% returns 20 results');
    check(keysMatch(candC100.results, oracleC100.results), 'cand correlated 100% keys match oracle');
    check(bits(candC100.results) === bits(oracleC100.results), 'cand correlated 100% scores bit-identical');

    // Correlated 10% eligibility
    const thresholdC10 = corrAllScored[9].similarity;
    const oracleC10 = makeOracle(corrCorpus, qCorr, { threshold: thresholdC10, limit: 10 });
    check(oracleC10.recordsScored === 10, 'oracle correlated 10% scores exactly 10');
    const candC10 = await corrDB.queryCandidates(qCorr, { threshold: thresholdC10, limit: 10 });
    check(candC10.info.recordsScored === 10, 'cand correlated 10% recordsScored is 10');
    check(candC10.results.length === 10, 'cand correlated 10% returns 10 results');
    check(keysMatch(candC10.results, oracleC10.results), 'cand correlated 10% keys match oracle');
    check(bits(candC10.results) === bits(oracleC10.results), 'cand correlated 10% scores bit-identical');

    // Correlated 1% eligibility
    const thresholdC1 = corrAllScored[0].similarity;
    const oracleC1 = makeOracle(corrCorpus, qCorr, { threshold: thresholdC1, limit: 5 });
    check(oracleC1.recordsScored === 1, 'oracle correlated 1% scores exactly 1');
    const candC1 = await corrDB.queryCandidates(qCorr, { threshold: thresholdC1, limit: 5 });
    check(candC1.info.recordsScored === 1, 'cand correlated 1% recordsScored is 1');
    check(candC1.results.length === 1, 'cand correlated 1% returns 1 result');
    check(keysMatch(candC1.results, oracleC1.results), 'cand correlated 1% keys match oracle');

    // --- 1C. Inclusive boundary check (Req 2) ------------------------------------------------
    // Derive threshold directly from oracle's own score for chosen record 25 (0-indexed)
    const chosenRecord = corrAllScored[25];
    const derivedThreshold = chosenRecord.similarity;
    const neighborAbove = corrAllScored[24];
    const neighborBelow = corrAllScored[26];

    check(neighborAbove.similarity > derivedThreshold, 'neighbor above has strictly greater similarity than chosen record');
    check(neighborBelow.similarity < derivedThreshold, 'neighbor below has strictly lesser similarity than chosen record');

    const boundaryCand = await corrDB.queryCandidates(qCorr, { threshold: derivedThreshold, limit: 100 });
    check(boundaryCand.info.recordsScored === 26, `boundary cand scored exactly 26 records (0..25), got ${boundaryCand.info.recordsScored}`);
    check(boundaryCand.results.length === 26, 'boundary cand returned 26 records');
    check(boundaryCand.results.some((r) => r.key === chosenRecord.key), 'chosen record with similarity === threshold IS included');
    const chosenResult = boundaryCand.results.find((r) => r.key === chosenRecord.key);
    check(chosenResult.similarity === derivedThreshold, 'chosen record similarity exactly equals derived threshold');
    check(boundaryCand.results.some((r) => r.key === neighborAbove.key), 'neighbor above (similarity > threshold) IS included');
    check(!boundaryCand.results.some((r) => r.key === neighborBelow.key), 'neighbor below (similarity < threshold) is NOT included');
    check(boundaryCand.results.every((r) => r.similarity >= derivedThreshold), 'every returned record has similarity >= derived threshold');
    check(!boundaryCand.results.some((r) => r.similarity < derivedThreshold), 'no record with similarity < threshold is returned');

    // Same boundary check with query()
    const boundaryQuery = await corrDB.query(qCorr, { threshold: derivedThreshold, limit: 100 });
    check(keysMatch(boundaryCand.results, boundaryQuery), 'query() matches queryCandidates() on inclusive boundary');
    check(bits(boundaryCand.results) === bits(boundaryQuery), 'query() bit-identical on inclusive boundary');

    // --- 1D. Truncation and limit behavior grid (Req 3) --------------------------------------
    // Dataset with exactly 12 records meeting threshold
    const targetEligibleCount = 12;
    const gridThreshold = corrAllScored[targetEligibleCount - 1].similarity;
    const testLimits = [1, 3, 6, 11, 12, 13, 20, 50];

    for (const lim of testLimits) {
      const gridCand = await corrDB.queryCandidates(qCorr, { threshold: gridThreshold, limit: lim });
      const expectedLen = Math.min(lim, targetEligibleCount);
      check(gridCand.info.recordsScored === targetEligibleCount, `limit grid ${lim}: recordsScored is ${targetEligibleCount}`);
      check(gridCand.results.length === expectedLen, `limit grid ${lim}: results.length === min(${lim}, ${targetEligibleCount}) === ${expectedLen}`);
      if (lim < targetEligibleCount) {
        check(gridCand.results.length === lim, `limit grid ${lim}: eligible set is NOT truncated below limit ${lim}`);
      } else {
        check(gridCand.results.length === targetEligibleCount, `limit grid ${lim}: all ${targetEligibleCount} eligible records returned`);
      }
      for (let i = 1; i < gridCand.results.length; i++) {
        check(gridCand.results[i - 1].similarity >= gridCand.results[i].similarity, `limit grid ${lim}: non-increasing order at ${i}`);
      }
    }

    // =========================================================================================
    // 2. Empty eligibility vs no candidates disclosure (Req 4)
    // =========================================================================================
    const emptyDbName = `eligibility-empty-${crypto.randomUUID()}`;
    databasesToClean.push(emptyDbName);
    const emptyRaw = await openRaw(emptyDbName, 1, (e) => {
      const s = e.target.result.createObjectStore('vectors', { keyPath: 'id' });
      s.createIndex('category', 'category');
    });
    const emptyCorpus = [];
    for (let i = 1; i <= 30; i++) {
      emptyCorpus.push({ id: i, category: i <= 15 ? 'catA' : 'catB', embedding: makeVector(32) });
    }
    const emptyTx = emptyRaw.transaction('vectors', 'readwrite');
    const emptyStore = emptyTx.objectStore('vectors');
    for (const r of emptyCorpus) emptyStore.add(r);
    await txComplete(emptyTx);
    emptyRaw.close();

    const emptyDB = new VectorDB({ dbName: emptyDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(emptyDB);
    const qEmpty = makeVector(32);

    // (a) predicate: () => false reads all records but scores 0
    const falsePredQ = await emptyDB.queryCandidates(qEmpty, { predicate: () => false, limit: 10 });
    check(falsePredQ.info.mode === 'full-scan', 'false predicate mode is "full-scan"');
    check(falsePredQ.info.recordsRead === 30, `false predicate recordsRead is 30, got ${falsePredQ.info.recordsRead}`);
    check(falsePredQ.info.recordsScored === 0, `false predicate recordsScored is 0, got ${falsePredQ.info.recordsScored}`);
    check(falsePredQ.info.predicate === true, 'false predicate info.predicate is true');
    check(falsePredQ.info.fullScanRequired === true, 'false predicate fullScanRequired is true');
    check(falsePredQ.info.reason === 'predicate without an index or key range: every record in the store is read', 'false predicate reason matches');
    check(Array.isArray(falsePredQ.results) && falsePredQ.results.length === 0, 'false predicate results is empty array');

    // (b) store key range that matches nothing reads 0 and scores 0
    const emptyStoreRangeQ = await emptyDB.queryCandidates(qEmpty, { range: IDBKeyRange.only(999999), limit: 10 });
    check(emptyStoreRangeQ.info.mode === 'store-range', 'empty store range mode is "store-range"');
    check(emptyStoreRangeQ.info.recordsRead === 0, `empty store range recordsRead is 0, got ${emptyStoreRangeQ.info.recordsRead}`);
    check(emptyStoreRangeQ.info.recordsScored === 0, `empty store range recordsScored is 0, got ${emptyStoreRangeQ.info.recordsScored}`);
    check(emptyStoreRangeQ.info.predicate === false, 'empty store range info.predicate is false');
    check(emptyStoreRangeQ.info.range.lower === 999999, 'empty store range lower is 999999');
    check(emptyStoreRangeQ.info.range.upper === 999999, 'empty store range upper is 999999');
    check(emptyStoreRangeQ.info.range.lowerOpen === false, 'empty store range lowerOpen is false');
    check(emptyStoreRangeQ.info.range.upperOpen === false, 'empty store range upperOpen is false');
    check(emptyStoreRangeQ.info.fullScanRequired === false, 'empty store range fullScanRequired is false');
    check(emptyStoreRangeQ.info.reason === null, 'empty store range reason is null');
    check(Array.isArray(emptyStoreRangeQ.results) && emptyStoreRangeQ.results.length === 0, 'empty store range results is empty array');

    // (b2) store key range with open bounds: checks disclosure range shape {lower, upper, lowerOpen, upperOpen}
    const openBoundRangeQ = await emptyDB.queryCandidates(qEmpty, {
      range: IDBKeyRange.bound(5, 15, true, false), // (5, 15]: keys 6..15 (10 records)
      limit: 20,
    });
    check(openBoundRangeQ.info.mode === 'store-range', 'openBoundRange mode is "store-range"');
    check(openBoundRangeQ.info.range.lower === 5, 'openBoundRange lower is 5');
    check(openBoundRangeQ.info.range.upper === 15, 'openBoundRange upper is 15');
    check(openBoundRangeQ.info.range.lowerOpen === true, 'openBoundRange lowerOpen is true');
    check(openBoundRangeQ.info.range.upperOpen === false, 'openBoundRange upperOpen is false');
    check(openBoundRangeQ.info.recordsRead === 10, `openBoundRange read exactly 10 records (keys 6..15), got ${openBoundRangeQ.info.recordsRead}`);
    check(openBoundRangeQ.results.length === 10, 'openBoundRange returned 10 records');
    check(!openBoundRangeQ.results.some((r) => r.key === 5), 'key 5 excluded because lowerOpen is true');
    check(openBoundRangeQ.results.some((r) => r.key === 15), 'key 15 included because upperOpen is false');

    // (c) index range that matches nothing reads 0 and scores 0
    const emptyIndexRangeQ = await emptyDB.queryCandidates(qEmpty, { index: 'category', range: IDBKeyRange.only('catNonexistent'), limit: 10 });
    check(emptyIndexRangeQ.info.mode === 'index', 'empty index range mode is "index"');
    check(emptyIndexRangeQ.info.recordsRead === 0, `empty index range recordsRead is 0, got ${emptyIndexRangeQ.info.recordsRead}`);
    check(emptyIndexRangeQ.info.recordsScored === 0, `empty index range recordsScored is 0, got ${emptyIndexRangeQ.info.recordsScored}`);
    check(emptyIndexRangeQ.info.fullScanRequired === false, 'empty index range fullScanRequired is false');
    check(emptyIndexRangeQ.info.reason === null, 'empty index range reason is null');
    check(Array.isArray(emptyIndexRangeQ.results) && emptyIndexRangeQ.results.length === 0, 'empty index range results is empty array');

    // (d) threshold that matches nothing reads 30 and scores 0
    const emptyThresholdQ = await emptyDB.queryCandidates(qEmpty, { threshold: 1.0, limit: 10 });
    check(emptyThresholdQ.info.recordsRead === 30, 'empty threshold recordsRead is 30');
    check(emptyThresholdQ.info.recordsScored === 0, 'empty threshold recordsScored is 0');
    check(Array.isArray(emptyThresholdQ.results) && emptyThresholdQ.results.length === 0, 'empty threshold results is empty array');

    // Disclosure distinction: empty eligibility (read > 0, scored === 0) vs no candidates (read === 0, scored === 0)
    check(falsePredQ.info.recordsRead > 0 && falsePredQ.info.recordsScored === 0, 'empty eligibility: recordsRead > 0 and recordsScored === 0');
    check(emptyStoreRangeQ.info.recordsRead === 0 && emptyStoreRangeQ.info.recordsScored === 0, 'no candidates: recordsRead === 0 and recordsScored === 0');
    check(falsePredQ.info.recordsRead !== emptyStoreRangeQ.info.recordsRead, 'empty eligibility and no candidates are distinguishable via recordsRead');
    check(emptyThresholdQ.info.recordsRead !== emptyIndexRangeQ.info.recordsRead, 'threshold empty and index empty are distinguishable via recordsRead');

    // =========================================================================================
    // 3. Query/category mismatch: excluded record self-match (Req 5)
    // =========================================================================================
    const mismatchDbName = `eligibility-mismatch-${crypto.randomUUID()}`;
    databasesToClean.push(mismatchDbName);
    const mismatchRaw = await openRaw(mismatchDbName, 1, (e) => {
      const s = e.target.result.createObjectStore('vectors', { keyPath: 'id' });
      s.createIndex('category', 'category');
    });
    // Target record in 'special' category: vector [1, 0, 0, ...]
    const targetVector = new Array(32).fill(0);
    targetVector[0] = 1;
    const targetRecord = { id: 999, category: 'special', embedding: targetVector };

    // 20 in-domain records in 'general' category: vector [0, 1, 0, ...] orthogonal to target
    const mismatchCorpus = [targetRecord];
    for (let i = 1; i <= 20; i++) {
      const v = new Array(32).fill(0);
      v[1] = 1;
      v[2] = (i / 100);
      const norm = Math.hypot(...v);
      mismatchCorpus.push({ id: i, category: 'general', embedding: v.map((x) => x / norm) });
    }
    const mismatchTx = mismatchRaw.transaction('vectors', 'readwrite');
    const mismatchStore = mismatchTx.objectStore('vectors');
    for (const r of mismatchCorpus) mismatchStore.add(r);
    await txComplete(mismatchTx);
    mismatchRaw.close();

    const mismatchDB = new VectorDB({ dbName: mismatchDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(mismatchDB);

    // Query vector is exact self-match of excluded targetRecord: cosine similarity is 1.0
    // Candidate filter specifies category 'general' with threshold 0.5
    // All 'general' records have similarity ~0 to targetVector, so eligible set is empty!
    const filteredMismatch = await mismatchDB.queryCandidates(targetVector, {
      index: 'category',
      range: IDBKeyRange.only('general'),
      threshold: 0.5,
      limit: 5,
    });
    check(filteredMismatch.info.recordsRead === 20, 'filtered mismatch read only the 20 "general" records');
    check(filteredMismatch.info.recordsScored === 0, 'filtered mismatch scored 0 (no "general" record met threshold 0.5)');
    check(filteredMismatch.results.length === 0, 'filtered mismatch results is empty');

    // Predicate filter version
    const predMismatch = await mismatchDB.queryCandidates(targetVector, {
      predicate: (r) => r.category === 'general',
      threshold: 0.5,
      limit: 5,
    });
    check(predMismatch.info.recordsRead === 21, 'predicate mismatch read all 21 records');
    check(predMismatch.info.recordsScored === 0, 'predicate mismatch scored 0');
    check(predMismatch.results.length === 0, 'predicate mismatch results is empty');

    // Same query WITHOUT filter returns the excluded targetRecord with similarity 1.0!
    const unfilteredMismatchCand = await mismatchDB.queryCandidates(targetVector, { threshold: 0.5, limit: 5 });
    check(unfilteredMismatchCand.info.recordsScored === 1, 'unfiltered mismatch candidate scored exactly 1 record');
    check(unfilteredMismatchCand.results.length === 1, 'unfiltered mismatch candidate returned 1 record');
    check(unfilteredMismatchCand.results[0].key === 999, 'unfiltered mismatch candidate returned record 999');
    check(unfilteredMismatchCand.results[0].similarity === 1.0, 'unfiltered mismatch candidate similarity is 1.0');

    const unfilteredMismatchQuery = await mismatchDB.query(targetVector, { threshold: 0.5, limit: 5 });
    check(unfilteredMismatchQuery.length === 1, 'unfiltered mismatch query() returned 1 record');
    check(unfilteredMismatchQuery[0].key === 999, 'unfiltered mismatch query() returned record 999');
    check(unfilteredMismatchQuery[0].similarity === 1.0, 'unfiltered mismatch query() similarity is 1.0');

    // =========================================================================================
    // 4. Adversarial / correlated filter through an index (Req 6)
    // =========================================================================================
    // Index key is anti-correlated with similarity:
    // Highest-similarity records carry tier 'forbidden'; lower-similarity records carry tier 'allowed'.
    const advDbName = `eligibility-adv-${crypto.randomUUID()}`;
    databasesToClean.push(advDbName);
    const advRaw = await openRaw(advDbName, 1, (e) => {
      const s = e.target.result.createObjectStore('vectors', { keyPath: 'id' });
      s.createIndex('tier', 'tier');
    });
    const advCorpus = [];
    const qAdv = new Array(32).fill(0);
    qAdv[0] = 1;

    // 20 'forbidden' records with very high similarity (~0.99)
    for (let i = 1; i <= 20; i++) {
      const v = new Array(32).fill(0);
      v[0] = 0.999;
      v[1] = 0.001 * i;
      const norm = Math.hypot(...v);
      advCorpus.push({ id: i, tier: 'forbidden', embedding: v.map((x) => x / norm) });
    }
    // 20 'allowed' records with modest similarity (~0.35)
    for (let i = 21; i <= 40; i++) {
      const v = new Array(32).fill(0);
      v[0] = 0.35;
      v[1] = 0.5 + 0.01 * (i - 20);
      const norm = Math.hypot(...v);
      advCorpus.push({ id: i, tier: 'allowed', embedding: v.map((x) => x / norm) });
    }
    const advTx = advRaw.transaction('vectors', 'readwrite');
    const advStore = advTx.objectStore('vectors');
    for (const r of advCorpus) advStore.add(r);
    await txComplete(advTx);
    advRaw.close();

    const advDB = new VectorDB({ dbName: advDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(advDB);

    const advOracle = makeOracle(advCorpus, qAdv, {
      indexFilter: (r) => r.tier === 'allowed',
      limit: 10,
    });
    check(advOracle.recordsRead === 20, 'adv oracle read 20 "allowed" records');
    check(advOracle.recordsScored === 20, 'adv oracle scored 20 "allowed" records');

    const advResult = await advDB.queryCandidates(qAdv, {
      index: 'tier',
      range: IDBKeyRange.only('allowed'),
      limit: 10,
    });
    check(advResult.info.mode === 'index', 'adv mode is "index"');
    check(advResult.info.recordsRead === 20, 'adv recordsRead is 20');
    check(advResult.info.recordsScored === 20, 'adv recordsScored is 20');
    check(advResult.info.fullScanRequired === false, 'adv fullScanRequired is false');
    check(advResult.results.length === 10, 'adv returns 10 results');
    check(advResult.results.every((r) => r.object.tier === 'allowed'), 'every returned record has tier "allowed"');
    check(!advResult.results.some((r) => r.object.tier === 'forbidden'), 'NO record with tier "forbidden" appears in results');
    check(keysMatch(advResult.results, advOracle.results), 'adv results match eligible oracle keys');
    check(bits(advResult.results) === bits(advOracle.results), 'adv results match eligible oracle scores bit-identically');

    // Confirm that an unfiltered scan would have been 100% 'forbidden'
    const advUnfiltered = await advDB.query(qAdv, { limit: 10 });
    check(advUnfiltered.every((r) => r.object.tier === 'forbidden'), 'unfiltered query returns only "forbidden" high-similarity records');

    // =========================================================================================
    // 5. Pruned-read honesty and missing index fields (Req 7)
    // =========================================================================================
    const prunedDbName = `eligibility-pruned-${crypto.randomUUID()}`;
    databasesToClean.push(prunedDbName);
    const prunedRaw = await openRaw(prunedDbName, 1, (e) => {
      const s = e.target.result.createObjectStore('vectors', { keyPath: 'id' });
      s.createIndex('topic', 'topic');
    });

    const qPruned = new Array(32).fill(0);
    qPruned[0] = 1;

    // 10 records with topic 'tech' and visible: true (sim ~0.5)
    const prunedCorpus = [];
    for (let i = 1; i <= 10; i++) {
      const v = new Array(32).fill(0);
      v[0] = 0.5;
      v[1] = 0.5 + 0.01 * i;
      const norm = Math.hypot(...v);
      prunedCorpus.push({ id: i, topic: 'tech', visible: true, embedding: v.map((x) => x / norm) });
    }
    // 5 records WITHOUT topic property (unindexed!), visible: true, high similarity (~0.98)
    for (let i = 11; i <= 15; i++) {
      const v = new Array(32).fill(0);
      v[0] = 0.98;
      v[1] = 0.01 * (i - 10);
      const norm = Math.hypot(...v);
      prunedCorpus.push({ id: i, visible: true, embedding: v.map((x) => x / norm) }); // NO topic!
    }
    // 5 records with topic 'tech' but visible: false
    for (let i = 16; i <= 20; i++) {
      const v = new Array(32).fill(0);
      v[0] = 0.2;
      v[1] = 0.8;
      const norm = Math.hypot(...v);
      prunedCorpus.push({ id: i, topic: 'tech', visible: false, embedding: v.map((x) => x / norm) });
    }

    const prunedTx = prunedRaw.transaction('vectors', 'readwrite');
    const prunedStore = prunedTx.objectStore('vectors');
    for (const r of prunedCorpus) prunedStore.add(r);
    await txComplete(prunedTx);
    prunedRaw.close();

    const prunedDB = new VectorDB({ dbName: prunedDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(prunedDB);

    // (a) Index candidate read: visits only records with topic 'tech'; records lacking 'topic' are absent
    const indexPrunedQ = await prunedDB.queryCandidates(qPruned, {
      index: 'topic',
      range: IDBKeyRange.only('tech'),
      predicate: (r) => r.visible === true,
      limit: 10,
    });
    check(indexPrunedQ.info.mode === 'index', 'pruned index query mode is "index"');
    check(indexPrunedQ.info.fullScanRequired === false, 'fullScanRequired is false for index candidate query');
    check(indexPrunedQ.info.reason === null, 'reason is null when fullScanRequired is false');
    check(indexPrunedQ.info.recordsRead === 15, `index read only the 15 'tech' records, got ${indexPrunedQ.info.recordsRead}`);
    check(indexPrunedQ.info.recordsScored === 10, `recordsScored is 10 (visible tech records), got ${indexPrunedQ.info.recordsScored}`);
    check(indexPrunedQ.results.length === 10, 'returned 10 tech results');
    for (let unindexedId = 11; unindexedId <= 15; unindexedId++) {
      check(!indexPrunedQ.results.some((r) => r.key === unindexedId), `unindexed record ${unindexedId} is absent from index candidate query`);
    }

    // (b) Predicate without index (full scan): reads all 20 records; DOES return the unindexed records!
    const fullPrunedQ = await prunedDB.queryCandidates(qPruned, {
      predicate: (r) => r.visible === true,
      limit: 10,
    });
    check(fullPrunedQ.info.mode === 'full-scan', 'predicate-only query mode is "full-scan"');
    check(fullPrunedQ.info.fullScanRequired === true, 'fullScanRequired is true for predicate-only query');
    check(fullPrunedQ.info.reason === 'predicate without an index or key range: every record in the store is read', 'reason matches predicate-only full scan');
    check(fullPrunedQ.info.recordsRead === 20, `reads all 20 records in the store, got ${fullPrunedQ.info.recordsRead}`);
    check(fullPrunedQ.info.recordsScored === 15, `scores 15 visible records (10 tech + 5 unindexed), got ${fullPrunedQ.info.recordsScored}`);
    // The top 5 results MUST be the unindexed records (ids 11..15) because they have highest similarity (~0.98)
    for (let unindexedId = 11; unindexedId <= 15; unindexedId++) {
      check(fullPrunedQ.results.some((r) => r.key === unindexedId), `unindexed record ${unindexedId} IS returned by full scan with predicate`);
    }

    // (c) Query with neither index nor range nor predicate
    const barePrunedQ = await prunedDB.queryCandidates(qPruned, { limit: 10 });
    check(barePrunedQ.info.mode === 'full-scan', 'bare queryCandidates mode is "full-scan"');
    check(barePrunedQ.info.fullScanRequired === true, 'fullScanRequired is true when no index and no range given');
    check(barePrunedQ.info.reason === 'no index or key range: every record in the store is read', 'reason matches bare full scan');
    check(barePrunedQ.info.recordsRead === 20, 'bare queryCandidates reads all 20 records');

    // =========================================================================================
    // 6. Ties in similarity (Req 8)
    // =========================================================================================
    // Several records with identical vectors/similarity; assert equal scores, earliest-read order,
    // and that a larger limit returns the whole tie group in that order.
    const tieDbName = `eligibility-tie-${crypto.randomUUID()}`;
    databasesToClean.push(tieDbName);
    const tieRaw = await openRaw(tieDbName, 1, (e) => {
      const s = e.target.result.createObjectStore('vectors', { keyPath: 'id' });
      s.createIndex('tieGroup', 'tieGroup');
    });

    const qTie = [1, 0, 0, 0];
    const tieVector = [0.6, 0.8, 0, 0]; // cosine sim to qTie is exactly 0.6

    const tieCorpus = [
      { id: 1, tieGroup: 'A', embedding: [1, 0, 0, 0] }, // sim 1.0 (ahead of tie group)
      { id: 10, tieGroup: 'A', embedding: tieVector },     // tie group
      { id: 20, tieGroup: 'A', embedding: tieVector },     // tie group
      { id: 30, tieGroup: 'A', embedding: tieVector },     // tie group
      { id: 40, tieGroup: 'A', embedding: tieVector },     // tie group
      { id: 50, tieGroup: 'A', embedding: tieVector },     // tie group
      { id: 60, tieGroup: 'A', embedding: tieVector },     // tie group
      { id: 99, tieGroup: 'A', embedding: [0, 1, 0, 0] }, // sim 0.0 (behind tie group)
    ];

    const tieTx = tieRaw.transaction('vectors', 'readwrite');
    const tieStore = tieTx.objectStore('vectors');
    for (const r of tieCorpus) tieStore.add(r);
    await txComplete(tieTx);
    tieRaw.close();

    const tieDB = new VectorDB({ dbName: tieDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(tieDB);

    // Limit 3: returns record 1 (sim 1.0) and the first 2 of the tie group (ids 10, 20)
    const tieLim3 = await tieDB.queryCandidates(qTie, { limit: 3 });
    check(tieLim3.results.length === 3, 'tie query limit 3 returns 3 results');
    check(tieLim3.results[0].key === 1, 'top result is record 1 (similarity 1.0)');
    check(tieLim3.results[1].key === 10, 'second result is record 10 (earliest read of tie group)');
    check(tieLim3.results[2].key === 20, 'third result is record 20 (second earliest read of tie group)');
    check(tieLim3.results[1].similarity === tieLim3.results[2].similarity, 'tied records 10 and 20 have strictly equal similarity');

    // Limit 5: returns record 1 and the first 4 of the tie group (ids 10, 20, 30, 40)
    const tieLim5 = await tieDB.queryCandidates(qTie, { limit: 5 });
    check(tieLim5.results.length === 5, 'tie query limit 5 returns 5 results');
    const keys5 = tieLim5.results.map((r) => r.key);
    check(keys5[0] === 1 && keys5[1] === 10 && keys5[2] === 20 && keys5[3] === 30 && keys5[4] === 40, `keys match earliest read order [1, 10, 20, 30, 40], got ${JSON.stringify(keys5)}`);

    // Limit 7: returns record 1, all 6 tied records in exact store key order, then record 99
    const tieLim7 = await tieDB.queryCandidates(qTie, { limit: 7 });
    check(tieLim7.results.length === 7, 'tie query limit 7 returns 7 results');
    const keys7 = tieLim7.results.map((r) => r.key);
    check(keys7[0] === 1, 'key 0 is 1');
    const tieGroupReturned = keys7.slice(1);
    check(tieGroupReturned.length === 6, 'all 6 tied records returned under limit 7');
    check(tieGroupReturned.join(',') === '10,20,30,40,50,60', `whole tie group returned in exact store key order [10,20,30,40,50,60], got ${tieGroupReturned.join(',')}`);
    for (let i = 1; i <= 6; i++) {
      check(tieLim7.results[i].similarity === tieLim7.results[1].similarity, `tied record ${keys7[i]} score strictly equals tie group score`);
    }

    // Index query over tieGroup 'A' preserves identical tie ordering
    const tieIndexQ = await tieDB.queryCandidates(qTie, {
      index: 'tieGroup',
      range: IDBKeyRange.only('A'),
      limit: 4,
    });
    const tieIdxKeys = tieIndexQ.results.map((r) => r.key);
    check(tieIdxKeys.join(',') === '1,10,20,30', `index tie query preserves read order [1,10,20,30], got ${tieIdxKeys.join(',')}`);

    // =========================================================================================
    // 7. Threshold + predicate + index together, and threshold excluding predicate-accepted (Req 9)
    // =========================================================================================
    const comboDbName = `eligibility-combo-${crypto.randomUUID()}`;
    databasesToClean.push(comboDbName);
    const comboRaw = await openRaw(comboDbName, 1, (e) => {
      const s = e.target.result.createObjectStore('vectors', { keyPath: 'id' });
      s.createIndex('dept', 'dept');
    });

    const qCombo = [1, 0, 0, 0];
    const comboCorpus = [];

    // 30 records in dept 'eng':
    // - 18 records with active: true
    //     - 6 have similarity ~0.85 (pass threshold 0.70) -> ELIGIBLE
    //     - 12 have similarity ~0.35 (fail threshold 0.70) -> PREDICATE ACCEPTED BUT THRESHOLD EXCLUDED
    // - 12 records with active: false (fail predicate)
    //     - 6 with sim ~0.85, 6 with sim ~0.35
    for (let i = 1; i <= 6; i++) {
      comboCorpus.push({ id: i, dept: 'eng', active: true, embedding: [0.85, 0.52678, 0, 0] });
    }
    for (let i = 7; i <= 18; i++) {
      comboCorpus.push({ id: i, dept: 'eng', active: true, embedding: [0.35, 0.93675, 0, 0] });
    }
    for (let i = 19; i <= 24; i++) {
      comboCorpus.push({ id: i, dept: 'eng', active: false, embedding: [0.85, 0.52678, 0, 0] });
    }
    for (let i = 25; i <= 30; i++) {
      comboCorpus.push({ id: i, dept: 'eng', active: false, embedding: [0.35, 0.93675, 0, 0] });
    }
    // 20 records in dept 'sales' (excluded by index)
    for (let i = 31; i <= 50; i++) {
      comboCorpus.push({ id: i, dept: 'sales', active: true, embedding: [0.85, 0.52678, 0, 0] });
    }

    const comboTx = comboRaw.transaction('vectors', 'readwrite');
    const comboStore = comboTx.objectStore('vectors');
    for (const r of comboCorpus) comboStore.add(r);
    await txComplete(comboTx);
    comboRaw.close();

    const comboDB = new VectorDB({ dbName: comboDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(comboDB);

    const comboOracle = makeOracle(comboCorpus, qCombo, {
      indexFilter: (r) => r.dept === 'eng',
      predicate: (r) => r.active === true,
      threshold: 0.70,
      limit: 10,
    });
    check(comboOracle.recordsRead === 30, 'combo oracle read 30 "eng" records');
    check(comboOracle.recordsScored === 6, 'combo oracle scored exactly 6 eligible records');

    const comboResult = await comboDB.queryCandidates(qCombo, {
      index: 'dept',
      range: IDBKeyRange.only('eng'),
      predicate: (r) => r.active === true,
      threshold: 0.70,
      limit: 10,
    });

    // Check disclosure
    check(comboResult.info.mode === 'index', 'combo mode is "index"');
    check(comboResult.info.index === 'dept', 'combo info.index is "dept"');
    check(comboResult.info.predicate === true, 'combo info.predicate is true');
    check(comboResult.info.threshold === 0.70, 'combo info.threshold is 0.70');
    check(comboResult.info.fullScanRequired === false, 'combo fullScanRequired is false');
    check(comboResult.info.recordsRead === 30, `combo recordsRead is 30, got ${comboResult.info.recordsRead}`);

    // recordsScored must count NEITHER the predicate-rejected NOR the threshold-excluded
    check(comboResult.info.recordsScored === 6, `combo recordsScored is exactly 6 (neither 12 predicate-rejected nor 12 threshold-excluded counted), got ${comboResult.info.recordsScored}`);
    check(comboResult.info.recordsScored < 18, 'combo recordsScored is strictly less than the 18 predicate-accepted records');
    check(comboResult.results.length === 6, 'combo returned 6 results');
    check(keysMatch(comboResult.results, comboOracle.results), 'combo results match oracle keys');
    check(bits(comboResult.results) === bits(comboOracle.results), 'combo results match oracle scores bit-identically');

    // Confirm that every result satisfies all three constraints: index, predicate, and threshold
    for (const r of comboResult.results) {
      check(r.object.dept === 'eng', 'result dept is "eng"');
      check(r.object.active === true, 'result active is true');
      check(r.similarity >= 0.70, 'result similarity >= 0.70');
    }
    // None of the 12 threshold-excluded candidates appear
    for (let id = 7; id <= 18; id++) {
      check(!comboResult.results.some((r) => r.key === id), `threshold-excluded candidate ${id} is absent from results`);
    }
    // None of the 12 predicate-rejected candidates appear
    for (let id = 19; id <= 30; id++) {
      check(!comboResult.results.some((r) => r.key === id), `predicate-rejected candidate ${id} is absent from results`);
    }

    // =========================================================================================
    // 8. Validation/refusals and store integrity (Req 10)
    // =========================================================================================
    const valDbName = `eligibility-val-${crypto.randomUUID()}`;
    databasesToClean.push(valDbName);
    const valRaw = await openRaw(valDbName, 1, (e) => {
      const s = e.target.result.createObjectStore('vectors', { keyPath: 'id' });
      s.createIndex('tag', 'tag');
    });
    const valCorpus = [
      { id: 1, tag: 'v1', embedding: [1, 0, 0, 0] },
      { id: 2, tag: 'v2', embedding: [0, 1, 0, 0] },
      { id: 3, tag: 'v3', embedding: [0.7, 0.71414, 0, 0] },
      { id: 4, tag: 'v4', embedding: [0.6, 0.8, 0, 0] },
      { id: 5, tag: 'v5', embedding: [0.8, 0.6, 0, 0] },
    ];
    const valTx = valRaw.transaction('vectors', 'readwrite');
    const valStore = valTx.objectStore('vectors');
    for (const r of valCorpus) valStore.add(r);
    await txComplete(valTx);
    valRaw.close();

    const valDB = new VectorDB({ dbName: valDbName, objectStore: 'vectors', vectorPath: 'embedding' });
    dbInstances.push(valDB);

    const testVec = [1, 0, 0, 0];

    // Snapshot store contents before running refusals
    const initialRecords = await getAllRaw(valDbName);
    check(initialRecords.length === 5, 'initial validation store holds 5 records');

    // (a) query() threshold refusals
    await refusal('query threshold > 1',
      () => valDB.query(testVec, { threshold: 2 }),
      { type: RangeError, includes: ['threshold must be a cosine similarity between -1 and 1', '2'] });

    await refusal('query threshold < -1',
      () => valDB.query(testVec, { threshold: -1.5 }),
      { type: RangeError, includes: ['threshold must be a cosine similarity between -1 and 1', '-1.5'] });

    await refusal('query threshold NaN',
      () => valDB.query(testVec, { threshold: NaN }),
      { type: TypeError, includes: ['threshold must be a finite number', 'NaN'] });

    await refusal('query threshold Infinity',
      () => valDB.query(testVec, { threshold: Infinity }),
      { type: TypeError, includes: ['threshold must be a finite number', 'Infinity'] });

    await refusal('query threshold string',
      () => valDB.query(testVec, { threshold: '0.5' }),
      { type: TypeError, includes: ['threshold must be a finite number', '"0.5"'] });

    await refusal('query threshold null',
      () => valDB.query(testVec, { threshold: null }),
      { type: TypeError, includes: ['threshold must be a finite number', 'null'] });

    // (b) queryCandidates() threshold refusals
    await refusal('queryCandidates threshold > 1',
      () => valDB.queryCandidates(testVec, { threshold: 2 }),
      { type: RangeError, includes: ['threshold must be a cosine similarity between -1 and 1', '2'] });

    await refusal('queryCandidates threshold < -1',
      () => valDB.queryCandidates(testVec, { threshold: -1.5 }),
      { type: RangeError, includes: ['threshold must be a cosine similarity between -1 and 1', '-1.5'] });

    await refusal('queryCandidates threshold NaN',
      () => valDB.queryCandidates(testVec, { threshold: NaN }),
      { type: TypeError, includes: ['threshold must be a finite number', 'NaN'] });

    await refusal('queryCandidates threshold Infinity',
      () => valDB.queryCandidates(testVec, { threshold: Infinity }),
      { type: TypeError, includes: ['threshold must be a finite number', 'Infinity'] });

    await refusal('queryCandidates threshold string',
      () => valDB.queryCandidates(testVec, { threshold: '0.5' }),
      { type: TypeError, includes: ['threshold must be a finite number', '"0.5"'] });

    // (c) Unknown option name e.g. minSimilarity
    await refusal('unknown minSimilarity option rejected',
      () => valDB.queryCandidates(testVec, { minSimilarity: 0.5 }),
      { type: TypeError, includes: ['queryCandidates() option "minSimilarity" is not supported', 'limit, threshold, index, range, predicate'] });

    // (d) Range / predicate / index / limit refusals from candidates.mjs
    await refusal('limit 0 rejected',
      () => valDB.queryCandidates(testVec, { limit: 0 }),
      { type: RangeError, includes: ['limit must be a positive integer', '0'] });

    await refusal('limit -5 rejected',
      () => valDB.queryCandidates(testVec, { limit: -5 }),
      { type: RangeError, includes: ['limit must be a positive integer', '-5'] });

    await refusal('limit 2.7 rejected',
      () => valDB.queryCandidates(testVec, { limit: 2.7 }),
      { type: RangeError, includes: ['limit must be a positive integer', '2.7'] });

    await refusal('limit string rejected',
      () => valDB.queryCandidates(testVec, { limit: '10' }),
      { type: RangeError, includes: ['limit must be a positive integer', '"10"'] });

    await refusal('limit NaN rejected',
      () => valDB.queryCandidates(testVec, { limit: NaN }),
      { type: RangeError, includes: ['limit must be a positive integer', 'NaN'] });

    await refusal('limit Infinity rejected',
      () => valDB.queryCandidates(testVec, { limit: Infinity }),
      { type: RangeError, includes: ['limit must be a positive integer', 'Infinity'] });

    await refusal('limit null rejected',
      () => valDB.queryCandidates(testVec, { limit: null }),
      { type: RangeError, includes: ['limit must be a positive integer', 'null'] });

    await refusal('numeric index rejected',
      () => valDB.queryCandidates(testVec, { index: 123 }),
      { type: TypeError, includes: ['index must be a non-empty string', '123'] });

    await refusal('empty string index rejected',
      () => valDB.queryCandidates(testVec, { index: '' }),
      { type: TypeError, includes: ['index must be a non-empty string'] });

    await refusal('missing index names store and available',
      () => valDB.queryCandidates(testVec, { index: 'nonexistent' }),
      { type: TypeError, includes: ["'vectors'", '"nonexistent"', 'tag'] });

    await refusal('array range rejected',
      () => valDB.queryCandidates(testVec, { range: [1, 2] }),
      { type: TypeError, includes: ['range must be an IDBKeyRange built with IDBKeyRange.only/bound/lowerBound/upperBound', 'an Array of length 2'] });

    await refusal('string range rejected',
      () => valDB.queryCandidates(testVec, { range: '1..10' }),
      { type: TypeError, includes: ['range must be an IDBKeyRange built with IDBKeyRange.only/bound/lowerBound/upperBound', '"1..10"'] });

    await refusal('string predicate rejected',
      () => valDB.queryCandidates(testVec, { predicate: 'r => true' }),
      { type: TypeError, includes: ['predicate must be a function of one record returning a boolean', '"r => true"'] });

    await refusal('object predicate rejected',
      () => valDB.queryCandidates(testVec, { predicate: { active: true } }),
      { type: TypeError, includes: ['predicate must be a function of one record returning a boolean', 'an object'] });

    await refusal('throwing predicate preserves message and key',
      () => valDB.queryCandidates(testVec, {
        predicate: (r) => {
          if (r.id === 3) throw new Error('user explosion in predicate');
          return true;
        },
      }),
      { type: Error, includes: ['queryCandidates() predicate threw for key 3', 'user explosion in predicate'] });

    await refusal('empty query vector rejected',
      () => valDB.queryCandidates([], { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector must not be empty'] });

    await refusal('zero query vector rejected',
      () => valDB.queryCandidates([0, 0, 0, 0], { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector must not be all zeros'] });

    await refusal('NaN coordinate query vector rejected',
      () => valDB.queryCandidates([1, NaN, 0, 0], { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector coordinate 1 must be a finite number', 'NaN'] });

    await refusal('non-array query vector rejected',
      () => valDB.queryCandidates('1,0,0,0', { limit: 5 }),
      { type: TypeError, includes: ['queryCandidates() vector must be an Array'] });

    // (e) Assert store contents are completely unchanged after refusals (no partial write, no corrupt state)
    const postRefusalRecords = await getAllRaw(valDbName);
    check(postRefusalRecords.length === initialRecords.length, `store size unchanged: expected ${initialRecords.length}, got ${postRefusalRecords.length}`);
    for (let i = 0; i < initialRecords.length; i++) {
      check(postRefusalRecords[i].id === initialRecords[i].id, `record ${i} id matches`);
      check(postRefusalRecords[i].tag === initialRecords[i].tag, `record ${i} tag matches`);
      check(postRefusalRecords[i].embedding.join(',') === initialRecords[i].embedding.join(','), `record ${i} vector matches`);
    }

    // Verify store is fully operational (no hanging or locked transactions)
    await valDB.insert({ id: 100, tag: 'v100', embedding: [1, 0, 0, 0] });
    const postInsertRecords = await getAllRaw(valDbName);
    check(postInsertRecords.length === 6, 'subsequent insert succeeded after refusals');
    const operationalQuery = await valDB.query([1, 0, 0, 0], { limit: 2 });
    check(operationalQuery.length === 2, 'subsequent query succeeded after refusals');
    check(operationalQuery[0].key === 1 || operationalQuery[0].key === 100, 'operational query returned expected top record');

    // =========================================================================================
    // 9. candidateSetComplete (the promise) and threshold-option consistency (Req 11, 12)
    // =========================================================================================
    // Only a read that visited every record can promise the global eligible top-k. An index read and
    // a key-range read can only promise it within the records they read, and must say so.
    const fullScanPromise = await valDB.queryCandidates(testVec, { limit: 3 });
    check(fullScanPromise.info.mode === 'full-scan', 'promise: full-scan mode');
    check(fullScanPromise.info.candidateSetComplete === true, 'promise: a whole-store read is a complete candidate set');
    check(fullScanPromise.info.fullScanRequired === true, 'promise: fullScanRequired agrees on a whole-store read');
    check(fullScanPromise.info.recordsRead === 6, `promise: whole store read is 6 records, got ${fullScanPromise.info.recordsRead}`);
    check(fullScanPromise.info.threshold === null, 'promise: an omitted threshold is disclosed as null');
    check(fullScanPromise.results.length === 3, 'promise: the full scan still honours limit');

    const indexPromise = await valDB.queryCandidates(testVec, { index: 'tag', range: IDBKeyRange.only('v1'), limit: 3 });
    check(indexPromise.info.mode === 'index', 'promise: index mode');
    check(indexPromise.info.candidateSetComplete === false, 'promise: an index read is NOT a complete candidate set');
    check(indexPromise.info.fullScanRequired === false, 'promise: the index read did not require a full scan');
    check(indexPromise.info.recordsRead === 1, `promise: the index read visited 1 record, got ${indexPromise.info.recordsRead}`);

    const rangePromise = await valDB.queryCandidates(testVec, { range: IDBKeyRange.bound(1, 3), limit: 3 });
    check(rangePromise.info.mode === 'store-range', 'promise: store-range mode');
    check(rangePromise.info.candidateSetComplete === false, 'promise: a key-range read is NOT a complete candidate set');
    check(rangePromise.info.recordsRead === 3, `promise: the key-range read visited 3 records, got ${rangePromise.info.recordsRead}`);

    // threshold is a scalar option like limit: omit it for none, and null is refused on both entry
    // points so a caller's failed computation cannot silently un-filter the query.
    const undefinedThreshold = await valDB.queryCandidates(testVec, { threshold: undefined, limit: 2 });
    check(undefinedThreshold.info.threshold === null, 'promise: threshold undefined is omitted, not refused');
    check(undefinedThreshold.results.length === 2, 'promise: omitting threshold keeps the limit');
    await refusal('queryCandidates threshold null rejected',
      () => valDB.queryCandidates(testVec, { threshold: null, limit: 2 }),
      { type: TypeError, includes: ['threshold must be a finite number', 'null'] });
    await refusal('query threshold null rejected',
      () => valDB.query(testVec, { threshold: null, limit: 2 }),
      { type: TypeError, includes: ['threshold must be a finite number', 'null'] });
    check((await getAllRaw(valDbName)).length === 6, 'promise: a refused threshold left the store unchanged');

    // =========================================================================================
    // 10. query() option allow-list: an ignored filter is never silently ignored (idb-vector-5a8)
    // =========================================================================================
    // Before this, query(vector, { predicate: fn }) returned the UNFILTERED top-k with no error,
    // which is the late-filter trap: results that look filtered because the caller asked for it.
    await refusal('query predicate option refused',
      () => valDB.query(testVec, { predicate: (r) => r.tag === 'v1' }),
      { type: TypeError, includes: ['query() option "predicate" is not supported', 'limit and threshold', 'queryCandidates()'] });
    await refusal('query index option refused',
      () => valDB.query(testVec, { index: 'tag' }),
      { type: TypeError, includes: ['query() option "index" is not supported', 'queryCandidates()'] });
    await refusal('query range option refused',
      () => valDB.query(testVec, { range: IDBKeyRange.only(1) }),
      { type: TypeError, includes: ['query() option "range" is not supported', 'queryCandidates()'] });
    await refusal('query unknown option refused',
      () => valDB.query(testVec, { minSimilarity: 0.5 }),
      { type: TypeError, includes: ['query() option "minSimilarity" is not supported', 'limit and threshold'] });
    // The guidance is real, not decorative: the predicate query() refused selects candidates on the
    // candidate path, and it selects exactly the record the caller meant.
    const guided = await valDB.queryCandidates(testVec, { predicate: (r) => r.tag === 'v1', limit: 5 });
    check(guided.results.length === 1 && guided.results[0].key === 1, `the predicate query() refused selects exactly one candidate through queryCandidates(), got ${guided.results.length}`);
    // Allow-listed options still work, and a refused call writes nothing.
    const allowed = await valDB.query(testVec, { limit: 2, threshold: -1 });
    check(allowed.length === 2, `query() still accepts limit and threshold, got ${allowed.length} results`);
    check((await getAllRaw(valDbName)).length === 6, 'query() option refusals left the store unchanged');

    // =========================================================================================
    // Cleanup
    // =========================================================================================
    for (const db of dbInstances) {
      try {
        await db.close();
      } catch {}
    }
    for (const name of databasesToClean) {
      try {
        indexedDB.deleteDatabase(name);
      } catch {}
    }

    return {
      checks: checks.length,
      refusals,
    };
  });

  assert.ok(result.checks >= 200, `expected at least 200 eligibility checks, ran ${result.checks}`);

  console.log(`PASS: ${result.checks} eligibility checks in a real browser`);
  console.log('Sample refusals:');
  for (const [label, msg] of Object.entries(result.refusals).slice(0, 5)) {
    console.log(`  ${label} -> ${msg}`);
  }
} finally {
  await page?.close();
  await new Promise((resolve) => server.close(resolve));
}
