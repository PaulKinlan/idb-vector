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
    const defaultGetEpoch = async () => 1;

    try {
      // =========================================================================
      // Invariant 1: Key Identity (in-line keyPath)
      // =========================================================================
      {
        const dbName = `test-inv1-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { keyPath: 'id' });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        await db.insert({ id: 101, embedding: [1, 0] });
        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });
        const res = await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, limit: 1 });
        check(res.results.length === 1, 'Inv 1: returns 1 result');
        check(res.results[0].key === 101, `Inv 1: in-line key is 101, got ${res.results[0].key}`);
        await db.close();
      }

      // =========================================================================
      // Invariant 2: Key Identity (out-of-line primary key, idb-vector-yoe)
      // =========================================================================
      {
        const dbName = `test-inv2-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors'); // out of line
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        await db.insert({ id: 'confusing-id', embedding: [1, 0] }, 'real-ool-key');
        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });
        const res = await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, limit: 1 });
        check(res.results.length === 1, 'Inv 2: returns 1 result');
        check(res.results[0].key === 'real-ool-key', `Inv 2: out-of-line key is "real-ool-key", got ${res.results[0].key}`);
        check(res.results[0].object.id === 'confusing-id', 'Inv 2: object preserved');
        await db.close();
      }

      // =========================================================================
      // Invariant 3: Key Identity (autoIncrement)
      // =========================================================================
      {
        const dbName = `test-inv3-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { autoIncrement: true });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        await db.insert({ embedding: [1, 0] });
        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });
        const res = await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, limit: 1 });
        check(res.results.length === 1, 'Inv 3: returns 1 result');
        check(typeof res.results[0].key === 'number' && res.results[0].key >= 1, `Inv 3: autoIncrement key is generated number, got ${res.results[0].key}`);
        await db.close();
      }

      // =========================================================================
      // Invariant 4: Key Identity (number/string primary keys)
      // =========================================================================
      {
        const dbName = `test-inv4-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { keyPath: 'k' });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        await db.insert({ k: 'string-key-42', embedding: [1, 0] });
        await db.insert({ k: 42, embedding: [0, 1] });
        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });
        const resStr = await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, limit: 1 });
        const resNum = await db.querySideStore([0, 1], { epoch: 1, getEpoch: defaultGetEpoch, limit: 1 });
        check(resStr.results[0].key === 'string-key-42', `Inv 4: string key preserved: ${resStr.results[0].key}`);
        check(resNum.results[0].key === 42, `Inv 4: number key preserved: ${resNum.results[0].key}`);
        await db.close();
      }

      // =========================================================================
      // Invariant 5: Key Identity (Date/array primary keys)
      // =========================================================================
      {
        const dbName = `test-inv5-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors');
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        const dateKey = new Date(1700000000000);
        const arrayKey = ['cat', 99];
        await db.insert({ embedding: [1, 0] }, dateKey);
        await db.insert({ embedding: [0, 1] }, arrayKey);
        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });
        const resDate = await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, limit: 1 });
        const resArr = await db.querySideStore([0, 1], { epoch: 1, getEpoch: defaultGetEpoch, limit: 1 });
        check(indexedDB.cmp(resDate.results[0].key, dateKey) === 0, 'Inv 5: Date key matches via indexedDB.cmp');
        check(indexedDB.cmp(resArr.results[0].key, arrayKey) === 0, 'Inv 5: Array key matches via indexedDB.cmp');
        await db.close();
      }

      // =========================================================================
      // Invariant 6: Key Identity (custom nested keyPath)
      // =========================================================================
      {
        const dbName = `test-inv6-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { keyPath: 'meta.item.id' });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        await db.insert({ meta: { item: { id: 'nested-uuid-1' } }, embedding: [1, 0] });
        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });
        const res = await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, limit: 1 });
        check(res.results[0].key === 'nested-uuid-1', `Inv 6: custom nested keyPath returned: ${res.results[0].key}`);
        await db.close();
      }

      // =========================================================================
      // Invariant 7: Store-wide Revision Pinning (Stale Epoch Rejection)
      // =========================================================================
      {
        const dbName = `test-inv7-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { keyPath: 'id' });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        await db.insert({ id: 1, embedding: [1, 0] });

        let storeEpoch = 1;
        const getEpoch = async () => storeEpoch;

        await db.buildSideStore({ epoch: 1, getEpoch });

        // Query with pinned epoch 1 succeeds
        const q1 = await db.querySideStore([1, 0], { epoch: 1, getEpoch });
        check(q1.results.length === 1, 'Inv 7: initial query on matching epoch succeeds');

        // Main store advances to epoch 2
        storeEpoch = 2;

        let staleError = null;
        try {
          await db.querySideStore([1, 0], { epoch: 1, getEpoch });
        } catch (err) {
          staleError = err;
        }
        check(staleError !== null, 'Inv 7: query on old epoch 1 after store advanced to epoch 2 rejects');
        check(staleError.message.includes('Store-wide epoch mismatch'), `Inv 7: error explains epoch mismatch: ${staleError.message}`);
        await db.close();
      }

      // =========================================================================
      // Invariant 8: Store-wide Revision Pinning (Unversioned / Missing getEpoch Rejection)
      // =========================================================================
      {
        const dbName = `test-inv8-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { keyPath: 'id' });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        await db.insert({ id: 1, embedding: [1, 0] });

        // 1. buildSideStore without getEpoch rejects
        let unversionedBuildError = null;
        try {
          await db.buildSideStore({ epoch: 1 }); // missing getEpoch!
        } catch (err) {
          unversionedBuildError = err;
        }
        check(unversionedBuildError !== null, 'Inv 8: build without getEpoch rejects');
        check(unversionedBuildError instanceof TypeError, `Inv 8: build error is TypeError, got ${unversionedBuildError?.constructor?.name}`);
        check(unversionedBuildError.message.includes('requires a trustworthy corpus-wide epoch mechanism'), `Inv 8: message: ${unversionedBuildError.message}`);

        // Build with valid getEpoch
        const getEpoch = async () => 1;
        await db.buildSideStore({ epoch: 1, getEpoch });

        // 2. querySideStore without getEpoch rejects
        let unversionedQueryError = null;
        try {
          await db.querySideStore([1, 0], { epoch: 1 }); // missing getEpoch!
        } catch (err) {
          unversionedQueryError = err;
        }
        check(unversionedQueryError !== null, 'Inv 8: query without getEpoch rejects');
        check(unversionedQueryError instanceof TypeError, `Inv 8: query error is TypeError, got ${unversionedQueryError?.constructor?.name}`);

        // 3. querySideStore without pinned epoch rejects
        let missingPinnedEpochError = null;
        try {
          await db.querySideStore([1, 0], { getEpoch }); // missing epoch!
        } catch (err) {
          missingPinnedEpochError = err;
        }
        check(missingPinnedEpochError !== null, 'Inv 8: query without pinned epoch rejects');
        check(missingPinnedEpochError instanceof TypeError, `Inv 8: missing epoch is TypeError`);

        // 4. getEpoch returning null or undefined rejects
        let nullEpochError = null;
        try {
          await db.querySideStore([1, 0], { epoch: 1, getEpoch: async () => null });
        } catch (err) {
          nullEpochError = err;
        }
        check(nullEpochError !== null, 'Inv 8: null getEpoch return rejects');

        await db.close();
      }

      // =========================================================================
      // Invariant 9: Predicate Rejection
      // =========================================================================
      {
        const dbName = `test-inv9-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { keyPath: 'id' });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        await db.insert({ id: 1, category: 'a', embedding: [1, 0] });
        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });

        let predError = null;
        try {
          await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, predicate: (r) => r.category === 'a' });
        } catch (err) {
          predError = err;
        }
        check(predError !== null, 'Inv 9: querySideStore with predicate throws');
        check(predError instanceof TypeError, `Inv 9: error is TypeError, got ${predError?.constructor?.name}`);
        check(predError.message.includes('arbitrary record predicates are forbidden in side-store queries'),
          `Inv 9: message explains ADR 0001 rejection: ${predError.message}`);
        await db.close();
      }

      // =========================================================================
      // Invariant 10: Eligibility Equality (Date/array keys via IDB equivalence)
      // =========================================================================
      {
        const dbName = `test-inv10-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors');
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });

        const dKey1 = new Date(1700000001000);
        const dKey2 = new Date(1700000002000);
        const arrKey1 = ['groupX', 10];
        const arrKey2 = ['groupY', 20];

        await db.insert({ embedding: [1, 0] }, dKey1);
        await db.insert({ embedding: [0, 1] }, dKey2);
        await db.insert({ embedding: [0.9, 0.1] }, arrKey1);
        await db.insert({ embedding: [0.1, 0.9] }, arrKey2);

        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });

        // Query passing DIFFERENT object instances of the same Date and Array values in eligibleKeys
        const filterDate = new Date(1700000001000);
        const filterArr = ['groupX', 10];
        check(filterDate !== dKey1, 'Inv 10: distinct Date instance');
        check(filterArr !== arrKey1, 'Inv 10: distinct Array instance');

        const qRes = await db.querySideStore([1, 0], {
          epoch: 1,
          getEpoch: defaultGetEpoch,
          eligibleKeys: [filterDate, filterArr],
          limit: 10,
        });

        check(qRes.results.length === 2, `Inv 10: returned 2 matching results, got ${qRes.results.length}`);
        check(indexedDB.cmp(qRes.results[0].key, dKey1) === 0, 'Inv 10: result 0 matches dKey1 by IDB value equivalence');
        check(indexedDB.cmp(qRes.results[1].key, arrKey1) === 0, 'Inv 10: result 1 matches arrKey1 by IDB value equivalence');
        await db.close();
      }

      // Regression p4s: comma-delimited encodings used to alias distinct array keys.
      {
        const dbName = `test-p4s-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors');
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });
        const excluded = ['a,s:b', 'c'];
        const included = ['a', 'b,s:c'];
        check(indexedDB.cmp(excluded, included) !== 0, 'p4s: two keys are distinct in IndexedDB');
        await db.insert({ embedding: [1, 0] }, excluded);
        await db.insert({ embedding: [0.5, 0.5] }, included);
        await db.insert({ embedding: [0.9, 0.1] }, Infinity);
        await db.insert({ embedding: [0, 1] }, -Infinity);
        await db.buildSideStore({ getEpoch: defaultGetEpoch });
        const res = await db.querySideStore([1, 0], {
          epoch: 1, getEpoch: defaultGetEpoch, eligibleKeys: [included], candidateBudget: 1,
        });
        check(res.results.length === 1 && indexedDB.cmp(res.results[0].key, included) === 0,
          'p4s: only the eligible array key survives before truncation');
        const infinite = await db.querySideStore([1, 0], {
          epoch: 1, getEpoch: defaultGetEpoch, eligibleKeys: [Infinity], candidateBudget: 1,
        });
        check(infinite.results.length === 1 && indexedDB.cmp(infinite.results[0].key, Infinity) === 0,
          'e59: legal Infinity primary key matches without admitting -Infinity');
        let typoError;
        try {
          await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, treshold: 0.999 });
        } catch (error) { typoError = error; }
        check(typoError instanceof TypeError && typoError.message.includes('treshold'),
          '2st: querySideStore refuses unknown filter options');
        let buildTypo;
        try { await db.buildSideStore({ getEpoch: defaultGetEpoch, revsion: 1 }); }
        catch (error) { buildTypo = error; }
        check(buildTypo instanceof TypeError && buildTypo.message.includes('revsion'),
          '2st: buildSideStore refuses unknown revision options');
        let functionError;
        try {
          await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, eligibleKeys: () => true });
        } catch (error) { functionError = error; }
        check(functionError instanceof TypeError, 'p4s: function eligibility is rejected');
        // Regression o9g: an explicit `threshold: null` used to be read as "no threshold" here
        // while query() and queryCandidates() refused it, so a threshold computed as null came
        // back unfiltered from one entry point and threw from the others.
        let nullThresholdError;
        try {
          await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, threshold: null });
        } catch (error) { nullThresholdError = error; }
        check(nullThresholdError instanceof TypeError && nullThresholdError.message.includes('threshold'),
          `o9g: querySideStore refuses an explicit null threshold (got ${nullThresholdError?.constructor?.name ?? 'no error'}${nullThresholdError ? `: ${nullThresholdError.message}` : ''})`);
        // The refusal must not have cost the real filter: a numeric threshold still drops results.
        const unfiltered = await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, limit: 10 });
        const filtered = await db.querySideStore([1, 0], { epoch: 1, getEpoch: defaultGetEpoch, limit: 10, threshold: 0.999 });
        check(unfiltered.results.length > filtered.results.length, 'o9g: omitting threshold ranks the whole eligible set');
        check(filtered.results.length === 1 && filtered.results[0].similarity >= 0.999,
          `o9g: a numeric threshold still filters side-store results (got ${filtered.results.length})`);
        await db.close();
      }

      // =========================================================================
      // Invariant 11: Eligibility Before Truncation
      // =========================================================================
      {
        const dbName = `test-inv11-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { keyPath: 'id' });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });

        // Record 1 & 2 are high similarity but NOT eligible
        await db.insert({ id: 1, embedding: [1.0, 0.0] });
        await db.insert({ id: 2, embedding: [0.99, 0.01] });
        // Record 3 & 4 are lower similarity but ARE eligible
        await db.insert({ id: 3, embedding: [0.5, 0.5] });
        await db.insert({ id: 4, embedding: [0.4, 0.6] });

        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });

        // candidateBudget = 2, eligibleKeys = [3, 4]
        // If truncation happened before eligibility check, keys 1 & 2 would fill the budget and 3 & 4 would be lost.
        const res = await db.querySideStore([1.0, 0.0], {
          epoch: 1,
          getEpoch: defaultGetEpoch,
          candidateBudget: 2,
          eligibleKeys: [3, 4],
          limit: 2,
        });

        check(res.results.length === 2, `Inv 11: returned 2 eligible candidates, got ${res.results.length}`);
        check(res.results[0].key === 3, `Inv 11: rank 0 is key 3, got ${res.results[0].key}`);
        check(res.results[1].key === 4, `Inv 11: rank 1 is key 4, got ${res.results[1].key}`);
        await db.close();
      }

      // =========================================================================
      // Invariant 12: Candidate Budget Bounds
      // Fetch never exceeds candidateBudget records from the main store.
      // =========================================================================
      {
        const dbName = `test-inv12-${crypto.randomUUID()}`;
        databasesToClean.push(dbName);
        const raw = await openRaw(dbName, 1, (e) => {
          e.target.result.createObjectStore('vectors', { keyPath: 'id' });
          e.target.result.createObjectStore('codes');
        });
        raw.close();
        const db = new VectorDB({ dbName, objectStore: 'vectors', vectorPath: 'embedding' });

        for (let i = 1; i <= 20; i++) {
          await db.insert({ id: i, embedding: [i / 20, 1 - i / 20] });
        }

        await db.buildSideStore({ epoch: 1, getEpoch: defaultGetEpoch });

        const res = await db.querySideStore([1, 0], {
          epoch: 1,
          getEpoch: defaultGetEpoch,
          candidateBudget: 5,
          limit: 10,
        });

        check(res.info.recordsFetched === 5, `Inv 12: recordsFetched is 5 (bounded by budget), got ${res.info.recordsFetched}`);
        check(res.results.length === 5, `Inv 12: results length is 5 (bounded by budget), got ${res.results.length}`);
        await db.close();
      }

      return {
        checks: checks.length,
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

  console.log(`PASS: ${result.checks} checks in real browser verifying all 12 ADR 0001 invariants!`);
} finally {
  await page?.close();
  await new Promise((resolve) => server.close(resolve));
}
