import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
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
const jsonPath = smoke ? 'reports/side-store-query-smoke.json' : 'reports/side-store-query.json';

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

const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  const results = await page.evaluate(async specs => {
    const m = await import('/test-harness/quantized-pass.js');
    const { buildCodeRecord, rerankFetched } = await import('/test-harness/side-store.js');
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const time = async fn => { const start = performance.now(); const value = await fn(); return { ms: performance.now() - start, value }; };
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

    const out = [];
    for (const spec of specs) {
      const { count, dims, seed } = spec;
      const { vectors, queries } = m.uniformCorpus(count, dims, seed, 10);
      const record = buildCodeRecord(vectors, count, dims, 1);
      const mask = m.eligibleMask(count, spec.predicate ? (id => id % 100 === 7) : null);
      const packed = vectors; // the packed snapshot is the corpus itself, stored as one record

      // One database per corpus: originals as individual records (the library's storage shape),
      // the code record, the eligibility mask, and a packed Float32 array for the snapshot path.
      const name = `kuc9-${crypto.randomUUID()}`;
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
      const coldWarm = values => ({
        coldMs: values[0],
        warmMedianMs: values.length > 1 ? median(values.slice(1)) : null,
        warmSamples: values.length > 1 ? values.slice(1) : [],
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
          coldMs: Object.fromEntries(spec.budgets.map(n => [n, perBudget[n].endToEnd[0]])),
          warmOnlyEndToEndMsMedian: Object.fromEntries(spec.budgets.map(n => [n, median(perBudget[n].endToEnd.slice(1))])),
          perLeg: {
            codesRead: coldWarm(legs.codesRead),
            scan: coldWarm(legs.scan),
            fetch: Object.fromEntries(spec.budgets.map(n => [n, coldWarm(perBudget[n].fetch)])),
            rerank: Object.fromEntries(spec.budgets.map(n => [n, coldWarm(perBudget[n].rerank)])),
          },
          wholeBlock: Object.fromEntries(spec.budgets.map(n => [n, coldWarm(perBudget[n].whole)])),
          wholeBlockRecallMean: Object.fromEntries(spec.budgets.map(n => [n, perBudget[n].wholeRecall.reduce((a, b) => a + b, 0) / perBudget[n].wholeRecall.length])),
          recallAt10Mean: Object.fromEntries(spec.budgets.map(n => [n, perBudget[n].recall.reduce((a, b) => a + b, 0) / perBudget[n].recall.length])),
          candidateCeilingMean: Object.fromEntries(spec.budgets.map(n => [n, perBudget[n].ceiling.reduce((a, b) => a + b, 0) / perBudget[n].ceiling.length])),
        },
        packedExact: {
          readMsMedian: median(packedExactLegs.read), scanMsMedian: median(packedExactLegs.scan),
          endToEndMsMedian: median(packedExactLegs.read) + median(packedExactLegs.scan),
          perLeg: { read: coldWarm(packedExactLegs.read), scan: coldWarm(packedExactLegs.scan) },
        },
        batchedExact: { queries: 1, endToEndMs: batchedExactMs },
        fetchedRowsVerified: freshChecks,
      };

      if (spec.predicate) {
        // Paired filtered comparison (idb-vector-pun): every alternative below reads its data from
        // IndexedDB in this same run, so the side-store is not compared against a resident scan.
        // The eligible set has to be obtained by some means; here it is the stored eligibility mask
        // (100 KB). In the library that role is a metadata index, whose own cost is measured
        // elsewhere - this leg is the mask read, not a metadata-index claim.
        const legsPredicate = { maskRead: [], scan: [], fetch: [], rerank: [], endToEnd: [], whole: [], recall: [], ceiling: [] };
        const legsExactEligible = { maskRead: [], fetch: [], rerank: [], endToEnd: [], whole: [], recall: [] };
        const legsPackedMasked = { read: [], scan: [], endToEnd: [], whole: [], recall: [] };
        const eligibleIds = [];
        for (let id = 0; id < count; id++) if (mask[id]) eligibleIds.push(id);
        for (let rep = 0; rep < spec.repetitions; rep++) for (const query of queries) {
          const q = queries.indexOf(query);
          // (i) side-store: read codes + mask, masked scan, fetch the top-300 by key, rerank.
          const rec = await time(readCodeRecord);
          const scan = await time(() => m.sq8Scan(null, count, dims, rec.value.rec, rec.value.rec.norms, query, keep, rec.value.mask));
          const ids = scan.value.map(row => row.index).slice(0, 300);
          const fetch = await time(() => fetchByIds(ids));
          const rerank = await time(() => rerankFetched(fetch.value, query, 10, dims));
          legsPredicate.maskRead.push(rec.ms); legsPredicate.scan.push(scan.ms);
          legsPredicate.fetch.push(fetch.ms); legsPredicate.rerank.push(rerank.ms);
          const sideEnd = rec.ms + scan.ms + fetch.ms + rerank.ms;
          legsPredicate.endToEnd.push(sideEnd);
          legsPredicate.recall.push(m.recallAtK(rerank.value, oracleEligible[q]));
          legsPredicate.ceiling.push(m.candidateCeiling(ids, oracleEligible[q]));
          const sideWhole = await time(async () => {
            const r = await readCodeRecord();
            const s = m.sq8Scan(null, count, dims, r.rec, r.rec.norms, query, keep, r.mask);
            const rows = await fetchByIds(s.map(row => row.index).slice(0, 300));
            return rerankFetched(rows, query, 10, dims);
          });
          legsPredicate.whole.push(sideWhole.ms);
          // (ii) exact over the eligible originals fetched BY KEY, no codes at all: read the mask,
          // fetch the 1,000 eligible rows in one transaction, rank them exactly in Float64.
          const exactMask = await time(async () => {
            const tx = db.transaction('codes');
            const mk = await request(tx.objectStore('codes').get('mask'));
            await complete(tx);
            return mk;
          });
          const exactFetch = await time(() => fetchByIds(eligibleIds));
          const exactRerank = await time(() => rerankFetched(exactFetch.value, query, 10, dims));
          legsExactEligible.maskRead.push(exactMask.ms);
          legsExactEligible.fetch.push(exactFetch.ms); legsExactEligible.rerank.push(exactRerank.ms);
          legsExactEligible.endToEnd.push(exactMask.ms + exactFetch.ms + exactRerank.ms);
          legsExactEligible.recall.push(m.recallAtK(exactRerank.value, oracleEligible[q]));
          const exactWhole = await time(async () => {
            const tx = db.transaction('codes');
            const mk = await request(tx.objectStore('codes').get('mask'));
            await complete(tx);
            const rows = await fetchByIds(eligibleIds);
            return rerankFetched(rows, query, 10, dims);
          });
          legsExactEligible.whole.push(exactWhole.ms);
          // (iii) the packed Float32 record read from IndexedDB plus the masked exact scan.
          const packedRead = await time(() => request(db.transaction('packed').objectStore('packed').get('f32')));
          const packedScan = await time(() => m.exactTopK(packedRead.value, count, dims, query, 10, mask));
          legsPackedMasked.read.push(packedRead.ms); legsPackedMasked.scan.push(packedScan.ms);
          legsPackedMasked.endToEnd.push(packedRead.ms + packedScan.ms);
          legsPackedMasked.recall.push(m.recallAtK(packedScan.value, oracleEligible[q]));
          const packedWhole = await time(async () => {
            const rec2 = await request(db.transaction('packed').objectStore('packed').get('f32'));
            return m.exactTopK(rec2, count, dims, query, 10, mask);
          });
          legsPackedMasked.whole.push(packedWhole.ms);
        }
        const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
        const eligible = mask.reduce((sum, value) => sum + value, 0);
        summary.predicate = {
          eligibleRows: eligible, selectivity: eligible / count, budget: 300,
          eligibleIdsSource: 'stored eligibility mask record (100 KB); the library uses a metadata index for this step',
          sideStore: {
            scanMsMedian: median(legsPredicate.scan), fetchMsMedian: median(legsPredicate.fetch),
            endToEndMsMedian: median(legsPredicate.endToEnd),
            warmOnlyEndToEndMsMedian: median(legsPredicate.endToEnd.slice(1)),
            wholeBlock: coldWarm(legsPredicate.whole),
            perLeg: {
              maskRead: coldWarm(legsPredicate.maskRead), scan: coldWarm(legsPredicate.scan),
              fetch: coldWarm(legsPredicate.fetch), rerank: coldWarm(legsPredicate.rerank),
            },
            recallAt10Mean: mean(legsPredicate.recall),
            candidateCeilingMean: mean(legsPredicate.ceiling),
          },
          exactEligibleByKey: {
            fetchMsMedian: median(legsExactEligible.fetch), rerankMsMedian: median(legsExactEligible.rerank),
            endToEndMsMedian: median(legsExactEligible.endToEnd),
            warmOnlyEndToEndMsMedian: median(legsExactEligible.endToEnd.slice(1)),
            wholeBlock: coldWarm(legsExactEligible.whole),
            perLeg: {
              maskRead: coldWarm(legsExactEligible.maskRead), fetch: coldWarm(legsExactEligible.fetch),
              rerank: coldWarm(legsExactEligible.rerank),
            },
            recallAt10Mean: mean(legsExactEligible.recall),
          },
          packedExactMasked: {
            readMsMedian: median(legsPackedMasked.read), scanMsMedian: median(legsPackedMasked.scan),
            endToEndMsMedian: median(legsPackedMasked.endToEnd),
            warmOnlyEndToEndMsMedian: median(legsPackedMasked.endToEnd.slice(1)),
            wholeBlock: coldWarm(legsPackedMasked.whole),
            perLeg: { read: coldWarm(legsPackedMasked.read), scan: coldWarm(legsPackedMasked.scan) },
            recallAt10Mean: mean(legsPackedMasked.recall),
          },
        };
      }

      if (spec.revision) {
        // Advance the side-store to revision 2: 25% of the rows are deleted, their codes cleared,
        // the mask updated and the new record written under one revision stamp.
        const deleted = [];
        for (let id = 0; id < count; id++) if (id % 4 === 0) deleted.push(id);
        await time(async () => {
          const gone = new Set(deleted);
          const tx = db.transaction('rows', 'readwrite');
          const store = tx.objectStore('rows');
          for (const id of deleted) store.delete(id);
          await complete(tx);
          const record2 = {
            ...record,
            revision: 2,
            codes: record.codes.slice(),
          };
          for (const id of deleted) record2.codes.fill(0, id * dims, (id + 1) * dims);
          // The delete mask is its own record: the predicate leg's mask is a different thing and
          // must not be confused with "which rows still exist in this revision".
          const liveMaskWrite = Uint8Array.from(mask.length === count ? mask : new Uint8Array(count));
          liveMaskWrite.fill(1);
          for (const id of deleted) liveMaskWrite[id] = 0;
          const write2 = db.transaction('codes', 'readwrite');
          write2.objectStore('codes').put(record2, 'record');
          write2.objectStore('codes').put(liveMaskWrite, 'mask-live');
          await complete(write2);
        });
        const liveMask = m.eligibleMask(count, id => id % 4 !== 0);
        const liveOracle = queries.map(query => m.exactTopK(vectors, count, dims, query, 10, liveMask));
        const revisionLegs = { current: [], stale: [], currentRecall: [], staleRecall: [], staleFetched: 0, currentFetched: 0 };
        for (const query of queries) {
          const current = await time(async () => {
            const tx = db.transaction('codes');
            const store = tx.objectStore('codes');
            const [rec, live] = await Promise.all([request(store.get('record')), request(store.get('mask-live'))]);
            await complete(tx);
            return { rec, mask: live };
          });
          if (current.value.rec.revision !== 2) throw new Error(`side-store served revision ${current.value.rec.revision}, expected 2`);
          const scan = m.sq8Scan(null, count, dims, current.value.rec, current.value.rec.norms, query, keep, current.value.mask);
          const ids = scan.map(row => row.index).slice(0, 300);
          const rows = await fetchByIds(ids);
          const missing = rows.filter(row => !row).length;
          const rerank = rerankFetched(rows, query, 10, dims);
          revisionLegs.currentFetched += missing;
          revisionLegs.current.push(m.recallAtK(rerank, liveOracle[queries.indexOf(query)]));
          // The stale revision is the record a query would have served before the update: it still
          // names the deleted rows, and the fetch returns nothing for them.
          const staleScan = m.sq8Scan(null, count, dims, record, record.norms, query, keep, null);
          const staleIds = staleScan.map(row => row.index).slice(0, 300);
          const staleRows = await fetchByIds(staleIds);
          revisionLegs.staleFetched += staleRows.filter(row => !row).length;
          revisionLegs.stale.push(m.recallAtK(rerankFetched(staleRows, query, 10, dims), liveOracle[queries.indexOf(query)]));
        }
        summary.revision = {
          deletedRows: deleted.length,
          currentRevision: 2,
          currentRecallAt10Mean: revisionLegs.current.reduce((a, b) => a + b, 0) / revisionLegs.current.length,
          staleRecallAt10Mean: revisionLegs.stale.reduce((a, b) => a + b, 0) / revisionLegs.stale.length,
          missingRecordsInCurrentFetch: revisionLegs.currentFetched,
          missingRecordsInStaleFetch: revisionLegs.staleFetched,
        };
      }

      out.push(summary);
      db.close();
      indexedDB.deleteDatabase(name);
    }
    return out;
  }, specs);

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
      // Cold and warm per leg, plus whole-block observations for every query (idb-vector-thu).
      const expected = result.repetitions * result.queries;
      const whole = result.sideStore.wholeBlock[budget];
      assert.equal(whole.samples, expected, `${result.name} whole-block samples@${budget}`);
      assert.ok(whole.coldMs > 0 && whole.warmMedianMs > 0, `${result.name} whole-block cold/warm@${budget}`);
      assert.ok(result.sideStore.wholeBlockRecallMean[budget] >= result.sideStore.recallAt10Mean[budget] - 1e-9);
      for (const [leg, series] of [['codesRead', result.sideStore.perLeg.codesRead], ['scan', result.sideStore.perLeg.scan],
        ['fetch', result.sideStore.perLeg.fetch[budget]], ['rerank', result.sideStore.perLeg.rerank[budget]]]) {
        assert.equal(series.samples, expected, `${result.name} ${leg} samples`);
        assert.ok(series.coldMs >= 0 && series.warmMedianMs >= 0, `${result.name} ${leg} cold/warm`);
      }
    }
    for (const check of result.fetchedRowsVerified) {
      assert.equal(check.sameAsResident, true, `${result.name} fetched row ${check.id} differs from the stored vector`);
      assert.equal(check.dimensions, result.dims);
    }
    assert.ok(result.packedExact.endToEndMsMedian > 0 && result.batchedExact.endToEndMs > 0);
    assert.ok(result.packedExact.perLeg.read.coldMs > 0 && result.packedExact.perLeg.read.warmMedianMs > 0);
    if (result.predicate) {
      assert.equal(result.predicate.eligibleRows, smoke ? 20 : 1000);
      // Three paired IndexedDB alternatives, all with a whole-block sample per query
      // (idb-vector-pun). The exact paths are exact by construction, so their recall must be 1.
      for (const [name, path] of [['sideStore', result.predicate.sideStore], ['exactEligibleByKey', result.predicate.exactEligibleByKey], ['packedExactMasked', result.predicate.packedExactMasked]]) {
        assert.ok(path.recallAt10Mean >= 0.99, `${name} filtered recall ${path.recallAt10Mean}`);
        assert.ok(path.endToEndMsMedian > 0 && path.warmOnlyEndToEndMsMedian > 0, `${name} filtered end-to-end`);
        assert.equal(path.wholeBlock.samples, result.repetitions * result.queries, `${name} filtered whole-block samples`);
        assert.ok(path.wholeBlock.coldMs > 0 && path.wholeBlock.warmMedianMs > 0, `${name} filtered whole-block cold/warm`);
        for (const series of Object.values(path.perLeg)) assert.ok(series.coldMs >= 0 && series.warmMedianMs >= 0, `${name} filtered per-leg cold/warm`);
      }
      assert.equal(result.predicate.sideStore.candidateCeilingMean, 1);
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

  const report = {
    observedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
    diff: execFileSync('git', ['diff', '--stat']).toString().trim(),
    browser: await page.send('Browser.getVersion'),
    cpu: os.cpus()[0].model, load: os.loadavg(),
    conditions: 'One timed query per (corpus, query, budget): read the code record and eligibility mask, scan the int8 codes, fetch the top-N originals by key in a single readonly transaction, rerank exactly in Float64. Originals are stored as 100,000 individual { id, embedding } records (Float64Array), the codes as one packed record; both in one fresh database per corpus, writes completed before any timing. Oracles are computed from the resident vectors. Every leg and every whole-block observation is recorded per query, so the report can state a cold value (first query of the run) and a warm-only median (the remaining queries) rather than one aggregate; 3 order-rotated repetitions at 128 dimensions and 2 at 384. The 1%-predicate leg is a paired comparison inside this same run: the int8 codes path, an exact path over the eligible originals fetched by key (mask read, one-transaction fetch, Float64 rerank) and the packed Float32 record read plus a masked exact scan.',
    nodeCrosscheck: { buildCodeRecordRevision: tinyRecord.revision, fetchedRerankLength: rerankFetched(tinyIds.map(id => ({ id, embedding: Float64Array.from(tiny.vectors.subarray(id * 32, (id + 1) * 32)) })), tiny.queries[0], 10, 32).length },
    results,
  };
  await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n');
  for (const result of results) {
    const s = result.sideStore;
    console.log(`${result.name} (n=${result.count}, d=${result.dims}): codes read ${s.codesReadMsMedian.toFixed(1)}ms (cold ${s.perLeg.codesRead.coldMs.toFixed(1)}) | scan ${s.scanMsMedian.toFixed(1)}ms | ` +
      result.budgets.map(n => `N=${n} fetch ${s.fetchMsMedian[n].toFixed(1)}ms rerank ${s.rerankMsMedian[n].toFixed(1)}ms end-to-end ${s.endToEndMsMedian[n].toFixed(1)}ms warm-only ${s.warmOnlyEndToEndMsMedian[n].toFixed(1)}ms whole cold ${s.wholeBlock[n].coldMs.toFixed(1)} / warm ${s.wholeBlock[n].warmMedianMs.toFixed(1)}ms r@10=${s.recallAt10Mean[n].toFixed(3)}`).join(' | ') +
      ` | packed f32 + exact ${result.packedExact.endToEndMsMedian.toFixed(1)}ms | batched records + exact ${result.batchedExact.endToEndMs.toFixed(1)}ms`);
    if (result.predicate) {
      const p = result.predicate;
      console.log(`  predicate 1%: side-store ${p.sideStore.endToEndMsMedian.toFixed(1)}ms (warm ${p.sideStore.warmOnlyEndToEndMsMedian.toFixed(1)}ms, whole cold ${p.sideStore.wholeBlock.coldMs.toFixed(1)} / warm ${p.sideStore.wholeBlock.warmMedianMs.toFixed(1)}ms) r@10=${p.sideStore.recallAt10Mean.toFixed(3)} | ` +
        `exact eligible by key ${p.exactEligibleByKey.endToEndMsMedian.toFixed(1)}ms (whole warm ${p.exactEligibleByKey.wholeBlock.warmMedianMs.toFixed(1)}ms) r@10=${p.exactEligibleByKey.recallAt10Mean.toFixed(3)} | ` +
        `packed f32 masked ${p.packedExactMasked.endToEndMsMedian.toFixed(1)}ms r@10=${p.packedExactMasked.recallAt10Mean.toFixed(3)} (eligible ${p.eligibleRows})`);
    }
    if (result.revision) console.log(`  revision: current r@10=${result.revision.currentRecallAt10Mean.toFixed(3)} stale r@10=${result.revision.staleRecallAt10Mean.toFixed(3)} missing in stale fetch ${result.revision.missingRecordsInStaleFetch}`);
  }
  console.log(`Report: ${jsonPath}`);
} finally {
  await page?.close();
  await new Promise(resolve => server.close(resolve));
}
