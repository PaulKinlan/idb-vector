import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { serve } from '../tools/demo-server.mjs';
import { launch } from '../tests/lib/cdp.mjs';
import * as pure from '../test-harness/quantized-pass.js';

// idb-vector-kuc.9: measure an int8 code side-store with a bounded exact rerank END TO END on the
// IndexedDB read path. kuc.6 measured the legs separately and composed them; this drives the whole
// query: read the code record, scan it, fetch the top-N originals by key, rerank exactly.
// Research only: nothing here is part of the library API.

// IDB_KUC9_SMOKE=1 runs the same code path on a tiny corpus, to check the driver itself before
// spending a bounded gate run on 500 MB of IndexedDB writes.
const specs = process.env.IDB_KUC9_SMOKE
  ? [{ name: 'smoke-2k-32', count: 2000, dims: 32, seed: 42, budgets: [50, 100], repetitions: 1, predicate: true, revision: true }]
  : [
    { name: 'uniform-100k-128', count: 100000, dims: 128, seed: 42, budgets: [100, 300], repetitions: 3, predicate: true, revision: true },
    { name: 'uniform-100k-384', count: 100000, dims: 384, seed: 43, budgets: [100, 300], repetitions: 2 },
  ];
const smoke = Boolean(process.env.IDB_KUC9_SMOKE);
// A smoke run writes to a temp path: it is a check of the driver, and a tracked write during a gate
// records STALE even when the bytes are identical (idb-vector-2ox). The full-run path is the
// committed evidence and is written deliberately.
const jsonPath = smoke ? join(os.tmpdir(), 'idb-vector-side-store-query-smoke.json') : 'reports/side-store-query.json';
// One profile for the whole run: the warm phase writes its databases into it, and the cold phase
// reopens that same profile in a NEW browser process. A cold query is therefore one that a process
// which did not write the store runs before anything else (idb-vector-thu, round 2).
const profile = mkdtempSync(join(os.tmpdir(), 'idb-vector-kuc9-'));
const dbNames = specs.map(() => `kuc9-${crypto.randomUUID()}`);
const coldRow = 12345; // a corpus row used as a cold query vector; never one of the warm queries

// Pure-Node cross-check that the same module ranks a fetched candidate set exactly.
const tiny = pure.uniformCorpus(400, 32, 9, 3);
const tinyIds = Array.from({ length: 60 }, (_, i) => i * 5 % 400);
const { buildCodeRecord, rerankFetched } = await import('../test-harness/side-store.js');
const tinyRecord = buildCodeRecord(tiny.vectors, 400, 32);
assert.equal(tinyRecord.revision, 1);
for (const query of tiny.queries) {
  const fetched = tinyIds.map(id => ({ id, embedding: Float64Array.from(tiny.vectors.subarray(id * 32, (id + 1) * 32)) }));
  assert.equal(rerankFetched(fetched, query, 10, 32).length, 10);
}

// The cold phase. Each observation gets its own browser process on the profile the warm phase
// wrote, and its query vector is a corpus row the warm loop never queried. "Cold" means: a fresh
// process, a fresh IndexedDB connection, no query timed before this one in that process, and a store
// this process did not write. It is NOT disk-cold - the bytes were written moments ago and the OS
// page cache still holds them - which is why the definition is stated rather than implied.
async function coldObservation({ profile, url, dbName, path, kind, count, dims, seed, budget, masked, queryRow }) {
  // The previous process is gone by the time this runs, so a lock file left behind is stale. Removing
  // it here keeps a cold observation from failing for a reason that has nothing to do with the query.
  rmSync(join(profile, 'SingletonLock'), { force: true });
  const coldPage = await launch({ profile });
  browsers.add(coldPage);
  try {
    await coldPage.goto(url);
    return await coldPage.evaluate(async args => {
      const m = await import('/test-harness/quantized-pass.js');
      const { rerankFetched } = await import('/test-harness/side-store.js');
      const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
      const time = async fn => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };

      // The corpus is regenerated from its seed so the query vector and the oracle exist without
      // touching IndexedDB; generation happens outside every timer.
      const { vectors } = m.uniformCorpus(args.count, args.dims, args.seed, 1);
      const query = Float64Array.from(vectors.subarray(args.queryRow * args.dims, (args.queryRow + 1) * args.dims));
      const mask = args.masked ? m.eligibleMask(args.count, id => id % 100 === 7) : null;
      const oracle = m.exactTopK(vectors, args.count, args.dims, query, 10, mask);

      const open = indexedDB.open(args.dbName, 1);
      const db = await request(open);
      const fetchByIds = async ids => {
        const tx = db.transaction('rows');
        const store = tx.objectStore('rows');
        const rows = await Promise.all(ids.map(id => request(store.get(id))));
        await complete(tx);
        return rows;
      };
      const readCodeRecord = async () => {
        const tx = db.transaction('codes');
        const store = tx.objectStore('codes');
        const [rec, mk] = await Promise.all([request(store.get('record')), request(store.get('mask'))]);
        await complete(tx);
        return { rec, mk };
      };

      if (args.kind === 'legs' && args.path === 'codes') {
        const read = await time(readCodeRecord);
        // Unfiltered cold measurement scans everything, exactly as the warm unpredicated path does; the
        // stored mask is applied only for the masked observation (idb-vector-pun, round 3).
        const filter = args.masked ? read.value.mk : null;
        const scan = await time(() => m.sq8Scan(null, args.count, args.dims, read.value.rec, read.value.rec.norms, query, 300, filter));
        const ids = scan.value.map(row => row.index).slice(0, args.budget);
        const fetch = await time(() => fetchByIds(ids));
        const rerank = await time(() => rerankFetched(fetch.value, query, 10, args.dims));
        db.close();
        return {
          kind: 'legs', legs: { readAndMask: read.ms, scan: scan.ms, fetch: fetch.ms, rerank: rerank.ms },
          legSumMs: read.ms + scan.ms + fetch.ms + rerank.ms,
          recallAt10: m.recallAtK(rerank.value, oracle),
          eligibleRows: args.masked ? Array.prototype.reduce.call(read.value.mk, (sum, value) => sum + value, 0) : null,
          returnedRowsWithinStoredMask: args.masked ? rerank.value.every(row => read.value.mk[row.index] === 1) : null,
        };
      }
      if (args.kind === 'legs') {
        const read = await time(async () => {
          const tx = db.transaction('packed');
          const rec = await request(tx.objectStore('packed').get('f32'));
          await complete(tx);
          return rec;
        });
        const scan = await time(() => m.exactTopK(read.value, args.count, args.dims, query, 10, null));
        db.close();
        return { kind: 'legs', legs: { read: read.ms, scan: scan.ms }, legSumMs: read.ms + scan.ms, recallAt10: m.recallAtK(scan.value, oracle) };
      }
      // One whole-block observation: read, scan, key fetch and rerank inside a single timer.
      const whole = await time(async () => {
        if (args.path === 'packed') {
          const tx = db.transaction('packed');
          const rec = await request(tx.objectStore('packed').get('f32'));
          await complete(tx);
          return m.exactTopK(rec, args.count, args.dims, query, 10, null);
        }
        const { rec, mk } = await readCodeRecord();
        const scan = m.sq8Scan(null, args.count, args.dims, rec, rec.norms, query, 300, args.masked ? mk : null);
        const rows = await fetchByIds(scan.map(row => row.index).slice(0, args.budget));
        return rerankFetched(rows, query, 10, args.dims);
      });
      const { mk } = await readCodeRecord();
      db.close();
      return {
        kind: 'whole', wholeMs: whole.ms, recallAt10: m.recallAtK(whole.value, oracle),
        returnedRowsWithinStoredMask: args.masked ? whole.value.every(row => mk[row.index] === 1) : null,
      };
    }, { ...{ dbName, path, kind, count, dims, seed, budget, masked, queryRow } });
  } finally {
    browsers.delete(coldPage);
    await coldPage.close();
  }
}

