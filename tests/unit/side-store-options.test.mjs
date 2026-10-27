// tests/unit/side-store-options.test.mjs — the three query entry points must agree on `threshold`.
//
// Every one of them validates `threshold` BEFORE opening the database, so the refusals are
// assertable in the fast unit tier, with no Chromium and no IndexedDB. That ordering is the point:
// an argument this library refuses must be refused before it can be read as "no threshold" and
// return an unfiltered ranking that looks filtered.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VectorDB } from '../../index.js';

// The unit tier has no IndexedDB, so this instance exists only to reach the option validation.
// Constructing it arms a pending open that WILL reject here, and `close()` disarms it before any
// assertion can await: an unhandled rejection would fail the whole runner. Closing also makes a
// query that passes validation fail deterministically with InvalidStateError, so "accepted" never
// depends on the host having a database.
const withValidatingOnlyDB = async (run) => {
  const db = new VectorDB({ dbName: 'unit-side-store-options', objectStore: 'vectors', vectorPath: 'embedding' });
  const closed = db.close().catch(() => {});
  try {
    return await run(db);
  } finally {
    await closed;
  }
};

const sideStoreQuery = (db, options) => db.querySideStore([1, 0], { epoch: 1, getEpoch: async () => 1, ...options });

test('an explicit threshold: null is refused by query(), queryCandidates() and querySideStore() alike', async () => {
  await withValidatingOnlyDB(async (db) => {
    const entryPoints = [
      ['query', () => db.query([1, 0], { threshold: null })],
      ['queryCandidates', () => db.queryCandidates([1, 0], { threshold: null })],
      ['querySideStore', () => sideStoreQuery(db, { threshold: null })],
    ];
    for (const [name, run] of entryPoints) {
      await assert.rejects(run, (error) => {
        assert.ok(
          error instanceof TypeError,
          `${name}() must reject an explicit null threshold with a TypeError; got ${error?.constructor?.name}: ${error?.message}`
        );
        assert.match(error.message, /threshold must be a finite number/);
        return true;
      }, `${name}() must not read an explicit threshold: null as "no threshold"`);
    }
  });
});

test('querySideStore() refuses the threshold values query() refuses, and does not refuse an omitted one', async () => {
  await withValidatingOnlyDB(async (db) => {
    const refusals = [
      ['a string', { threshold: '0.5' }, TypeError],
      ['above the cosine range', { threshold: 2 }, RangeError],
      ['below the cosine range', { threshold: -1.5 }, RangeError],
    ];
    for (const [label, options, expected] of refusals) {
      await assert.rejects(() => sideStoreQuery(db, options), expected, `querySideStore() must refuse a threshold that is ${label}`);
    }

    // Omitted — and explicitly undefined — means "no threshold". Those two spellings must clear
    // validation, so the only thing they may run into is the closed connection: never a threshold
    // error. Any threshold error here would mean a caller who omitted the option is being refused.
    for (const spelling of [{}, { threshold: undefined }]) {
      const outcome = await sideStoreQuery(db, spelling).then(
        () => ({ accepted: true }),
        (error) => ({ accepted: false, error })
      );
      if (!outcome.accepted) {
        const error = outcome.error;
        assert.ok(
          !(error instanceof TypeError || error instanceof RangeError) || /threshold/.test(error.message) === false,
          `an omitted threshold must not be refused: got ${error?.constructor?.name}: ${error?.message}`
        );
      }
    }
  });
});

test('querySideStore rejects on transaction abort without hanging (idb-vector-04e)', async () => {
  const orig = globalThis.indexedDB;
  try {
    let abortCodesTx = false;
    let abortVectorsTx = false;

    globalThis.indexedDB = {
      open() {
        const req = {};
        queueMicrotask(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            addEventListener() {},
            close() {},
            transaction(stores) {
              const tx = {
                error: null,
                objectStore() {
                  return { get() { return {}; } };
                },
              };
              if (stores.includes('codes') && abortCodesTx) {
                queueMicrotask(() => {
                  tx.error = new DOMException('Quota exceeded', 'QuotaExceededError');
                  tx.onabort?.();
                });
              }
              if (stores.includes('vectors') && abortVectorsTx) {
                queueMicrotask(() => {
                  tx.error = new DOMException('Transaction aborted', 'AbortError');
                  tx.onabort?.();
                });
              }
              return tx;
            },
          };
          req.onsuccess?.({ target: req });
        });
        return req;
      },
    };

    const db = new VectorDB({ dbName: 'test-abort', objectStore: 'vectors', vectorPath: 'embedding' });

    // 1. Abort during codeRecord fetch from side-store
    abortCodesTx = true;
    await assert.rejects(
      db.querySideStore([1, 0], { epoch: 1, getEpoch: async () => 1 }),
      (err) => err?.name === 'QuotaExceededError' || err?.message === 'Quota exceeded',
      'querySideStore must reject when side-store get transaction aborts',
    );
    abortCodesTx = false;

    // 2. Abort during candidate originals fetch from main store
    abortVectorsTx = true;
    const { buildCodeRecord } = await import('../../utils/side-store.js');
    const mockCodeRecord = buildCodeRecord([{ vector: [1, 0] }], { keys: ['k1'], epoch: 1 });
    await assert.rejects(
      db.querySideStore([1, 0], { epoch: 1, getEpoch: async () => 1, codeRecord: mockCodeRecord }),
      (err) => err?.name === 'AbortError' || /Transaction aborted/.test(err?.message),
      'querySideStore must reject when candidate fetch transaction aborts',
    );
  } finally {
    globalThis.indexedDB = orig;
  }
});

test('query() and buildSideStore() reject on transaction abort without hanging (idb-vector-b4h)', async () => {
  const orig = globalThis.indexedDB;
  try {
    globalThis.indexedDB = {
      open() {
        const req = {};
        queueMicrotask(() => {
          req.result = {
            objectStoreNames: { contains: () => true },
            addEventListener() {},
            close() {},
            transaction() {
              const tx = {
                error: null,
                objectStore() {
                  return {
                    get() { return {}; },
                    openCursor() { return {}; },
                    index() { return { openCursor() { return {}; } }; },
                  };
                },
              };
              queueMicrotask(() => {
                tx.error = new DOMException('Quota exceeded', 'QuotaExceededError');
                tx.onabort?.();
              });
              return tx;
            },
          };
          req.onsuccess?.({ target: req });
        });
        return req;
      },
    };

    const dbQuery = new VectorDB({ dbName: 'test-abort-query', objectStore: 'vectors', vectorPath: 'embedding' });
    await assert.rejects(
      dbQuery.query([1, 0], { limit: 1 }),
      (err) => err?.name === 'QuotaExceededError' || err?.message === 'Quota exceeded',
      'query() must reject when #rank cursor transaction aborts',
    );

    const dbBuild = new VectorDB({ dbName: 'test-abort-build', objectStore: 'vectors', vectorPath: 'embedding' });
    await assert.rejects(
      dbBuild.buildSideStore({ epoch: 1, getEpoch: async () => 1 }),
      (err) => err?.name === 'QuotaExceededError' || err?.message === 'Quota exceeded',
      'buildSideStore() must reject when source cursor transaction aborts',
    );
  } finally {
    globalThis.indexedDB = orig;
  }
});
