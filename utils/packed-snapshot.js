import { SortedArray } from './sortedarray.js';
import { moments } from './geometry.js';
import {
  DEFAULT_LIMIT,
  SNAPSHOT_OPTION_KEYS,
  SNAPSHOT_QUERY_OPTION_KEYS,
  assertLimit,
  assertOptionKeys,
  describe,
} from './options.js';

const finiteVector = vector => Array.isArray(vector) && Array.from(vector).every(Number.isFinite);

// A record whose squared magnitude overflows Float64 - every coordinate finite, at least one above
// ~1.34e154 - has a cosine similarity that is a real 0, indistinguishable from a genuinely
// orthogonal record, so Number.isFinite() cannot see it and the existing guards let it rank. query()
// refuses such a record by key (idb-vector-cfr); both snapshot paths must refuse it too rather than
// bury it at 0 (idb-vector-c2o). A zero vector is a different case: its similarity is NaN and stays
// a reported skip, because that is a corpus-shape fact rather than an unscorable magnitude.
const overflowingRecord = (vectorPath, key) => new TypeError(
  `Stored vectorPath '${vectorPath}' for key ${JSON.stringify(key)} overflows cosine similarity: every coordinate is finite but its squared magnitude is not, so it would rank as if it were orthogonal to every query. Scale that vector to a sane magnitude or delete it, then query again.`,
);

// Layout version 1 (in-memory only): Float64 [numeric key, length, ...coordinates].
// Blocks never split a record. Used length is separate from allocated capacity.
/**
 * The writer's option contract. Exported so VectorDB.createSnapshot() can refuse a bad options object
 * BEFORE it opens a connection, and createPackedSnapshot() can refuse it for callers that use this
 * module directly: one definition, two entry points (idb-vector-cej).
 */
export function assertSnapshotOptions(options) {
  assertOptionKeys("createSnapshot", options, SNAPSHOT_OPTION_KEYS, {
    example: "{ maxBytes: 64 * 1024 * 1024 }",
    hint: "Query options (limit, threshold) belong on the returned snapshot's query(), not on createSnapshot().",
  });
  const { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError(`createSnapshot() maxBytes must be a nonnegative safe integer byte budget for the packed cache; got ${describe(maxBytes)}`);
  }
  return options;
}

