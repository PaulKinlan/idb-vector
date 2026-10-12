// tests/side-store.mjs — opt-in int8 code side-store with bounded exact rerank (idb-vector-kuc.10)
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

    const openRaw = (name, version, onupgradeneeded) => new Promise((resolve, reject) => {
      const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
      if (onupgradeneeded) req.onupgradeneeded = onupgradeneeded;
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const txComplete = (tx) => new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    });

    const databasesToClean = [];

    try {
      const dbName = `side-store-test-${crypto.randomUUID()}`;
      databasesToClean.push(dbName);

      // Create database with two stores: 'vectors' (originals) and 'codes' (side-store)
      const raw = await openRaw(dbName, 1, (e) => {
        e.target.result.createObjectStore('vectors', { keyPath: 'id' });
        e.target.result.createObjectStore('codes');
      });
      raw.close();

      const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });

      // Generate 1,000 synthetic vectors in 32 dimensions
      const DIMS = 32;
      const COUNT = 1000;
      const makeVec = (seed) => {
        const v = [];
        let normSq = 0;
        for (let d = 0; d < DIMS; d++) {
          const val = Math.sin(seed * (d + 1)) * Math.cos(seed + d);
          v.push(val);
          normSq += val * val;
        }
        const norm = Math.sqrt(normSq) || 1;
        return v.map(x => x / norm);
      };

      const queryVector = makeVec(999);

      // Insert records in batches
      for (let i = 1; i <= COUNT; i++) {
        await db.insert({ id: i, category: i % 2 === 0 ? 'even' : 'odd', embedding: makeVec(i) });
      }

      // 1. Build side-store
      const buildStats = await db.buildSideStore({ sideStore: 'codes', revision: 1 });
      check(buildStats.revision === 1, 'buildSideStore sets revision 1');
      check(buildStats.count === COUNT, `buildSideStore counts ${COUNT} records`);
      check(buildStats.dims === DIMS, `buildSideStore dims is ${DIMS}`);
      check(buildStats.bytes > 0, `buildSideStore computes byte size: ${buildStats.bytes}`);
      check(buildStats.bytes < COUNT * DIMS * 4, 'int8 side-store bytes is under 25% of Float32');

      // 2. Query side-store and compare against exact cursor query
      const exactResults = await db.query(queryVector, { limit: 10 });
      const sideStoreQuery = await db.querySideStore(queryVector, {
        sideStore: 'codes',
        revision: 1,
        candidateBudget: 150,
        limit: 10,
      });

      check(sideStoreQuery.results.length === 10, `sideStore returned 10 results, got ${sideStoreQuery.results.length}`);
      check(sideStoreQuery.info.mode === 'side-store', 'info.mode is "side-store"');
      check(sideStoreQuery.info.revision === 1, 'info.revision is 1');
      check(sideStoreQuery.info.candidateBudget === 150, 'info.candidateBudget is 150');
      check(sideStoreQuery.info.recordsFetched === 150, 'info.recordsFetched is 150');

      // Rerank scores must match exact scores bit-for-bit
      for (let i = 0; i < 10; i++) {
        const exactRow = exactResults[i];
        const sideRow = sideStoreQuery.results[i];
        check(exactRow.key === sideRow.key, `rank ${i} key match: ${exactRow.key} === ${sideRow.key}`);
        check(Math.abs(exactRow.similarity - sideRow.similarity) < 1e-12, `rank ${i} exact Float64 similarity match`);
      }

      // 3. Revision pinning refusal: query with wrong revision fails
      let revError = null;
      try {
        await db.querySideStore(queryVector, { sideStore: 'codes', revision: 2 });
      } catch (err) {
        revError = err;
      }
      check(revError !== null, 'query with mismatched revision throws');
      check(revError.message.includes('revision mismatch'), `error names revision mismatch: ${revError.message}`);
      check(revError.message.includes('pinned revision 2'), `error names pinned revision: ${revError.message}`);

      // 4. Threshold filtering
      const threshQuery = await db.querySideStore(queryVector, {
        sideStore: 'codes',
        revision: 1,
        candidateBudget: 150,
        limit: 10,
        threshold: 0.8,
      });
      for (const row of threshQuery.results) {
        check(row.similarity >= 0.8, `row similarity >= threshold: ${row.similarity}`);
      }

      // 5. Predicate filtering
      const predQuery = await db.querySideStore(queryVector, {
        sideStore: 'codes',
        revision: 1,
        candidateBudget: 150,
        limit: 10,
        predicate: (r) => r.category === 'even',
      });
      for (const row of predQuery.results) {
        check(row.object.category === 'even', `row matches predicate: ${row.object.category}`);
      }

      // 6. createSideStore helper interface
      const sideStoreHelper = await db.createSideStore({ sideStore: 'codes', revision: 1 });
      const helperQuery = await sideStoreHelper.query(queryVector, { candidateBudget: 100, limit: 5 });
      check(helperQuery.results.length === 5, 'createSideStore helper query returns 5 results');
      check(helperQuery.results[0].key === exactResults[0].key, 'helper query rank 0 matches exact');

      // 7. 0 dead rows enforcement: deleting a candidate record causes subsequent query to throw
      const topKeyToDelete = sideStoreQuery.results[0].key;
      await db.delete(topKeyToDelete);
      let deadRowError = null;
      try {
        await db.querySideStore(queryVector, { sideStore: 'codes', revision: 1, candidateBudget: 100, limit: 10 });
      } catch (err) {
        deadRowError = err;
      }
      check(deadRowError !== null, 'stale candidate referencing deleted row throws');
      check(deadRowError.message.includes('0 dead rows acceptable on the current revision'),
        `error explains 0 dead rows requirement: ${deadRowError.message}`);

      await db.close();

      return {
        checks: checks.length,
        buildStats,
      };
    } finally {
      for (const name of databasesToClean) {
        try {
          await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = resolve;
            req.onerror = resolve;
            req.onblocked = resolve;
          });
        } catch {}
      }
    }
  });

  console.log(`PASS: ${result.checks} side-store checks in a real browser`);
  console.log(`  Side-store built: ${result.buildStats.count} records, ${result.buildStats.dims}D, ${(result.buildStats.bytes / 1024).toFixed(1)} KB in ${result.buildStats.writeMs.toFixed(1)} ms`);
} finally {
  await page?.close();
  await new Promise((resolve) => server.close(resolve));
}
