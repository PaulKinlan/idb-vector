import { SortedArray } from './sortedarray.js';
import { moments } from './geometry.js';

const finiteVector = vector => Array.isArray(vector) && Array.from(vector).every(Number.isFinite);

// Layout version 1 (in-memory only): Float64 [numeric key, length, ...coordinates].
// Blocks never split a record. Used length is separate from allocated capacity.
export async function createPackedSnapshot(db, storeName, vectorPath, { maxBytes }, cosine, validateQuery = null) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a nonnegative safe integer');
  let blocks = [], bytes = 0, mode = 'live', reason = null, diagnostic = null, refreshing, closed = false;
  const budget = Math.floor(maxBytes / 8) * 8;
  // 1 MiB allocations avoid copying/growing a contiguous 100 MB buffer; budget may be smaller.
  const blockBytes = Math.min(1024 * 1024, budget);
  const snapshot = {
    get mode() { return closed ? 'closed' : mode; },
    get reason() { return reason; },
    get bytes() { return bytes; },
    get diagnostic() { return diagnostic; },
    formatVersion: 1,
    refresh() {
      if (closed) return Promise.reject(new Error('Snapshot is closed'));
      if (refreshing) return refreshing;
      // Evict first: a refresh must not transiently retain two whole caches.
      blocks = []; bytes = 0; reason = null; mode = 'loading';
      refreshing = new Promise((resolve, reject) => {
        let stats = moments(), diagnosticError = null;
        const tx = db.transaction(storeName), request = tx.objectStore(storeName).openCursor();
        const evict = why => { blocks = []; bytes = 0; reason = why; };
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const vector = cursor.value[vectorPath];
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
        };
        tx.oncomplete = () => {
          diagnostic = stats ? stats.result() : { warning: null, limitation: diagnosticError };
          if (closed) { blocks = []; bytes = 0; }
          else mode = reason ? 'live' : 'snapshot';
          resolve(snapshot);
        };
        tx.onabort = () => { evict('refresh-failed'); mode = 'live'; reject(tx.error ?? new Error('Snapshot refresh aborted')); };
      }).finally(() => { refreshing = null; });
      return refreshing;
    },
    async query(query, { limit = 10 } = {}) {
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
          const cursor = request.result;
          if (!cursor) return;
          const vector = cursor.value?.[vectorPath];
          // A live fallback retains string keys, but invalid vectors must never poison top-k.
          if (!finiteVector(vector)) skip('unsupportedVector');
          else if (vector.length !== query.length) skip('dimensionMismatch');
          else {
            const similarity = cosine(query, vector);
            if (Number.isFinite(similarity)) top.insert({ key: cursor.key, similarity });
            else skip('nonFiniteSimilarity');
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve({ mode: 'live', results: top.slice(0, limit), skipped });
        tx.onabort = () => reject(tx.error ?? new Error('Live snapshot query aborted'));
      });
    },
    close() { closed = true; blocks = []; bytes = 0; }
  };
  await snapshot.refresh();
  return snapshot;
}