export async function createPackedSnapshot(db, storeName, vectorPath, options, cosine, validateQuery = null) {
  // The writer honours one option. Anything else is refused before a single record is read, rather than
  // destructured away: a caller who passed `limit` here believed the snapshot was bounded by it
  // (idb-vector-cej).
  const { maxBytes } = assertSnapshotOptions(options);
  let blocks = [], bytes = 0, mode = 'live', reason = null, diagnostic = null, refreshing, closed = false, generation = 0;
  let currentTx = null, rejectInFlight = null;
  const budget = Math.floor(maxBytes / 8) * 8;
  // 1 MiB allocations avoid copying/growing a contiguous 100 MB buffer; budget may be smaller.
  const blockBytes = Math.min(1024 * 1024, budget);
  const freeBlocks = list => {
    for (const block of list) {
      if (block?.data?.buffer && typeof block.data.buffer.transfer === 'function') {
        try { block.data.buffer.transfer(0); } catch {}
      }
    }
  };
  const snapshot = {
    get mode() { return closed ? 'closed' : mode; },
    get reason() { return reason; },
    get bytes() { return bytes; },
    get diagnostic() { return diagnostic; },
    formatVersion: 1,
    refresh() {
      if (closed) return Promise.reject(new Error('Snapshot is closed'));
      if (refreshing) return refreshing;
      const currentGen = ++generation;
      // Evict first: a refresh must not transiently retain two whole caches (reports/packed-snapshot.md:35).
      freeBlocks(blocks);
      blocks = []; bytes = 0; reason = null; mode = 'loading';
      let stats = moments(), diagnosticError = null;
      const evict = why => { freeBlocks(blocks); blocks = []; bytes = 0; reason = why; };
      refreshing = new Promise((resolve, reject) => {
        let settled = false;
        const settleReject = (err) => {
          if (settled) return;
          settled = true;
          rejectInFlight = null;
          evict('refresh-failed');
          mode = closed ? 'closed' : 'live';
          reject(err);
        };
        const settleResolve = (val) => {
          if (settled) return;
          settled = true;
          rejectInFlight = null;
          resolve(val);
        };
        rejectInFlight = (err) => {
          settleReject(err);
        };
        const tx = db.transaction(storeName);
        currentTx = tx;
        const request = tx.objectStore(storeName).openCursor();
        request.onsuccess = () => {
          if (settled) return;
          if (closed || currentGen !== generation) {
            settleReject(new Error('Snapshot is closed'));
            return;
          }
          try {
            const cursor = request.result;
            if (!cursor) return;
            const vector = cursor.value?.[vectorPath];
            if (stats) {
              try { stats.add(vector); } catch (error) { diagnosticError = error.message; stats = null; }
            }
            if (!reason && !closed) {
              if (typeof cursor.key !== 'number' || !Number.isFinite(cursor.key) || !finiteVector(vector)) evict('unsupported-key-or-vector');
              else {
                const length = vector.length + 2;
                let block = blocks.at(-1);
                if (!block || block.used + length > block.data.length) {
                  const size = Math.min(Math.max(blockBytes, length * 8), budget - bytes);
                  if (size < length * 8) evict('memory-budget');
                  else {
                    try { block = { data: new Float64Array(size / 8), used: 0 }; }
                    catch { evict('allocation-failed'); }
                    if (!reason) { blocks.push(block); bytes += size; }
                  }
                }
                if (!reason) {
                  block.data[block.used++] = cursor.key;
                  block.data[block.used++] = vector.length;
                  block.data.set(vector, block.used); block.used += vector.length;
                }
              }
            }
            cursor.continue();
          } catch (error) {
            settleReject(error);
          }
        };
        tx.oncomplete = () => {
          if (settled) return;
          if (closed || currentGen !== generation) {
            settleReject(new Error('Snapshot is closed'));
            return;
          }
          diagnostic = stats ? stats.result() : { warning: null, limitation: diagnosticError };
          mode = reason ? 'live' : 'snapshot';
          settleResolve(snapshot);
        };
        tx.onabort = () => {
          if (settled) return;
          if (closed || currentGen !== generation) {
            settleReject(new Error('Snapshot is closed'));
          } else {
            settleReject(tx.error ?? new Error('Snapshot refresh aborted'));
          }
        };
      }).finally(() => {
        if (currentGen === generation) {
          refreshing = null;
          rejectInFlight = null;
          currentTx = null;
        }
      });
      return refreshing;
    },
    async query(query, options) {
      // The reader validates the same contract the writer does before it reads anything: the limit goes
      // through the shared assertLimit (a NaN limit used to disable SortedArray's truncation test, so the
      // ranking grew with the corpus; a negative one inverted slice()), and a key this method does not
      // honour is refused rather than ignored (idb-vector-cej).
      assertOptionKeys("snapshot.query", options, SNAPSHOT_QUERY_OPTION_KEYS, {
        absent: "allow",
        example: "{ limit: 10 }",
        hint: "A snapshot ranks the top-k without a threshold or predicate; use db.query() or db.queryCandidates() when you need one.",
      });
      const limit = assertLimit(options?.limit === undefined ? DEFAULT_LIMIT : options.limit);
      if (refreshing) await refreshing;
      if (closed) throw new Error('Snapshot is closed');
      if (!query || !Array.from(query).every(Number.isFinite)) throw new TypeError('Snapshot query coordinates must be finite numbers');
      // Validate the query's magnitude BEFORE either path reads anything. In snapshot mode an
      // overflowing norm silently scores every record 0 and returns insertion order, and in live mode
      // it used to throw inside the cursor's onsuccess handler, escaping the surrounding promise and
      // hanging the query instead of rejecting it (idb-vector-2yi). index.js supplies its own query
      // validator so a snapshot query is refused exactly as query() is, with one message.
      validateQuery?.(query, 'Snapshot query');
      const top = new SortedArray(limit, 'similarity');
      // Skipping an unusable record is deliberate (idb-vector-bob: one bad vector must never poison
      // top-k), but it used to be silent: the caller got a complete-looking result set from an
      // incomplete corpus. Count the refusals by cause and hand them back with the results, so a
      // caller can tell "no match" from "this store will never be fully searchable" (idb-vector-6bq).
      const skipped = { total: 0, dimensionMismatch: 0, unsupportedVector: 0, nonFiniteSimilarity: 0 };
      const skip = (cause) => { skipped.total += 1; skipped[cause] += 1; };
      if (mode === 'snapshot') {
        const queryNorm = Math.sqrt(query.reduce((sum, value) => sum + value * value, 0));
        for (const block of blocks) for (let offset = 0; offset < block.used;) {
          const key = block.data[offset++], length = block.data[offset++];
          if (length === query.length) {
            let dot = 0, norm = 0;
            for (let i = 0; i < length; i++) { const value = block.data[offset+i]; dot += query[i]*value; norm += value*value; }
            if (!Number.isFinite(norm)) throw overflowingRecord(vectorPath, key);
            const similarity = dot / (queryNorm * Math.sqrt(norm));
            if (Number.isFinite(similarity)) top.insert({ key, similarity });
            else skip('nonFiniteSimilarity');
          } else skip('dimensionMismatch');
          offset += length;
        }
        return { mode: 'snapshot', results: top.slice(0, limit), skipped };
      }
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName), request = tx.objectStore(storeName).openCursor();
        request.onsuccess = () => {
          try {
            const cursor = request.result;
            if (!cursor) return;
            const vector = cursor.value?.[vectorPath];
            // A live fallback retains string keys, but invalid vectors must never poison top-k.
            if (!finiteVector(vector)) skip('unsupportedVector');
            else if (vector.length !== query.length) skip('dimensionMismatch');
            else {
              const similarity = cosine(query, vector);
              // An overflowing stored magnitude shows up as an UNSCORABLE score, and there are two
              // shapes of it: 0 when only the record's norm overflows (finite / Infinity), and NaN
              // when the query's magnitude is large enough that the dot product overflows too
              // (Infinity / Infinity). Checking only the 0 shape let the NaN shape fall through to
              // the skip below and bury the record silently (idb-vector-dy5), so both are tested -
              // and the record's own norm is what decides, because the query's magnitude is the
              // caller's business, not this record's. A healthy score pays nothing extra, and an
              // orthogonal record pays one pass over the vector.
              if (!Number.isFinite(similarity) || similarity === 0) {
                const normSq = vector.reduce((sum, value) => sum + value * value, 0);
                if (!Number.isFinite(normSq)) throw overflowingRecord(vectorPath, cursor.key);
              }
              if (Number.isFinite(similarity)) top.insert({ key: cursor.key, similarity });
              else skip('nonFiniteSimilarity');
            }
            cursor.continue();
          } catch (error) {
            // A refusal has to reject this promise: throwing from inside an IDB callback escapes it
            // and leaves the query pending forever (idb-vector-2yi).
            reject(error);
          }
        };
        tx.oncomplete = () => resolve({ mode: 'live', results: top.slice(0, limit), skipped });
        tx.onabort = () => reject(tx.error ?? new Error('Live snapshot query aborted'));
      });
    },
    close() {
      closed = true;
      generation++;
      freeBlocks(blocks);
      blocks = [];
      bytes = 0;
      mode = 'closed';
      if (rejectInFlight) {
        const reject = rejectInFlight;
        rejectInFlight = null;
        reject(new Error('Snapshot is closed'));
      }
      refreshing = null;
      try { currentTx?.abort(); } catch {}
      currentTx = null;
    }
  };
  await snapshot.refresh();
  return snapshot;
}
