import assert from 'node:assert/strict';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  const evidence = await page.evaluate(async () => {
    const { VectorDB } = await import('/index.js');
    const name = `idb-vector-transactions-${crypto.randomUUID()}`;
    const db = new VectorDB({ dbName: name, vectorPath: 'embedding' });
    const open = (version) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const remove = () => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('delete remained blocked'));
    });
    const lookup = async key => {
      const connection = await open();
      try {
        return await new Promise((resolve, reject) => {
          const request = connection.transaction('vectors').objectStore('vectors').get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } finally { connection.close(); }
    };
    try {
      const initialKey = await db.insert({ embedding: [1, 0] });
      const updatedKey = await db.update(initialKey, { embedding: [0, 1] });
      if (updatedKey !== initialKey || (await lookup(initialKey)).embedding[1] !== 1) throw new Error('successful write missing');
      const aborts = [];
      for (const [method, args] of [
        ['insert', [{ embedding: [1, 1] }]],
        ['update', [initialKey, { embedding: [2, 0] }]],
        ['delete', [initialKey]],
      ]) {
        const native = IDBObjectStore.prototype[method === 'insert' ? 'add' : method === 'update' ? 'put' : 'delete'];
        const nativeName = method === 'insert' ? 'add' : method === 'update' ? 'put' : 'delete';
        let requestSucceeded = false;
        IDBObjectStore.prototype[nativeName] = function (...params) {
          const request = native.apply(this, params);
          request.addEventListener('success', () => {
            requestSucceeded = true;
            this.transaction.abort();
          });
          return request;
        };
        try {
          let outcome;
          try { outcome = { acknowledged: await db[method](...args) }; }
          catch (error) { outcome = { errorName: error.name }; }
          aborts.push({ method, requestSucceeded, ...outcome, value: await lookup(initialKey) });
        } finally { IDBObjectStore.prototype[nativeName] = native; }
      }
      const afterAbort = await lookup(initialKey);
      const deletedKey = await db.delete(initialKey);
      const afterDelete = await lookup(initialKey);

      // Hold an independent connection to exercise blocked upgrade. The library's
      // versionchange handler must release its own connection automatically.
      const blocker = await open();
      let versionchange = false;
      blocker.addEventListener('versionchange', () => { versionchange = true; });
      const upgrade = indexedDB.open(name, 2);
      const blocked = new Promise(resolve => { upgrade.onblocked = () => resolve(true); });
      const upgraded = new Promise((resolve, reject) => {
        upgrade.onsuccess = () => resolve(upgrade.result);
        upgrade.onerror = () => reject(upgrade.error);
      });
      const wasBlocked = await blocked;
      blocker.close();
      const next = await upgraded;
      next.close();
      let staleError;
      try { await db.query([1, 0]); } catch (error) { staleError = error.name; }
      await db.close();
      await db.close();
      await remove();
      let closedError;
      try { await db.insert({ embedding: [1, 0] }); } catch (error) { closedError = error.name; }
      return { initialKey, updatedKey, aborts, afterAbort, deletedKey, afterDelete,
        wasBlocked, versionchange, staleError, closedError, deletedDatabase: true };
    } finally { await db.close(); }
  });
  assert.equal(evidence.initialKey, evidence.updatedKey);
  assert.equal(evidence.aborts.length, 3);
  for (const attempt of evidence.aborts) {
    assert.equal(attempt.requestSucceeded, true, `${attempt.method} request did not succeed`);
    assert.equal(attempt.errorName, 'AbortError', `${attempt.method} acknowledged aborted write`);
    assert.equal(attempt.value.embedding[1], 1, `${attempt.method} persisted aborted write`);
  }
  assert.equal(evidence.afterAbort.embedding[1], 1);
  assert.equal(evidence.deletedKey, undefined);
  assert.equal(evidence.afterDelete, undefined);
  assert.equal(evidence.wasBlocked, true);
  assert.equal(evidence.versionchange, true);
  assert.equal(evidence.staleError, 'InvalidStateError');
  assert.equal(evidence.closedError, 'InvalidStateError');
  assert.equal(evidence.deletedDatabase, true);
  console.log('PASS: real Chromium request-success aborts rejected and rolled back (insert/update/delete); committed keys, blocked upgrade, versionchange, close and delete', JSON.stringify(evidence));
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
}
