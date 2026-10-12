// tests/snapshot-isolation.mjs — snapshot isolation during cursor reads in a real browser
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

    const databasesToClean = [];

    try {
      // =========================================================================================
      // SNAPSHOT ISOLATION DURING CURSOR READS
      // Single transaction per cursor read guarantees atomic snapshot:
      // (a) concurrent delete on a second connection is blocked until read finishes;
      //     read sees deleted record, no holes, all unique keys.
      // (b) concurrent insert on a second connection is blocked until read finishes;
      //     returned set excludes concurrent inserts (no writes leak into snapshot),
      //     keys are unique.
      // =========================================================================================
      const ISO_RECORDS = 5000;
      const isoDbName = `snapshot-isolation-${crypto.randomUUID()}`;
      databasesToClean.push(isoDbName);
      const isoRaw = await openRaw(isoDbName, 1, (e) => {
        e.target.result.createObjectStore('vectors', { autoIncrement: true });
      });
      // Insert 5,000 tiny records (2D vectors)
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

      // (a) Delete variant: target key 4500
      const targetDeleteKey = 4500;
      let deleteReadFinished = false;
      let deleteWriteCompletedBeforeRead = null;
      let deleteReadCompletionTime = 0;
      let deleteWriteCompletionTime = 0;

      const deleteReadStart = performance.now();
      const deleteReadPromise = isoDB.query(isoVec, { limit: ISO_RECORDS }).then((rows) => {
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

      // (b) Insert variant: append records during cursor read
      let insertReadFinished = false;
      let insertWriteCompletedBeforeRead = null;
      let insertReadCompletionTime = 0;
      let insertWriteCompletionTime = 0;

      const insertReadStart = performance.now();
      const insertReadPromise = isoDB.query(isoVec, { limit: ISO_RECORDS + 100 }).then((rows) => {
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
      check(seenInserts.length === 0, 'snapshot isolation insert: no concurrent insert leaked into the snapshot');
      check(insertReadRows.every((r) => r.key <= ISO_RECORDS), 'snapshot isolation insert: all returned keys are pre-existing');
      check(insertReadRows.length === ISO_RECORDS - 1, `snapshot isolation insert: read returned exactly ${ISO_RECORDS - 1} pre-existing records, got ${insertReadRows.length}`);
      check(new Set(insertReadRows.map((r) => r.key)).size === insertReadRows.length, 'snapshot isolation insert: returned keys are unique');
      check(insertWriteCompletedBeforeRead === false, 'snapshot isolation insert: write did NOT complete before read completed');

      return {
        checks: checks.length,
        isolationReport: {
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
        },
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

  console.log(`PASS: ${result.checks} snapshot-isolation checks in a real browser`);
  console.log('Snapshot isolation timings:');
  console.log(`  Delete test: read ${result.isolationReport.deleteVariant.readMs.toFixed(1)} ms, write ${result.isolationReport.deleteVariant.writeMs.toFixed(1)} ms (write blocked: ${result.isolationReport.deleteVariant.writeBlocked})`);
  console.log(`  Insert test: read ${result.isolationReport.insertVariant.readMs.toFixed(1)} ms, write ${result.isolationReport.insertVariant.writeMs.toFixed(1)} ms (write blocked: ${result.isolationReport.insertVariant.writeBlocked})`);
} finally {
  await page?.close();
  await new Promise((resolve) => server.close(resolve));
}