// Every browser this script starts is tracked so a signal kills it instead of leaking it. launch()
// only installs a process 'exit' hook, and a SIGTERM with no handler does not run 'exit' hooks - and
// the browser is spawned detached, so it survives the script's process group. On 2026-10-12 that
// combination left a 45-minute Chrome behind when the gate's bound killed a hung run (reaper).
const browsers = new Set();
const closeBrowsers = async () => {
  for (const open of [...browsers]) {
    browsers.delete(open);
    await open.close().catch(() => {});
  }
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    console.error(`received ${signal}: closing ${browsers.size} browser(s)`);
    closeBrowsers().finally(() => process.exit(1));
  });
}

const { server, url } = await serve();
let page;
try {
  page = await launch({ profile });
  browsers.add(page);
  await page.goto(url);
  const results = await page.evaluate(async (specs, dbNames) => {
    const m = await import('/test-harness/quantized-pass.js');
    const { buildCodeRecord, rerankFetched } = await import('/test-harness/side-store.js');
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const time = async fn => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

    const out = [];
    for (const [specIndex, spec] of specs.entries()) {
      const { count, dims, seed } = spec;
      const { vectors, queries } = m.uniformCorpus(count, dims, seed, 10);
      const record = buildCodeRecord(vectors, count, dims, 1);
      const mask = m.eligibleMask(count, spec.predicate ? (id => id % 100 === 7) : null);
      const packed = vectors; // the packed snapshot is the corpus itself, stored as one record

      // One database per corpus: originals as individual records (the library's storage shape),
      // the code record, the eligibility mask, and a packed Float32 array for the snapshot path.
      const name = dbNames[specIndex];
      const open = indexedDB.open(name, 1);
      open.onupgradeneeded = () => { for (const store of ['rows', 'codes', 'packed']) open.result.createObjectStore(store); };
      const db = await request(open);
      const writeMs = await time(async () => {
        const packedTx = db.transaction('packed', 'readwrite');
        packedTx.objectStore('packed').put(packed, 'f32');
        const codesTx = db.transaction('codes', 'readwrite');
        codesTx.objectStore('codes').put(record, 'record');
        codesTx.objectStore('codes').put(mask, 'mask');
        await Promise.all([complete(packedTx), complete(codesTx)]);
        for (let offset = 0; offset < count; offset += 2000) {
          const tx = db.transaction('rows', 'readwrite');
          const store = tx.objectStore('rows');
          for (let id = offset; id < offset + 2000; id++) {
            store.put({ id, embedding: Float64Array.from(vectors.subarray(id * dims, (id + 1) * dims)) }, id);
          }
          await complete(tx);
        }
      });

      // Oracles from the resident vectors: the exact top-10, with and without eligibility.
      const oracle = queries.map(query => m.exactTopK(vectors, count, dims, query, 10, null));
      const oracleEligible = spec.predicate ? queries.map(query => m.exactTopK(vectors, count, dims, query, 10, mask)) : null;

      const readCodeRecord = async () => {
        const tx = db.transaction('codes');
        const store = tx.objectStore('codes');
        const [rec, mk] = await Promise.all([request(store.get('record')), request(store.get('mask'))]);
        await complete(tx);
        return { rec, mask: mk };
      };
      const fetchByIds = async ids => {
        const tx = db.transaction('rows');
        const store = tx.objectStore('rows');
        const rows = await Promise.all(ids.map(id => request(store.get(id))));
        await complete(tx);
        return rows;
      };
      const readStoredMask = async () => {
        const tx = db.transaction('codes');
        const value = await request(tx.objectStore('codes').get('mask'));
        await complete(tx);
        return value;
      };
      const scanRowsTop = (rows, query) => {
        let queryNorm = 0;
        for (let d = 0; d < dims; d++) queryNorm += query[d] * query[d];
        queryNorm = Math.sqrt(queryNorm) || 1;
        const top = [];
        for (const row of rows) {
          const embedding = row.embedding;
          let dot = 0, norm = 0;
          for (let d = 0; d < dims; d++) { const value = embedding[d]; dot += query[d] * value; norm += value * value; }
          const similarity = dot / (queryNorm * (Math.sqrt(norm) || 1));
          if (top.length < 10) { top.push({ index: row.id, similarity }); if (top.length === 10) top.sort((a, b) => b.similarity - a.similarity); }
          else if (similarity > top[9].similarity) { top[9] = { index: row.id, similarity }; top.sort((a, b) => b.similarity - a.similarity); }
        }
        return top;
      };

      const keep = Math.max(...spec.budgets);
      // Every leg is kept as a sample series so the report can state a cold value (the first query
      // of the run, before anything has read that record) and a warm-only summary (idb-vector-thu).
      const legs = Object.fromEntries(['codesRead', 'scan', 'fetch', 'rerank'].map(k => [k, []]));
      const perBudget = Object.fromEntries(spec.budgets.map(n => [n, { fetch: [], rerank: [], recall: [], ceiling: [], endToEnd: [], whole: [] }]));
      const freshChecks = [];
      let packedExactLegs = { read: [], scan: [] }, batchedExactMs = null;

      for (let rep = 0; rep < spec.repetitions; rep++) {
        for (let q = 0; q < queries.length; q++) {
          const query = queries[q];
          const codesRead = await time(readCodeRecord);
          const scan = await time(() => m.sq8Scan(null, count, dims, codesRead.value.rec, codesRead.value.rec.norms, query, keep, null));
          legs.codesRead.push(codesRead.ms);
          legs.scan.push(scan.ms);
          const candidateIds = scan.value.map(row => row.index);
          for (const budget of spec.budgets) {
            const ids = candidateIds.slice(0, budget);
            const fetch = await time(() => fetchByIds(ids));
            const rerank = await time(() => rerankFetched(fetch.value, query, 10, dims));
            legs.fetch.push(fetch.ms); legs.rerank.push(rerank.ms);
            const slot = perBudget[budget];
            slot.fetch.push(fetch.ms); slot.rerank.push(rerank.ms);
            slot.recall.push(m.recallAtK(rerank.value, oracle[q]));
            slot.ceiling.push(m.candidateCeiling(ids, oracle[q]));
            slot.endToEnd.push(codesRead.ms + scan.ms + fetch.ms + rerank.ms);
            // A whole-block observation for every query and budget, not one sample: read, scan,
            // key fetch and rerank inside a single timer (idb-vector-thu).
            const whole = await time(async () => {
              const rec = await readCodeRecord();
              const scan2 = m.sq8Scan(null, count, dims, rec.rec, rec.rec.norms, query, keep, null);
              const rows = await fetchByIds(scan2.map(row => row.index).slice(0, budget));
              return rerankFetched(rows, query, 10, dims);
            });
            slot.whole.push(whole.ms);
            slot.wholeRecall = slot.wholeRecall || [];
            slot.wholeRecall.push(m.recallAtK(whole.value, oracle[q]));
            // The fetched originals must be the stored rows, not a stale or wrong-width record.
            if (rep === 0 && q < 2) {
              const fetched = fetch.value.find(row => row && row.embedding);
              const expected = vectors.subarray(fetched.id * dims, (fetched.id + 1) * dims);
              let same = true;
              for (let d = 0; d < dims; d++) if (fetched.embedding[d] !== expected[d]) same = false;
              freshChecks.push({ id: fetched.id, dimensions: fetched.embedding.length, sameAsResident: same });
            }
          }
        }
      }

      // Path (a): the packed Float32 snapshot read plus the exact scan, timed per query.
      for (let rep = 0; rep < 2; rep++) for (const query of queries.slice(0, 3)) {
        const read = await time(() => request(db.transaction('packed').objectStore('packed').get('f32')));
        packedExactLegs.read.push(read.ms);
        const scan = await time(() => m.exactTopK(read.value, count, dims, query, 10, null));
        packedExactLegs.scan.push(scan.ms);
      }
      // Path (b): the library's batched page walk over individual records, one query.
      const batched = await time(async () => {
        const collected = [];
        for (let offset = 0; offset < count; offset += 2000) {
          const page_rows = await request(db.transaction('rows').objectStore('rows').getAll(IDBKeyRange.lowerBound(offset), 2000));
          if (!page_rows.length) break;
          collected.push(...page_rows);
        }
        return scanRowsTop(collected, queries[0]);
      });
      batchedExactMs = batched.ms;

      // Cold (first query of the run, nothing has read the record yet) and warm-only (the rest)
      // summaries for every leg and for the whole-block observations (idb-vector-thu).
      // Two different things, kept apart on purpose (idb-vector-thu, round 2):
      // - firstRead: the first read of that record IN THIS PROCESS. It follows the corpus write, so it
      //   is a cache-first read, not a cold one, and it is never presented as cold.
      // - warmRepeats: whole-block observations of a query that the legs above already ran, so every
      //   sample is a repeat. The genuinely cold numbers come from the separate cold phase.
      const firstRead = values => ({
        firstReadMs: values[0],
        warmMedianMs: values.length > 1 ? median(values.slice(1)) : null,
        warmSamples: values.length > 1 ? values.slice(1) : [],
        samples: values.length,
      });
      const warmRepeats = values => ({
        firstRepeatMs: values[0],
        warmMedianMs: values.length > 1 ? median(values.slice(1)) : null,
        samples: values.length,
      });

      const summary = {
        name: spec.name, count, dims, seeds: seed, budgets: spec.budgets, queries: queries.length,
        repetitions: spec.repetitions,
        writeMs: writeMs.ms,
        bytes: { rows: count * dims * 8, packedF32: count * dims * 4, codes: record.bytes, mask: count },
        sideStore: {
          codesReadMsMedian: median(legs.codesRead), scanMsMedian: median(legs.scan),
          fetchMsMedian: Object.fromEntries(spec.budgets.map(n => [n, median(perBudget[n].fetch)])),
          rerankMsMedian: Object.fromEntries(spec.budgets.map(n => [n, median(perBudget[n].rerank)])),
          endToEndMsMedian: Object.fromEntries(spec.budgets.map(n => [n, median(perBudget[n].endToEnd)])),
          warmOnlyEndToEndMsMedian: Object.fromEntries(spec.budgets.map(n => [n, median(perBudget[n].endToEnd.slice(1))])),
          perLeg: {
            codesRead: firstRead(legs.codesRead),
            scan: firstRead(legs.scan),
            fetch: Object.fromEntries(spec.budgets.map(n => [n, firstRead(perBudget[n].fetch)])),
            rerank: Object.fromEntries(spec.budgets.map(n => [n, firstRead(perBudget[n].rerank)])),
          },
          wholeBlock: Object.fromEntries(spec.budgets.map(n => [n, warmRepeats(perBudget[n].whole)])),
          wholeBlockRecallMean: Object.fromEntries(spec.budgets.map(n => [n, perBudget[n].wholeRecall.reduce((a, b) => a + b, 0) / perBudget[n].wholeRecall.length])),
          recallAt10Mean: Object.fromEntries(spec.budgets.map(n => [n, perBudget[n].recall.reduce((a, b) => a + b, 0) / perBudget[n].recall.length])),
          candidateCeilingMean: Object.fromEntries(spec.budgets.map(n => [n, perBudget[n].ceiling.reduce((a, b) => a + b, 0) / perBudget[n].ceiling.length])),
        },
        packedExact: {
          readMsMedian: median(packedExactLegs.read), scanMsMedian: median(packedExactLegs.scan),
          endToEndMsMedian: median(packedExactLegs.read) + median(packedExactLegs.scan),
          perLeg: { read: firstRead(packedExactLegs.read), scan: firstRead(packedExactLegs.scan) },
        },
        batchedExact: { queries: 1, endToEndMs: batchedExactMs },
        fetchedRowsVerified: freshChecks,
      };

      if (spec.predicate) {
        // Paired filtered comparison (idb-vector-pun, rounds 1 and 2). Every leg reads its
        // eligibility from IndexedDB inside its own timed query: the codes path uses the mask that
        // travels with the code record, and the exact-by-key and packed paths read the stored mask
        // record and derive their eligible ids from THAT value. No leg is filtered by a resident
        // precomputed array, and the negative control at the end mutates the stored mask to prove it.
        const storedMask = await readStoredMask();
        let storedMaskBytesDiffering = 0;
        for (let id = 0; id < count; id++) if ((storedMask[id] ? 1 : 0) !== (mask[id] ? 1 : 0)) storedMaskBytesDiffering++;
        const legsPredicate = { maskRead: [], scan: [], fetch: [], rerank: [], endToEnd: [], whole: [], recall: [], ceiling: [], withinMask: [] };
        const legsExactEligible = { eligibleIdRead: [], fetch: [], rerank: [], endToEnd: [], whole: [], recall: [], withinMask: [] };
        const legsPackedMasked = { read: [], maskRead: [], scan: [], endToEnd: [], whole: [], recall: [], withinMask: [] };
        for (let rep = 0; rep < spec.repetitions; rep++) for (const query of queries) {
          const q = queries.indexOf(query);
          // (i) side-store: read the code record and its mask, masked scan, fetch the top-300 by key, rerank.
          const rec = await time(readCodeRecord);
          const scan = await time(() => m.sq8Scan(null, count, dims, rec.value.rec, rec.value.rec.norms, query, keep, rec.value.mask));
          const ids = scan.value.map(row => row.index).slice(0, 300);
          const fetch = await time(() => fetchByIds(ids));
          const rerank = await time(() => rerankFetched(fetch.value, query, 10, dims));
          legsPredicate.maskRead.push(rec.ms); legsPredicate.scan.push(scan.ms);
          legsPredicate.fetch.push(fetch.ms); legsPredicate.rerank.push(rerank.ms);
          legsPredicate.endToEnd.push(rec.ms + scan.ms + fetch.ms + rerank.ms);
          legsPredicate.recall.push(m.recallAtK(rerank.value, oracleEligible[q]));
          legsPredicate.ceiling.push(m.candidateCeiling(ids, oracleEligible[q]));
          legsPredicate.withinMask.push(rerank.value.every(row => rec.value.mask[row.index] === 1));
          const sideWhole = await time(async () => {
            const r = await readCodeRecord();
            const s = m.sq8Scan(null, count, dims, r.rec, r.rec.norms, query, keep, r.mask);
            const rows = await fetchByIds(s.map(row => row.index).slice(0, 300));
            return rerankFetched(rows, query, 10, dims);
          });
          legsPredicate.whole.push(sideWhole.ms);
          // (ii) exact over the eligible originals: read the stored mask, take the eligible ids from
          // THAT value, fetch all of them in one transaction, rank exactly in Float64.
          const exactMask = await time(async () => {
            const mk = await readStoredMask();
            const eligible = [];
            for (let id = 0; id < count; id++) if (mk[id]) eligible.push(id);
            return { mk, eligible };
          });
          const exactFetch = await time(() => fetchByIds(exactMask.value.eligible));
          const exactRerank = await time(() => rerankFetched(exactFetch.value, query, 10, dims));
          legsExactEligible.eligibleIdRead.push(exactMask.ms);
          legsExactEligible.fetch.push(exactFetch.ms); legsExactEligible.rerank.push(exactRerank.ms);
          legsExactEligible.endToEnd.push(exactMask.ms + exactFetch.ms + exactRerank.ms);
          legsExactEligible.recall.push(m.recallAtK(exactRerank.value, oracleEligible[q]));
          legsExactEligible.withinMask.push(exactRerank.value.every(row => exactMask.value.mk[row.index] === 1));
          const exactWhole = await time(async () => {
            const mk = await readStoredMask();
            const eligible = [];
            for (let id = 0; id < count; id++) if (mk[id]) eligible.push(id);
            const rows = await fetchByIds(eligible);
            return rerankFetched(rows, query, 10, dims);
          });
          legsExactEligible.whole.push(exactWhole.ms);
          // (iii) the packed Float32 record and the stored mask, each read from IndexedDB.
          const packedRead = await time(async () => {
            const tx = db.transaction('packed');
            const value = await request(tx.objectStore('packed').get('f32'));
            await complete(tx);
            return value;
          });
          const packedMask = await time(readStoredMask);
          const packedScan = await time(() => m.exactTopK(packedRead.value, count, dims, query, 10, packedMask.value));
          legsPackedMasked.read.push(packedRead.ms); legsPackedMasked.maskRead.push(packedMask.ms);
          legsPackedMasked.scan.push(packedScan.ms);
          legsPackedMasked.endToEnd.push(packedRead.ms + packedMask.ms + packedScan.ms);
          legsPackedMasked.recall.push(m.recallAtK(packedScan.value, oracleEligible[q]));
          legsPackedMasked.withinMask.push(packedScan.value.every(row => packedMask.value[row.index] === 1));
          const packedWhole = await time(async () => {
            const tx = db.transaction('packed');
            const rec2 = await request(tx.objectStore('packed').get('f32'));
            await complete(tx);
            const mk = await readStoredMask();
            return m.exactTopK(rec2, count, dims, query, 10, mk);
          });
          legsPackedMasked.whole.push(packedWhole.ms);
        }

        // Negative control: store a DIFFERENT mask and run all three legs against it. Each leg derives
        // its eligibility from whatever mask IndexedDB serves, so each must return a different top-10
        // and nothing outside that mask. A leg that quietly used the resident array would come back
        // identical to the baseline, which is the false-green this control exists to catch.
        const probeMask = m.eligibleMask(count, id => id % 100 === 8);
        const probeTx = db.transaction('codes', 'readwrite');
        probeTx.objectStore('codes').put(probeMask, 'mask-probe');
        await complete(probeTx);
        const readProbeMask = async () => {
          const tx = db.transaction('codes');
          const value = await request(tx.objectStore('codes').get('mask-probe'));
          await complete(tx);
          return value;
        };
        const probeQuery = queries[0];
        const probeOracle = m.exactTopK(vectors, count, dims, probeQuery, 10, probeMask);
        const legTop10 = async mk => {
          const { rec } = await readCodeRecord();
          const codesIds = m.sq8Scan(null, count, dims, rec, rec.norms, probeQuery, keep, mk).map(row => row.index).slice(0, 300);
          const codesTop = rerankFetched(await fetchByIds(codesIds), probeQuery, 10, dims).map(row => row.index);
          const eligible = [];
          for (let id = 0; id < count; id++) if (mk[id]) eligible.push(id);
          const exactTop = rerankFetched(await fetchByIds(eligible), probeQuery, 10, dims).map(row => row.index);
          const packedTx = db.transaction('packed');
          const packedRec = await request(packedTx.objectStore('packed').get('f32'));
          await complete(packedTx);
          const packedTop = m.exactTopK(packedRec, count, dims, probeQuery, 10, mk).map(row => row.index);
          return { codesTop, exactTop, packedTop };
        };
        const servedMask = await readProbeMask();
        const probeServedMatches = servedMask.every((value, id) => (value ? 1 : 0) === (probeMask[id] ? 1 : 0));
        const baselineTop = await legTop10(storedMask);
        const probeTop = await legTop10(servedMask);
        const key = ids => [...ids].sort((a, b) => a - b).join(',');
        const oracleKey = key(probeOracle.map(row => row.index));
        const maskProbe = { storedMaskBytesDiffering, probeEligibleRows: probeMask.reduce((sum, value) => sum + value, 0), probeServedMatchesStored: probeServedMatches, legs: {} };
        for (const leg of ['codesTop', 'exactTop', 'packedTop']) {
          maskProbe.legs[leg] = {
            baselineTop10: key(baselineTop[leg]),
            probeTop10: key(probeTop[leg]),
            changedUnderProbeMask: key(baselineTop[leg]) !== key(probeTop[leg]),
            probeWithinProbeMask: probeTop[leg].every(id => servedMask[id] === 1),
            probeMatchesProbeOracle: key(probeTop[leg]) === oracleKey,
          };
        }

        const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
        const eligible = mask.reduce((sum, value) => sum + value, 0);
        summary.predicate = {
          eligibleRows: eligible, selectivity: eligible / count, budget: 300,
          maskProbe,
          sideStore: {
            scanMsMedian: median(legsPredicate.scan), fetchMsMedian: median(legsPredicate.fetch),
            endToEndMsMedian: median(legsPredicate.endToEnd),
            warmOnlyEndToEndMsMedian: median(legsPredicate.endToEnd.slice(1)),
            wholeBlock: warmRepeats(legsPredicate.whole),
            perLeg: {
              maskRead: firstRead(legsPredicate.maskRead), scan: firstRead(legsPredicate.scan),
              fetch: firstRead(legsPredicate.fetch), rerank: firstRead(legsPredicate.rerank),
            },
            recallAt10Mean: mean(legsPredicate.recall),
            candidateCeilingMean: mean(legsPredicate.ceiling),
            allReturnedRowsWithinStoredMask: legsPredicate.withinMask.every(Boolean),
          },
          exactEligibleByKey: {
            fetchMsMedian: median(legsExactEligible.fetch), rerankMsMedian: median(legsExactEligible.rerank),
            eligibleIdReadMsMedian: median(legsExactEligible.eligibleIdRead),
            endToEndMsMedian: median(legsExactEligible.endToEnd),
            warmOnlyEndToEndMsMedian: median(legsExactEligible.endToEnd.slice(1)),
            wholeBlock: warmRepeats(legsExactEligible.whole),
            perLeg: {
              eligibleIdRead: firstRead(legsExactEligible.eligibleIdRead),
              fetch: firstRead(legsExactEligible.fetch),
              rerank: firstRead(legsExactEligible.rerank),
            },
            recallAt10Mean: mean(legsExactEligible.recall),
            allReturnedRowsWithinStoredMask: legsExactEligible.withinMask.every(Boolean),
          },
          packedExactMasked: {
            readMsMedian: median(legsPackedMasked.read), maskReadMsMedian: median(legsPackedMasked.maskRead),
            scanMsMedian: median(legsPackedMasked.scan),
            endToEndMsMedian: median(legsPackedMasked.endToEnd),
            warmOnlyEndToEndMsMedian: median(legsPackedMasked.endToEnd.slice(1)),
            wholeBlock: warmRepeats(legsPackedMasked.whole),
            perLeg: { read: firstRead(legsPackedMasked.read), maskRead: firstRead(legsPackedMasked.maskRead), scan: firstRead(legsPackedMasked.scan) },
            recallAt10Mean: mean(legsPackedMasked.recall),
            allReturnedRowsWithinStoredMask: legsPackedMasked.withinMask.every(Boolean),
          },
        };
      }

      if (spec.revision) {
        // The revision experiment gets its OWN database. Mutating the main one here would leave the
        // cold phase measuring a store that no longer matches the corpus it describes (a quarter of
        // the rows gone and their codes zeroed), which is the kind of mismatch this review has been
        // catching. So a second database holds the live rows (75,000 of 100,000), the revision-2
        // code record and the live mask, and the main database is left exactly as written.
        const deleted = [];
        for (let id = 0; id < count; id++) if (id % 4 === 0) deleted.push(id);
        const gone = new Set(deleted);
        const revName = `${name}-rev`;
        const revOpen = indexedDB.open(revName, 1);
        revOpen.onupgradeneeded = () => { for (const store of ['rows', 'codes']) revOpen.result.createObjectStore(store); };
        const revDb = await request(revOpen);
        const revisionWriteMs = await time(async () => {
          const record2 = { ...record, revision: 2, codes: record.codes.slice() };
          for (const id of deleted) record2.codes.fill(0, id * dims, (id + 1) * dims);
          // The live mask is its own record: the predicate leg's mask is a different thing and must
          // not be confused with "which rows still exist in this revision".
          const write2 = revDb.transaction('codes', 'readwrite');
          write2.objectStore('codes').put(record2, 'record');
          write2.objectStore('codes').put(m.eligibleMask(count, id => !gone.has(id)), 'mask-live');
          await complete(write2);
          for (let offset = 0; offset < count; offset += 2000) {
            const tx = revDb.transaction('rows', 'readwrite');
            const store = tx.objectStore('rows');
            for (let id = offset; id < offset + 2000; id++) {
              if (gone.has(id)) continue;
              store.put({ id, embedding: Float64Array.from(vectors.subarray(id * dims, (id + 1) * dims)) }, id);
            }
            await complete(tx);
          }
        });
        const fetchRevByIds = async ids => {
          const tx = revDb.transaction('rows');
          const store = tx.objectStore('rows');
          const rows = await Promise.all(ids.map(id => request(store.get(id))));
          await complete(tx);
          return rows;
        };
        const liveOracle = queries.map(query => m.exactTopK(vectors, count, dims, query, 10, m.eligibleMask(count, id => !gone.has(id))));
        const revisionLegs = { current: [], stale: [], staleFetched: 0, currentFetched: 0 };
        for (const query of queries) {
          const current = await time(async () => {
            const tx = revDb.transaction('codes');
            const store = tx.objectStore('codes');
            const [rec, live] = await Promise.all([request(store.get('record')), request(store.get('mask-live'))]);
            await complete(tx);
            return { rec, mask: live };
          });
          if (current.value.rec.revision !== 2) throw new Error(`side-store served revision ${current.value.rec.revision}, expected 2`);
          const scan = m.sq8Scan(null, count, dims, current.value.rec, current.value.rec.norms, query, keep, current.value.mask);
          const ids = scan.map(row => row.index).slice(0, 300);
          const rows = await fetchRevByIds(ids);
          revisionLegs.currentFetched += rows.filter(row => !row).length;
          revisionLegs.current.push(m.recallAtK(rerankFetched(rows, query, 10, dims), liveOracle[queries.indexOf(query)]));
          // The stale revision is the record a query would have served before the update: it still
          // names the deleted rows, and the fetch for them returns nothing from this store.
          const staleScan = m.sq8Scan(null, count, dims, record, record.norms, query, keep, null);
          const staleIds = staleScan.map(row => row.index).slice(0, 300);
          const staleRows = await fetchRevByIds(staleIds);
          revisionLegs.staleFetched += staleRows.filter(row => !row).length;
          revisionLegs.stale.push(m.recallAtK(rerankFetched(staleRows, query, 10, dims), liveOracle[queries.indexOf(query)]));
        }
        revDb.close();
        summary.revision = {
          deletedRows: deleted.length,
          currentRevision: 2,
          revisionDatabase: revName,
          revisionWriteMs: revisionWriteMs.ms,
          currentRecallAt10Mean: revisionLegs.current.reduce((a, b) => a + b, 0) / revisionLegs.current.length,
          staleRecallAt10Mean: revisionLegs.stale.reduce((a, b) => a + b, 0) / revisionLegs.stale.length,
          missingRecordsInCurrentFetch: revisionLegs.currentFetched,
          missingRecordsInStaleFetch: revisionLegs.staleFetched,
        };
      }

      summary.dbName = name;
      out.push(summary);
      // The database is deliberately left in place: the cold phase reopens this profile in a fresh
      // browser process, and the profile directory is removed at the end of the run.
      db.close();
    }
    return out;
  }, specs, dbNames);

  // The warm browser must be gone before a cold process can own the same profile: two Chrome
  // processes on one --user-data-dir deadlock on the profile lock (observed - the first cold
  // observation hung until the gate bound killed it).
  const browserVersion = await page.send('Browser.getVersion');
  browsers.delete(page);
  await page.close();
  page = null;
  console.error(`warm phase done: ${results.length} corpus(es) measured; warm browser closed`);
  assert.equal(results.length, specs.length);
  for (const result of results) {
    const topBudget = Math.max(...result.budgets);
    assert.ok(result.sideStore.recallAt10Mean[topBudget] >= 0.9, `${result.name} recall@${topBudget}`);
    for (const budget of result.budgets) {
      const recall = result.sideStore.recallAt10Mean[budget];
      const ceiling = result.sideStore.candidateCeilingMean[budget];
      assert.ok(recall >= 0 && recall <= ceiling + 1e-12, `${result.name} recall@${budget} above ceiling`);
      assert.ok(result.sideStore.endToEndMsMedian[budget] > 0, `${result.name} end-to-end@${budget}`);
      assert.ok(result.sideStore.warmOnlyEndToEndMsMedian[budget] > 0, `${result.name} warm end-to-end@${budget}`);
      // Per-leg first-read and warm-only medians, and warm whole-block repeats (idb-vector-thu).
      const expected = result.repetitions * result.queries;
      const whole = result.sideStore.wholeBlock[budget];
      assert.equal(whole.samples, expected, `${result.name} whole-block samples@${budget}`);
      assert.ok(whole.firstRepeatMs > 0 && whole.warmMedianMs > 0, `${result.name} whole-block repeats@${budget}`);
      assert.ok(result.sideStore.wholeBlockRecallMean[budget] >= result.sideStore.recallAt10Mean[budget] - 1e-9);
      for (const [leg, series] of [['codesRead', result.sideStore.perLeg.codesRead], ['scan', result.sideStore.perLeg.scan],
        ['fetch', result.sideStore.perLeg.fetch[budget]], ['rerank', result.sideStore.perLeg.rerank[budget]]]) {
        assert.equal(series.samples, expected, `${result.name} ${leg} samples`);
        assert.ok(series.firstReadMs >= 0 && series.warmMedianMs >= 0, `${result.name} ${leg} first-read/warm`);
      }
    }
    for (const check of result.fetchedRowsVerified) {
      assert.equal(check.sameAsResident, true, `${result.name} fetched row ${check.id} differs from the stored vector`);
      assert.equal(check.dimensions, result.dims);
    }
    assert.ok(result.packedExact.endToEndMsMedian > 0 && result.batchedExact.endToEndMs > 0);
    assert.ok(result.packedExact.perLeg.read.firstReadMs > 0 && result.packedExact.perLeg.read.warmMedianMs > 0);
    if (result.predicate) {
      assert.equal(result.predicate.eligibleRows, smoke ? 20 : 1000);
      // Three paired IndexedDB alternatives, every one of them reading its eligibility from the
      // store (idb-vector-pun). The exact paths are exact by construction, so their recall must be 1.
      for (const [name, path] of [['sideStore', result.predicate.sideStore], ['exactEligibleByKey', result.predicate.exactEligibleByKey], ['packedExactMasked', result.predicate.packedExactMasked]]) {
        assert.ok(path.recallAt10Mean >= 0.99, `${name} filtered recall ${path.recallAt10Mean}`);
        assert.ok(path.endToEndMsMedian > 0 && path.warmOnlyEndToEndMsMedian > 0, `${name} filtered end-to-end`);
        assert.equal(path.wholeBlock.samples, result.repetitions * result.queries, `${name} filtered whole-block samples`);
        assert.ok(path.wholeBlock.firstRepeatMs > 0 && path.wholeBlock.warmMedianMs > 0, `${name} filtered whole-block repeats`);
        for (const series of Object.values(path.perLeg)) assert.ok(series.firstReadMs >= 0 && series.warmMedianMs >= 0, `${name} filtered per-leg first-read/warm`);
        assert.equal(path.allReturnedRowsWithinStoredMask, true, `${name} returned a row outside the stored eligibility mask`);
      }
      assert.equal(result.predicate.sideStore.candidateCeilingMean, 1);
      // The negative control. If any leg ignored the stored mask, its probe top-10 would equal the
      // baseline top-10 and this fails (idb-vector-pun, round 2).
      const probe = result.predicate.maskProbe;
      assert.equal(probe.storedMaskBytesDiffering, 0, 'the stored mask does not match the resident mask');
      assert.equal(probe.probeServedMatchesStored, true, 'the probe mask was not served back by IndexedDB');
      assert.equal(probe.probeEligibleRows, smoke ? 20 : 1000);
      for (const [leg, check] of Object.entries(probe.legs)) {
        assert.equal(check.changedUnderProbeMask, true, `${leg} did not respond to a different stored mask`);
        assert.equal(check.probeWithinProbeMask, true, `${leg} returned a row outside the probe mask`);
        assert.equal(check.probeMatchesProbeOracle, true, `${leg} did not match the oracle of the probe mask`);
      }
    }
    if (result.revision) {
      // Structural, not a recall threshold: the current revision must never fetch a deleted row,
      // and the stale one must actually reference deleted rows (that is the failure being measured).
      assert.equal(result.revision.missingRecordsInCurrentFetch, 0, 'a current-revision fetch must not hit a deleted row');
      assert.ok(result.revision.missingRecordsInStaleFetch > 0, 'the stale revision should reference deleted rows');
      assert.ok(result.revision.currentRecallAt10Mean >= 0.9, `current revision recall ${result.revision.currentRecallAt10Mean}`);
      assert.ok(result.revision.staleRecallAt10Mean >= 0 && result.revision.staleRecallAt10Mean <= 1);
    }
  }

  // Cold phase: a fresh browser process per observation, over the profile the warm phase wrote.
  const cold = {};
  for (const [index, result] of results.entries()) {
    const spec = specs[index];
    // A query vector that the warm loop never issued: a corpus row, clamped so small corpora still
    // have one (the smoke corpus has 2,000 rows, not 12,345).
    const queryRow = Math.min(coldRow, result.count - 1);
    const base = { profile, url, dbName: result.dbName, count: result.count, dims: result.dims, seed: spec.seed, queryRow, masked: false };
    const perSpec = { codes: {}, packed: {}, masked: null };
    for (const budget of result.budgets) {
      perSpec.codes[budget] = {};
      for (const kind of ['legs', 'whole']) {
        console.error(`cold: ${result.name} codes N=${budget} ${kind} ...`);
        perSpec.codes[budget][kind] = await coldObservation({ ...base, path: 'codes', budget, kind });
      }
    }
    for (const kind of ['legs', 'whole']) {
      console.error(`cold: ${result.name} packed ${kind} ...`);
      perSpec.packed[kind] = await coldObservation({ ...base, path: 'packed', budget: 0, kind });
    }
    if (spec.predicate) {
      perSpec.masked = {};
      for (const kind of ['legs', 'whole']) {
        console.error(`cold: ${result.name} masked N=${Math.max(...result.budgets)} ${kind} ...`);
        perSpec.masked[kind] = await coldObservation({ ...base, path: 'codes', budget: Math.max(...result.budgets), masked: true, kind });
      }
    }
    cold[result.name] = perSpec;
    for (const budget of result.budgets) {
      const legs = perSpec.codes[budget].legs, whole = perSpec.codes[budget].whole;
      assert.ok(legs.legSumMs > 0 && whole.wholeMs > 0, `${result.name} cold codes@${budget} did not time`);
      // The unfiltered cold path must scan the whole corpus: no stored-mask claim applies to it.
      assert.equal(legs.eligibleRows, null);
      assert.ok(legs.recallAt10 >= 0.9, `${result.name} cold codes recall@${budget} = ${legs.recallAt10}`);
      assert.ok(whole.recallAt10 >= 0.9, `${result.name} cold whole recall@${budget} = ${whole.recallAt10}`);
    }
    assert.ok(perSpec.packed.legs.legSumMs > 0 && perSpec.packed.whole.wholeMs > 0, `${result.name} cold packed did not time`);
    assert.ok(perSpec.packed.legs.recallAt10 >= 0.99 && perSpec.packed.whole.recallAt10 >= 0.99);
    if (spec.predicate) {
      assert.ok(perSpec.masked.legs.legSumMs > 0 && perSpec.masked.whole.wholeMs > 0, `${result.name} cold masked did not time`);
      assert.equal(perSpec.masked.legs.returnedRowsWithinStoredMask, true, 'the cold masked leg ignored the stored mask');
      assert.ok(perSpec.masked.legs.recallAt10 >= 0.9, `${result.name} cold masked recall ${perSpec.masked.legs.recallAt10}`);
    }
  }

  const report = {
    observedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    diff: execFileSync('git', ['diff', '--stat']).toString().trim(),
    browser: browserVersion,
    cpu: os.cpus()[0].model, load: os.loadavg(),
    coldDefinition: 'A cold observation is a single query run in a NEW browser process on the profile the warm phase wrote: fresh process, fresh IndexedDB connection, no query timed before it in that process, and a query vector (corpus row 12345) that the warm loop never issued. It is not disk-cold - the bytes were written moments earlier and the OS page cache still holds them - so it is a process-cold and cache-first-read-cold value, nothing stronger.',
    firstReadDefinition: 'perLeg firstReadMs is the first read of that record in the warm process, immediately after the corpus write: a cache-first read, NOT a cold one. No cold figure in this report is taken from the warm loop.',
    conditions: 'Warm phase: one timed query per (corpus, query, budget) - read the code record and the eligibility mask from IndexedDB, scan the int8 codes, fetch the top-N originals by key in a single readonly transaction, rerank exactly in Float64. Originals are stored as 100,000 individual { id, embedding } records (Float64Array), the codes as one packed record; one fresh database per corpus, writes completed before any timing. Oracles are computed from the resident vectors. 3 order-rotated repetitions at 128 dimensions and 2 at 384. The 1%-predicate leg is a paired comparison inside the warm run: the int8 codes path, an exact path over the eligible originals fetched by key, and the packed Float32 record plus a masked exact scan - every one of them deriving eligibility from the stored mask record, with a negative control that re-runs all three legs against a different stored mask. The cold phase then repeats the unpredicated codes and packed paths (and the masked codes path) in fresh browser processes.',
    nodeCrosscheck: { buildCodeRecordRevision: tinyRecord.revision, fetchedRerankLength: rerankFetched(tinyIds.map(id => ({ id, embedding: Float64Array.from(tiny.vectors.subarray(id * 32, (id + 1) * 32)) })), tiny.queries[0], 10, 32).length },
    results,
    cold,
  };
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n');
  for (const result of results) {
    const s = result.sideStore;
    console.log(`${result.name} (n=${result.count}, d=${result.dims}): codes read ${s.codesReadMsMedian.toFixed(1)}ms (first read ${s.perLeg.codesRead.firstReadMs.toFixed(1)}) | scan ${s.scanMsMedian.toFixed(1)}ms | ` +
      result.budgets.map(n => `N=${n} fetch ${s.fetchMsMedian[n].toFixed(1)}ms rerank ${s.rerankMsMedian[n].toFixed(1)}ms end-to-end ${s.endToEndMsMedian[n].toFixed(1)}ms warm-only ${s.warmOnlyEndToEndMsMedian[n].toFixed(1)}ms whole repeats first ${s.wholeBlock[n].firstRepeatMs.toFixed(1)} / warm ${s.wholeBlock[n].warmMedianMs.toFixed(1)}ms r@10=${s.recallAt10Mean[n].toFixed(3)}`).join(' | ') +
      ` | packed f32 + exact ${result.packedExact.endToEndMsMedian.toFixed(1)}ms | batched records + exact ${result.batchedExact.endToEndMs.toFixed(1)}ms`);
    if (result.predicate) {
      const p = result.predicate;
      console.log(`  predicate 1%: side-store ${p.sideStore.endToEndMsMedian.toFixed(1)}ms (warm ${p.sideStore.warmOnlyEndToEndMsMedian.toFixed(1)}ms, whole warm ${p.sideStore.wholeBlock.warmMedianMs.toFixed(1)}ms) r@10=${p.sideStore.recallAt10Mean.toFixed(3)} | ` +
        `exact eligible by key ${p.exactEligibleByKey.endToEndMsMedian.toFixed(1)}ms (whole warm ${p.exactEligibleByKey.wholeBlock.warmMedianMs.toFixed(1)}ms) r@10=${p.exactEligibleByKey.recallAt10Mean.toFixed(3)} | ` +
        `packed f32 masked ${p.packedExactMasked.endToEndMsMedian.toFixed(1)}ms r@10=${p.packedExactMasked.recallAt10Mean.toFixed(3)} (eligible ${p.eligibleRows})`);
      const probe = p.maskProbe;
      console.log(`  mask probe: stored mask differs from resident by ${probe.storedMaskBytesDiffering} bytes | probe mask served back ${probe.probeServedMatchesStored} | every leg changed under the stored probe mask and matched its oracle: ` +
        Object.entries(probe.legs).map(([leg, check]) => `${leg}=${check.changedUnderProbeMask && check.probeWithinProbeMask && check.probeMatchesProbeOracle}`).join(' '));
    }
    if (result.revision) console.log(`  revision: current r@10=${result.revision.currentRecallAt10Mean.toFixed(3)} stale r@10=${result.revision.staleRecallAt10Mean.toFixed(3)} missing in stale fetch ${result.revision.missingRecordsInStaleFetch}`);
    const c = cold[result.name];
    console.log(`  cold (fresh process, query row ${Math.min(coldRow, result.count - 1)}): ` +
      result.budgets.map(n => `N=${n} codes legs ${c.codes[n].legs.legSumMs.toFixed(1)}ms whole ${c.codes[n].whole.wholeMs.toFixed(1)}ms r@10=${c.codes[n].legs.recallAt10.toFixed(3)}`).join(' | ') +
      ` | packed legs ${c.packed.legs.legSumMs.toFixed(1)}ms whole ${c.packed.whole.wholeMs.toFixed(1)}ms` +
      (c.masked ? ` | masked N=${Math.max(...result.budgets)} legs ${c.masked.legs.legSumMs.toFixed(1)}ms whole ${c.masked.whole.wholeMs.toFixed(1)}ms r@10=${c.masked.legs.recallAt10.toFixed(3)}` : ''));
  }
  console.log(`Report: ${jsonPath}`);
} finally {
  if (page) browsers.delete(page);
  await page?.close();
  await closeBrowsers();
  await new Promise(resolve => server.close(resolve));
  // The profile is the caller's (passed to launch()), so removing it is this script's job: it holds
  // the databases the cold phase read, and it is the only copy of them.
  rmSync(profile, { recursive: true, force: true });
}
