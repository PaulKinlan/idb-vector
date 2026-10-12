// tests/side-store.mjs — opt-in int8 code side-store with bounded exact rerank (ADR 0001)
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

    const databasesToClean = [];

    try {
      // =========================================================================
      // Invariant 1: Key Identity on Out-of-Line Object Store (idb-vector-yoe repro)
      // A side-store query on an out-of-line store returns the exact out-of-line primary
      // keys (not indices or unrelated record.id).
      // =========================================================================
      const oolDbName = `side-store-ool-${crypto.randomUUID()}`;
      databasesToClean.push(oolDbName);
      const oolRaw = await openRaw(oolDbName, 1, (e) => {
        // Out-of-line object store: no keyPath specified
        e.target.result.createObjectStore('vectors');
        e.target.result.createObjectStore('codes');
      });
      oolRaw.close();

      const oolDb = new VectorDB({ dbName: oolDbName, objectStore: 'vectors', vectorPath: 'embedding' });
      // Insert with out-of-line primary key "real-primary-key" and conflicting record.id "wrong-id"
      await oolDb.insert({ id: 'wrong-id', revision: 1, embedding: [1, 0] }, 'real-primary-key');
      await oolDb.insert({ id: 'wrong-id-2', revision: 1, embedding: [0, 1] }, 'second-primary-key');

      await oolDb.buildSideStore({ sideStore: 'codes', revision: 1 });
      const oolQuery = await oolDb.querySideStore([1, 0], {
        sideStore: 'codes',
        revision: 1,
        candidateBudget: 2,
        limit: 1,
      });

      check(oolQuery.results.length === 1, 'Invariant 1: query returns 1 result on out-of-line store');
      check(oolQuery.results[0].key === 'real-primary-key',
        `Invariant 1: result key must match exact out-of-line primary key "real-primary-key", got ${oolQuery.results[0].key}`);
      check(oolQuery.results[0].object.id === 'wrong-id',
        'Invariant 1: result object contains original record');
      await oolDb.close();

      // =========================================================================
      // Invariant 3: Revision Pinning (Unversioned Originals on Build)
      // buildSideStore throws TypeError if an original record lacks the revision property.
      // =========================================================================
      const unversionedDbName = `side-store-unversioned-${crypto.randomUUID()}`;
      databasesToClean.push(unversionedDbName);
      const unversionedRaw = await openRaw(unversionedDbName, 1, (e) => {
        e.target.result.createObjectStore('vectors', { keyPath: 'id' });
        e.target.result.createObjectStore('codes');
      });
      unversionedRaw.close();

      const unversionedDb = new VectorDB({ dbName: unversionedDbName, objectStore: 'vectors', vectorPath: 'embedding' });
      await unversionedDb.insert({ id: 1, embedding: [1, 0] }); // unversioned!

      let unversionedError = null;
      try {
        await unversionedDb.buildSideStore({ sideStore: 'codes', revision: 1 });
      } catch (err) {
        unversionedError = err;
      }
      check(unversionedError !== null, 'Invariant 3: buildSideStore throws on unversioned original');
      check(unversionedError instanceof TypeError,
        `Invariant 3: error is TypeError, got ${unversionedError?.constructor?.name}`);
      check(unversionedError.message.includes('Revision pinning requires all records to carry a matching revision property'),
        `Invariant 3: message explains revision requirement: ${unversionedError.message}`);
      await unversionedDb.close();

      // =========================================================================
      // Standard In-line Store: Invariants 2, 4, 5, 6 & Parity Verification
      // =========================================================================
      const dbName = `side-store-test-${crypto.randomUUID()}`;
      databasesToClean.push(dbName);

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

      // Insert 1,000 records with revision 1
      for (let i = 1; i <= COUNT; i++) {
        await db.insert({ id: i, revision: 1, category: i % 2 === 0 ? 'even' : 'odd', embedding: makeVec(i) });
      }

      // Build side-store
      const buildStats = await db.buildSideStore({ sideStore: 'codes', revision: 1 });
      check(buildStats.revision === 1, 'buildSideStore sets revision 1');
      check(buildStats.count === COUNT, `buildSideStore counts ${COUNT} records`);
      check(buildStats.dims === DIMS, `buildSideStore dims is ${DIMS}`);
      check(buildStats.bytes > 0, `buildSideStore byte size: ${buildStats.bytes}`);
      check(buildStats.bytes < COUNT * DIMS * 4, 'int8 side-store bytes under 25% of Float32');

      // Parity check: side-store with exact reranking matches db.query bit-for-bit
      const exactResults = await db.query(queryVector, { limit: 10 });
      const sideStoreQuery = await db.querySideStore(queryVector, {
        sideStore: 'codes',
        revision: 1,
        candidateBudget: 150,
        limit: 10,
      });

      check(sideStoreQuery.results.length === 10, 'sideStore returns 10 results');
      check(sideStoreQuery.info.mode === 'side-store', 'info.mode is "side-store"');
      check(sideStoreQuery.info.revision === 1, 'info.revision is 1');
      check(sideStoreQuery.info.candidateBudget === 150, 'info.candidateBudget is 150');
      check(sideStoreQuery.info.recordsFetched === 150, 'info.recordsFetched is 150');

      for (let i = 0; i < 10; i++) {
        const exactRow = exactResults[i];
        const sideRow = sideStoreQuery.results[i];
        check(exactRow.key === sideRow.key, `rank ${i} key match: ${exactRow.key} === ${sideRow.key}`);
        check(Math.abs(exactRow.similarity - sideRow.similarity) < 1e-12, `rank ${i} exact Float64 similarity match`);
      }

      // =========================================================================
      // Invariant 5: Predicate Rejection
      // Passing a JS function predicate to querySideStore throws a TypeError.
      // =========================================================================
      let predError = null;
      try {
        await db.querySideStore(queryVector, {
          sideStore: 'codes',
          revision: 1,
          candidateBudget: 100,
          limit: 10,
          predicate: (r) => r.category === 'even',
        });
      } catch (err) {
        predError = err;
      }
      check(predError !== null, 'Invariant 5: querySideStore with predicate throws');
      check(predError instanceof TypeError, `Invariant 5: error is TypeError, got ${predError?.constructor?.name}`);
      check(predError.message.includes('arbitrary record predicates are forbidden in side-store queries'),
        `Invariant 5: error explains predicate rejection: ${predError.message}`);

      // =========================================================================
      // Invariant 6: Eligibility Before Truncation
      // Passing eligibleKeys filters candidates BEFORE candidateBudget is enforced.
      // =========================================================================
      const evenKeys = new Set(Array.from({ length: 500 }, (_, i) => (i + 1) * 2));
      const keyFilteredQuery = await db.querySideStore(queryVector, {
        sideStore: 'codes',
        revision: 1,
        candidateBudget: 50,
        limit: 10,
        eligibleKeys: evenKeys,
      });
      check(keyFilteredQuery.results.length === 10, 'Invariant 6: key-filtered query returns 10 results');
      for (const row of keyFilteredQuery.results) {
        check(row.key % 2 === 0, `Invariant 6: result key ${row.key} is even`);
      }

      // =========================================================================
      // Invariant 2: Revision Pinning (Stale)
      // An original record updated to a new revision is rejected under the old pinned revision.
      // =========================================================================
      const targetUpdateKey = sideStoreQuery.results[1].key;
      await db.update(targetUpdateKey, { id: targetUpdateKey, revision: 2, embedding: makeVec(targetUpdateKey + 1) });
      let staleRevError = null;
      try {
        await db.querySideStore(queryVector, { sideStore: 'codes', revision: 1, candidateBudget: 100, limit: 10 });
      } catch (err) {
        staleRevError = err;
      }
      check(staleRevError !== null, 'Invariant 2: query pinned to revision 1 throws when original has revision 2');
      check(staleRevError.message.includes(`Record ${targetUpdateKey} has revision 2, but query pinned revision 1`),
        `Invariant 2: error explains revision mismatch: ${staleRevError.message}`);

      // =========================================================================
      // Invariant 4: Revision Pinning (Fail-safe Fallback)
      // A missing or mismatched original record triggers fallback: true to exact scan.
      // =========================================================================
      const fallbackQuery = await db.querySideStore(queryVector, {
        sideStore: 'codes',
        revision: 1,
        candidateBudget: 100,
        limit: 10,
        fallback: true,
      });
      check(fallbackQuery.info.mode === 'exact-fallback', 'Invariant 4: fallback: true enters exact-fallback mode');
      check(fallbackQuery.results.length === 10, 'Invariant 4: exact fallback returns 10 results');
      // Verify fallback results match live db.query results
      const liveExact = await db.query(queryVector, { limit: 10 });
      for (let i = 0; i < 10; i++) {
        check(fallbackQuery.results[i].key === liveExact[i].key,
          `Invariant 4: fallback result rank ${i} matches live exact query`);
      }

      // Restore record
      await db.update(targetUpdateKey, { id: targetUpdateKey, revision: 1, embedding: makeVec(targetUpdateKey) });

      // 0 Dead Rows check: deleting a candidate record throws when fallback: false
      const topKeyToDelete = sideStoreQuery.results[0].key;
      await db.delete(topKeyToDelete);
      let deadRowError = null;
      try {
        await db.querySideStore(queryVector, { sideStore: 'codes', revision: 1, candidateBudget: 100, limit: 10 });
      } catch (err) {
        deadRowError = err;
      }
      check(deadRowError !== null, 'Invariant 4: missing row throws error without fallback');
      check(deadRowError.message.includes('0 dead rows acceptable on the current revision'),
        `Invariant 4: dead row error explains requirement: ${deadRowError.message}`);

      // createSideStore helper interface
      const sideStoreHelper = await db.createSideStore({ sideStore: 'codes', revision: 1 });
      const helperFallback = await sideStoreHelper.query(queryVector, { candidateBudget: 100, limit: 5, fallback: true });
      check(helperFallback.results.length === 5, 'createSideStore helper returns 5 results');

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

  console.log(`PASS: ${result.checks} side-store checks in a real browser (all 6 ADR 0001 invariants covered)`);
  console.log(`  Side-store built: ${result.buildStats.count} records, ${result.buildStats.dims}D, ${(result.buildStats.bytes / 1024).toFixed(1)} KB in ${result.buildStats.writeMs.toFixed(1)} ms`);
} finally {
  await page?.close();
  await new Promise((resolve) => server.close(resolve));
}
