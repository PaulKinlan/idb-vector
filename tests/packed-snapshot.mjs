import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { serve } from '../tools/demo-server.mjs';
import { launch } from './lib/cdp.mjs';
import { reportTarget } from '../tools/report-target.mjs';
const { server, url } = await serve();
let page;
try {
  page = await launch(); await page.goto(url);
  const result = await page.evaluate(async () => {
    const { VectorDB, diagnose, fitWhitening } = await import('/index.js');
    const { vector } = await import('/test-harness/experiment.js');
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const complete = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const keysScores = rows => Array.from(rows, ({ key, similarity }) => ({ key, similarity }));
    const bits = rows => {
      const bytes = new Float64Array(rows.length*2);
      rows.forEach((row, i) => { bytes[2*i] = row.key; bytes[2*i+1] = row.similarity; });
      return Array.from(new Uint8Array(bytes.buffer)).join(',');
    };
    const timed = async fn => { const start = performance.now(), value = await fn(); return { ms: performance.now()-start, value }; };
    const open = async name => {
      const library = new VectorDB({ dbName: name, vectorPath: 'embedding' });
      await library.query([1]);
      return { library, raw: await req(indexedDB.open(name)) };
    };
    const name = `snapshot-check-${crypto.randomUUID()}`;
    const { library: db, raw } = await open(name);
    await db.insert({ embedding: [1, 0], title: 'original' });
    await db.insert({ embedding: [1, 0.123456789012345], title: 'precision' });
    await db.insert({ embedding: [0, 1], title: 'other' });
    const snapshot = await db.createSnapshot({ maxBytes: 128 });
    check(snapshot.mode === 'snapshot' && snapshot.bytes <= 128, 'bounded cache');
    check(bits((await snapshot.query([1, 0])).results) === bits(await db.query([1, 0])), 'exact bytes');
    const tx = raw.transaction('vectors', 'readwrite'), done = complete(tx);
    tx.objectStore('vectors').put({ embedding: [-1, 0] }, 1); await done;
    check((await db.query([1, 0]))[0].key !== 1, 'default sees external writes');
    check((await snapshot.query([1, 0])).results[0].key === 1, 'snapshot is explicit old corpus');
    await snapshot.refresh();
    check(bits((await snapshot.query([1, 0])).results) === bits(await db.query([1, 0])), 'refresh sees external writes');
    const evicted = await db.createSnapshot({ maxBytes: 16 });
    check(evicted.mode === 'live' && evicted.reason === 'memory-budget' && evicted.bytes === 0, 'budget evicts rather than truncates');
    check(bits((await evicted.query([1, 0])).results) === bits(await db.query([1, 0])), 'fallback exact');
    // Both snapshot paths must refuse an unscoreable query at the boundary (idb-vector-2yi):
    // snapshot mode used to zero-score every record and return insertion order, and live mode threw
    // inside the cursor's onsuccess handler, which escaped the promise and hung the caller.
    for (const [mode, target] of [['snapshot', snapshot], ['live', evicted]]) {
      let refused = null;
      try { await target.query([0, 1e160]); } catch (error) { refused = error; }
      check(refused instanceof TypeError, `${mode} snapshot refuses an overflowing query with a TypeError`);
      check(/non-finite L2 magnitude/.test(refused.message), `${mode} snapshot names the magnitude: ${refused.message}`);
      check(!/stored vectorPath/.test(refused.message), `${mode} snapshot must not blame a stored record: ${refused.message}`);
    }
    await db.update('string-key', { embedding: [1, 0] });
    await snapshot.refresh();
    check(snapshot.mode === 'live' && snapshot.reason === 'unsupported-key-or-vector', 'nonnumeric keys fall back');
    check(JSON.stringify((await snapshot.query([1, 0])).results) === JSON.stringify(keysScores(await db.query([1, 0]))), 'fallback preserves string key');
    const invalidTx = raw.transaction('vectors', 'readwrite'), invalidDone = complete(invalidTx);
    const invalidStore = invalidTx.objectStore('vectors');
    invalidStore.put({ embedding: [NaN, 0] }, 20);
    invalidStore.put({ embedding: [Infinity, 0] }, 21);
    invalidStore.put({ embedding: '10' }, 22);
    invalidStore.put({ title: 'missing vector' }, 23);
    invalidStore.put({ embedding: [0, 0] }, 24);
    invalidStore.put({ embedding: [1] }, 26);
    await invalidDone;
    const invalidKeys = [20, 21, 22, 23, 24, 26];
    try {
      await snapshot.refresh();
      const liveRows = (await snapshot.query([1, 0])).results;
      check(snapshot.mode === 'live' && snapshot.reason === 'unsupported-key-or-vector', 'invalid records evict packed cache');
      check(liveRows.some(row => row.key === 'string-key'), 'fallback retains supported string key');
      check(liveRows.every(row => Number.isFinite(row.similarity) && !invalidKeys.includes(row.key)), 'fallback excludes invalid vector and nonfinite similarity');
    } finally {
      // Later tests call the strict VectorDB.query(): remove malformed rows even if an assertion fails.
      const cleanupTx = raw.transaction('vectors', 'readwrite'), cleanupDone = complete(cleanupTx);
      for (const key of invalidKeys) cleanupTx.objectStore('vectors').delete(key);
      await cleanupDone;
    }
    const cleanStore = raw.transaction('vectors').objectStore('vectors');
    check((await Promise.all(invalidKeys.map(key => req(cleanStore.get(key))))).every(value => value === undefined), 'malformed fixture rows were removed');
    snapshot.close();
    let rejected = false; try { await snapshot.query([1, 0]); } catch { rejected = true; }
    check(rejected && snapshot.bytes === 0 && snapshot.mode === 'closed', 'close releases memory');
    for (const method of ['add', 'put', 'delete']) {
      const original = IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method] = function(...args) {
        const r = original.apply(this,args); r.addEventListener('success', () => this.transaction.abort()); return r;
      };
      let refused = false;
      const before = JSON.stringify(await db.query([1,0]));
      try {
        if (method === 'add') await db.insert({ embedding: [1,0] });
        else if (method === 'put') await db.update(1, { embedding: [1,0] });
        else await db.delete(1);
      } catch { refused = true; }
      finally { IDBObjectStore.prototype[method] = original; }
      check(refused, `${method} abort must reject`);
      check(JSON.stringify(await db.query([1,0])) === before, `${method} abort preserves data`);
    }
    const plain = [[10,1], [20,2], [30,4], [40,3], [50,7], [60,5]];
    const untouched = JSON.stringify(plain), fit = fitWhitening(plain, { regularization: 1e-10 });
    const transformed = plain.map(v => fit.transform(v));
    check(JSON.stringify(plain) === untouched, 'whitening never mutates originals');
    for (let row = 0; row < plain.length; row++) fit.inverse(transformed[row]).forEach((x,i) => check(Math.abs(x-plain[row][i]) < 1e-9, 'inverse roundtrip'));
    const mean = [0,1].map(i => transformed.reduce((sum,v) => sum+v[i],0)/transformed.length);
    const covariance = (i,j) => transformed.reduce((sum,v) => sum+(v[i]-mean[i])*(v[j]-mean[j]),0)/(transformed.length-1);
    check(Math.abs(covariance(0,0)-1)<1e-6 && Math.abs(covariance(1,1)-1)<1e-6 && Math.abs(covariance(0,1))<1e-6, 'full covariance whitening, not diagonal scaling');
    check(diagnose([[1,0],[-1,0],[0,1],[0,-1]]).warning === null, 'low dimension isotropic must not warn');
    check(diagnose([[1,1],[1,1]]).dominance === null, 'zero variance undefined');
    check(diagnose([Array.from({length:128},(_,i)=>i===0?10:1),Array.from({length:128},(_,i)=>i===0?-10:-1)]).warning !== null, 'concentrated coordinates warn');
    let overflow=false; try { diagnose([[1e308],[-1e308]]); } catch { overflow=true; } check(overflow,'variance overflow refuses');
    for (const bad of [[], [[1,2]], [[1,2],[3]], [[1,Infinity],[2,3]], [[1,1],[1,1]]]) {
      let failed=false; try { fitWhitening(bad); } catch { failed=true; } check(failed,'invalid fitting input');
    }
    const singular = fitWhitening([[1,1],[2,2],[3,3]]);
    check(singular.transform([4,4]).every(Number.isFinite),'regularized rank deficient covariance');
    const real = new Float32Array(await (await fetch('/demo/data/vectors-2000.f32')).arrayBuffer());
    check(real.length === 2000*384, 'real corpus shape');
    // Two SMALL corpora, one real and one synthetic: this leg is the merger's correctness gate, and a
    // 100000x128 measurement here turned it into a benchmark that exceeded 900s at load ~10, 37% of the
    // 2400s full-gate allowance (idb-vector-bqw, ADR idb-vector-80j). The high-cardinality stress
    // measurement lives in tests/packed-snapshot-stress.mjs (`npm run measure:packed-snapshot`) and is
    // run on a schedule, so size-dependent behaviour still has an exercised owner.
    const corpora = [
      { name: 'Wikipedia all-MiniLM-L6-v2 2000x384 (committed f32 embeddings)', count: 2000, dimensions:384, vector: i => Array.from(real.subarray(i*384,(i+1)*384)) },
      { name: 'seeded uniform 1000x128', count:1000, dimensions:128, vector: i => vector(i,128) }
    ];
    const measured = [];
    for (const corpus of corpora) {
      const { library, raw: source } = await open(`snapshot-perf-${crypto.randomUUID()}`);
      for (let offset=0; offset<corpus.count; offset+=1000) {
        const tx = source.transaction('vectors','readwrite'), done=complete(tx);
        for (let i=offset; i<Math.min(offset+1000,corpus.count);i++) tx.objectStore('vectors').put({embedding:corpus.vector(i),id:i},i+1);
        await done;
      }
      // Budget equals encoded payload plus one block of padding, not a corpus-size cap.
      const maxBytes = (corpus.dimensions+2)*8*corpus.count + 1024*1024;
      const built = await timed(() => library.createSnapshot({maxBytes})), cache = built.value;
      check(cache.mode==='snapshot' && cache.bytes<=maxBytes,'corpus cache fits its explicit byte budget');
      const runs=[];
      for (let i=0;i<3;i++) {
        const q=corpus.vector(42+i);
        let baseline,cached;
        if(i%2) { cached=await timed(()=>cache.query(q)); baseline=await timed(()=>library.query(q)); }
        else { baseline=await timed(()=>library.query(q)); cached=await timed(()=>cache.query(q)); }
        check(bits(cached.value.results)===bits(baseline.value), 'same 64-bit keys/scores including order on real/synthetic corpus');
        runs.push({queryId:42+i, baselineMs:baseline.ms, cachedMs:cached.ms, mode:cached.value.mode, byteIdentical:true, keys:cached.value.results.map(x=>x.key)});
      }
      measured.push({name:corpus.name,count:corpus.count,dimensions:corpus.dimensions,maxBytes,allocatedBytes:cache.bytes,buildMs:built.ms,diagnostic:cache.diagnostic,runs});
      cache.close(); source.close();
    }
    const realVectors = Array.from({length:2000},(_,i)=>Array.from(real.subarray(i*384,(i+1)*384)));
    const fitStart=performance.now(), realFit=fitWhitening(realVectors), fitMs=performance.now()-fitStart;
    const { library: whiteDB, raw: whiteRaw } = await open(`whitened-${crypto.randomUUID()}`);
    const { library: originalDB, raw: originalRaw } = await open(`original-${crypto.randomUUID()}`);
    // Batched writes, not 4000 awaited single-record inserts. `insert()` is one transaction per record, which
    // measured ~165ms each in this headless environment: writing the two whitening corpora one record at a
    // time cost ~660s of the full gate by itself, more than the 100000-vector measurement this leg used to
    // carry (idb-vector-bqw). The records written here are identical - same rows, numeric keys i+1, same
    // stores - so the ranking comparison below is unchanged; only the harness stops committing per row.
    const writeReal = async (raw, rows) => {
      const writeStart = performance.now();
      for (let offset = 0; offset < rows.length; offset += 1000) {
        const tx = raw.transaction('vectors','readwrite'), done = complete(tx), store = tx.objectStore('vectors');
        for (let i = offset; i < Math.min(offset + 1000, rows.length); i++) store.put({ embedding: rows[i] }, i + 1);
        await done;
      }
      return Math.round(performance.now() - writeStart);
    };
    const whiteningWriteMs = await writeReal(originalRaw, realVectors);
    const whiteningWriteWhitenedMs = await writeReal(whiteRaw, realVectors.map(v => realFit.transform(v)));
    const comparisons=[];
    for(const id of [42,43,44]) {
      const before=await originalDB.query(realVectors[id]), after=await whiteDB.query(realFit.transform(realVectors[id]));
      comparisons.push({queryId:id,originalKeys:before.map(x=>x.key),whitenedKeys:after.map(x=>x.key),overlap:after.filter(x=>before.some(y=>y.key===x.key)).length});
      check(before[0].key===id+1 && after[0].key===id+1,'self-match retained with same fitted corpus/query transform');
    }
    check(comparisons.some(x => x.overlap < 10), 'real-corpus opt-in ranking change is observable');
    const output={timings:{fitMs:Math.round(fitMs),whiteningWriteMs,whiteningWriteWhitenedMs},checks:'cache/refresh/external writes/budget eviction/unsupported keys/close/transaction aborts/whitening covariance/inverse/invalid inputs/low-D diagnostic/synthetic 1000x128 exactness (100000x128 stress: measure:packed-snapshot)',measured,whitening:{fitMs,diagnostic:realFit.diagnostic,comparisons,qualityClaim:'None: ranking changes are not labelled retrieval improvement; no held-out relevance labels.'}};
    document.body.textContent=JSON.stringify(output,null,2);
    return output;
  });
  assert.equal(result.measured.length,2);
  const sourceHashes = Object.fromEntries(await Promise.all(['index.js','utils/packed-snapshot.js','utils/geometry.js','tests/packed-snapshot.mjs','tools/demo-server.mjs','demo/data/vectors-2000.f32'].map(async path => [path,createHash('sha256').update(await readFile(path)).digest('hex')])));
  const report={sourceHashes,commit:execFileSync('git',['rev-parse','HEAD']).toString().trim(),diff:execFileSync('git',['diff','--stat']).toString().trim(),observedAt:new Date().toISOString(),browser:await page.send('Browser.getVersion'),cpu:os.cpus()[0].model,load:os.loadavg(),condition:'Fresh headless Chromium profile; warm committed IndexedDB; three alternating query timings per corpus; query IDs42/43/44; k10; same records, exact Float64 byte comparison, not cold disk or isolated host. Snapshot build measured separately.',...result};
  // The report goes to a unique per-run temp directory by default (a fixed os.tmpdir() name let
  // two concurrent runs clobber one report - idb-vector-006): reports/packed-snapshot.json is
  // TRACKED, and writing it here advanced its nsec ctime, which fleet-check's worktree digest reads
  // as a mid-run tree mutation (STALE).
  // Regenerate the tracked report deliberately with PACKED_SNAPSHOT_REPORT=reports/packed-snapshot.json.
  const target = reportTarget(process.env.PACKED_SNAPSHOT_REPORT, 'idb-packed-snapshot-', 'packed-snapshot.json');
  try {
    await writeFile(target.path, JSON.stringify(report,null,2)+'\n');
    // The screenshot is evidence: beside the report, which is a unique per-run directory unless
    // PACKED_SNAPSHOT_REPORT pinned one (a fixed /tmp name was clobbered by concurrent runs).
    await page.screenshot(join(target.dir ?? dirname(target.path), 'packed-snapshot.png'));
    console.log(JSON.stringify(report,null,2));
    if (!target.dir) console.log(`Report: ${target.path}`);
  } finally {
    if (target.dir) await rm(target.dir, { recursive: true, force: true });
  }
} finally { await page?.close(); await new Promise(resolve=>server.close(resolve)); }
