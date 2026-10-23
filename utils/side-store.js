// utils/side-store.js — opt-in int8 code side-store with bounded exact rerank (ADR 0001)
import { SortedArray } from './sortedarray.js';

export function vectorNorm(vector) {
  let sumSq = 0;
  for (let i = 0; i < vector.length; i++) {
    sumSq += vector[i] * vector[i];
  }
  return Math.sqrt(sumSq) || 1;
}

// Unambiguous tagged tuples: JSON encodes array boundaries and escapes string content.
// Only IndexedDB key types are accepted; unsupported keys must not collide with a valid key.
export function canonicalKey(key) {
  const encode = (value) => {
    if (typeof value === 'number' && !Number.isNaN(value)) {
      // JSON.stringify(Infinity) becomes null, so tag the two legal infinite IDB
      // keys separately; -0 and +0 remain the same IndexedDB key.
      return ['number', value === Infinity ? '+Infinity' : value === -Infinity ? '-Infinity' : value === 0 ? 0 : value];
    }
    if (typeof value === 'string') return ['string', value];
    if (value instanceof Date && Number.isFinite(value.getTime())) return ['date', value.getTime()];
    if (Array.isArray(value)) return ['array', value.map(encode)];
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return ['binary', Array.from(bytes)];
    }
    throw new TypeError('eligibleKeys must contain valid IndexedDB primary keys');
  };
  return JSON.stringify(encode(key));
}

// Builds an INT8 affine code record with per-dimension min/scale tables and precomputed L2 norms.
// Exact primary keys must be provided via options.keys (matching cursor.primaryKey, ADR 0001).
export function buildCodeRecord(records, options = {}) {
  const {
    epoch = options.revision ?? null,
    vectorPath = 'embedding',
    keys: explicitKeys = null,
  } = options;

  if (epoch === null || epoch === undefined) {
    throw new TypeError('buildCodeRecord() requires a store-wide epoch/revision (ADR 0001 Invariant 8)');
  }

  const count = records.length;
  if (!Array.isArray(explicitKeys) || explicitKeys.length !== count) {
    throw new TypeError('buildCodeRecord() requires one exact IndexedDB primary key per record (cursor.primaryKey)');
  }
  if (count === 0) {
    return {
      epoch,
      revision: epoch,
      count: 0,
      dims: 0,
      keys: [],
      norms: new Float64Array(0),
      mins: new Float64Array(0),
      scales: new Float64Array(0),
      codes: new Int8Array(0),
      bytes: 0,
    };
  }

  const sampleVec = records[0][vectorPath] ?? records[0].vector;
  if (!sampleVec || typeof sampleVec.length !== 'number' || sampleVec.length === 0) {
    throw new Error(`Record at index 0 has invalid or empty vectorPath "${vectorPath}"`);
  }
  const dims = sampleVec.length;

  // Ranking-relevant metadata tables are stored in Float64 (idb-vector-rrq,
  // coord ruling: the code-record path must not narrow ranking-relevant values
  // to Float32 at all). The codes remain Int8 — that is the deliberate SQ8
  // quantization the ADR sells — but norms/mins/scales were never the point of
  // the format, and every silent-corruption surface this store has had
  // (norm overflow, norm underflow, scale underflow, query-weight overflow)
  // was a Float32 narrowing of one of these tables.
  const keys = new Array(count);
  const norms = new Float64Array(count);
  const mins = new Float64Array(dims);
  const scales = new Float64Array(dims);

  mins.fill(Infinity);
  const maxs = new Float64Array(dims);
  maxs.fill(-Infinity);

  // First pass: extract primary keys, compute L2 norms, find per-dimension min and max
  for (let i = 0; i < count; i++) {
    const rec = records[i];
    const key = explicitKeys[i];
    if (key === undefined) {
      throw new Error(`Record at index ${i} has no identifiable primary key`);
    }
    keys[i] = key;

    const vec = rec[vectorPath] ?? rec.vector;
    if (!vec || vec.length !== dims) {
      throw new Error(`Record ${JSON.stringify(key)} has vector length ${vec?.length}, expected ${dims}`);
    }

    let normSq = 0;
    let sawNonzero = false;
    for (let d = 0; d < dims; d++) {
      const val = vec[d];
      if (!Number.isFinite(val)) {
        throw new TypeError(`Record ${JSON.stringify(key)} coordinate ${d} is not a finite number: ${val}`);
      }
      if (val !== 0) sawNonzero = true;
      normSq += val * val;
      if (val < mins[d]) mins[d] = val;
      if (val > maxs[d]) maxs[d] = val;
    }
    const norm = Math.sqrt(normSq);
    norms[i] = norm;
    // With Float64 storage these are tripwires, not load-bearing guards: a
    // non-finite norm needs coordinates ~1e154+, and a zero norm is either an
    // all-zero vector (cosine undefined/NaN; insert() and rerankCandidates()
    // refuse those too) or an f64-underflowing normSq. Either way a stored 0
    // norm is ALWAYS corruption, which lets scanSideStore() reject legacy
    // f32-era records loudly instead of silently mis-ranking them.
    if (!Number.isFinite(norms[i])) {
      throw new TypeError(`Record ${JSON.stringify(key)} has non-finite L2 norm ${norm}; storing it would silently corrupt candidate ranking`);
    }
    if (norms[i] === 0) {
      if (sawNonzero) {
        throw new TypeError(`Record ${JSON.stringify(key)} has an L2 norm that underflows even Float64; storing it would silently corrupt candidate ranking`);
      }
      throw new TypeError(`Record ${JSON.stringify(key)} is an all-zero vector; cosine similarity is undefined (NaN) and the exact rerank refuses it`);
    }
  }

  // Compute per-dimension scales. There is deliberately NO guard on this
  // assignment: `range / 254 || 1` already makes every stored scale positive
  // and finite by construction, so a check here would be unreachable code that
  // still reads like a defence (idb-vector-blj reviewed the pair that used to
  // sit here and proved neither branch could fire). The two cases a reader
  // might expect to be caught are covered without one:
  //   - A range that underflows `range / 254` to a zero quotient (|range| below
  //     ~1.3e-321) takes the `|| 1` fallback and stores exactly 1, never 0. The
  //     quantization error is then bounded by that subnormal range, which is
  //     ~140 orders of magnitude below any coordinate large enough to keep the
  //     L2 norm representable, so ranking is unaffected - not silently
  //     corrupted.
  //   - A non-finite range needs `max - min > 1.79e308`, i.e. some |coordinate|
  //     above ~8.9e307, whose square already overflows and is rejected by the
  //     non-finite L2 norm check in the first pass above. This loop cannot
  //     even be reached with one.
  // The load-bearing guards are that norm check (build) and the
  // non-positive/non-finite scale check in sq8QueryWeights() (read path, for
  // records published before this validation existed).
  for (let d = 0; d < dims; d++) {
    scales[d] = (maxs[d] - mins[d]) / 254 || 1;
  }

  // Second pass: quantize each vector to int8 (-127..127)
  const codes = new Int8Array(count * dims);
  for (let i = 0; i < count; i++) {
    const vec = records[i][vectorPath] ?? records[i].vector;
    const offset = i * dims;
    for (let d = 0; d < dims; d++) {
      const scaled = (vec[d] - mins[d]) / scales[d] - 127;
      codes[offset + d] = Math.max(-127, Math.min(127, Math.round(scaled)));
    }
  }

  const bytes = codes.byteLength + norms.byteLength + mins.byteLength + scales.byteLength;

  return {
    epoch,
    revision: epoch,
    count,
    dims,
    keys,
    norms,
    mins,
    scales,
    codes,
    bytes,
  };
}

// Compute query weights and constant offset for SQ8 dot product scoring
export function sq8QueryWeights(queryVector, mins, scales) {
  const dims = queryVector.length;
  // Weights are transient per-query intermediates, never stored, so there is no
  // reason to narrow them early: a finite q*scale beyond Float32 range (e.g.
  // q=1e38 over a fully representable corpus) silently became Infinity here and
  // corrupted the bounded scan even when every stored table was valid
  // (idb-vector-p3o). Keep Float64, matching the research harness.
  const weights = new Float64Array(dims);
  let baseOffset = 0;

  for (let d = 0; d < dims; d++) {
    const q = queryVector[d];
    const s = scales[d];
    const m = mins[d];
    // A stored scale that is not positive and finite means the record was
    // built before scale validation existed (underflow rounds to stored 0).
    // No legitimate build stores that (constant dimensions take the || 1
    // fallback), so fail loudly rather than silently mis-ranking
    // (idb-vector-rrq).
    if (!(s > 0) || !Number.isFinite(s)) {
      throw new TypeError(`Stored code record has a non-positive or non-finite scale at dimension ${d}; it cannot be scored safely. Rebuild the side-store.`);
    }
    weights[d] = q * s;
    baseOffset += q * (m + 127 * s);
  }

  return { weights, baseOffset };
}

// Cosine similarity is scale-invariant; its intermediates are not. Both scoring paths below square
// the query's coordinates to get its magnitude, so any |coordinate| above ~1.34e154
// (sqrt(Number.MAX_VALUE)) overflows Float64 and the magnitude becomes Infinity. Every score then
// collapses to finite/Infinity = 0, which reads as an all-tie corpus: SortedArray returns insertion
// order and the caller gets a plausible, wrong ranking instead of an error (idb-vector-utq). Refuse
// such a query, mirroring the non-finite stored-norm guard on the record side; a caller can
// normalize first because the similarity never depended on the query's length.
// `|| 1` keeps an all-zero query (every score 0, as before) from dividing by zero.
function scoreableQueryMagnitude(queryVector, label) {
  let queryNormSq = 0;
  for (let d = 0; d < queryVector.length; d++) {
    queryNormSq += queryVector[d] * queryVector[d];
  }
  const magnitude = Math.sqrt(queryNormSq);
  if (!Number.isFinite(magnitude)) {
    throw new TypeError(`${label} has a non-finite L2 magnitude (${magnitude}): the coordinates must be finite, and one above ~1.34e154 overflows Float64 so every cosine score would collapse to 0. Normalize the query first.`);
  }
  return magnitude || 1;
}

// A typed array's real length comes from %TypedArray%.prototype's `length`
// getter, not from `codes.length`: `length` is configurable on a typed array
// instance, so an own property shadows the getter and reports a length the
// buffer does not have. A real Int8Array(1) carrying
// Object.defineProperty(codes, 'length', { value: 4 }) passed
// ArrayBuffer.isView + instanceof + a `.length` comparison and then ranked
// [{"key":"worst","score":"NaN"},{"key":"best","score":"NaN"}] (review finding
// idb-vector-5xr). Capture the intrinsic accessor once and call it, so no own
// property can answer for the buffer.
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Int8Array.prototype),
  'length',
).get;

// A persisted code record is untrusted input. buildCodeRecord() is the only
// correct producer, but a scan reads whatever IndexedDB hands back: a record
// written by an older layout, a truncated write, or an object a caller
// assembled itself. Every indexed read in the scan below trusts the shape —
// keys[i], norms[i], codes[i * dims + d], mins[d], scales[d] — so a short or
// missing array reads `undefined`, poisons the dot product to NaN, and
// SortedArray inserts that NaN score quite happily: the caller gets a
// plausible, wrong top-k instead of a refusal (idb-vector-bmq). Validate the
// shape once, up front, and fail loudly with a rebuild instruction, the same
// stance the norm and scale tripwires take for degenerate values. Only the
// truncation direction is a hazard, so trailing extra entries are accepted:
// they are never read and cannot change a score.
//
// A length is not a shape: `{ length: count * dims }` is storable in IndexedDB
// and has the right length with no elements at all, so each table must also be
// a real Array or typed array, identified by internal slot rather than by a
// forgeable brand (review findings on idb-vector-bmq, P2).
//
// THREAT MODEL - what this guard is and is not (coord ruling after the third
// review round). It defends the PERSIST / READ-BACK path: a record arrives from
// IndexedDB structured clone, which preserves an Array's or typed array's type
// and intrinsic length and drops own non-index properties, so a truncated
// write, a foreign or older layout, an array-like stand-in, or a value that
// does not fit its table is refused instead of mis-ranking.
// It is NOT a sandbox against code running in the same realm as the caller: a
// caller that can redefine properties on built-ins (own `length` on a typed
// array, patching ArrayBuffer.isView) can also write the records it wants
// straight into the store, so it needs no bypass. Where a forgery is cheap to
// close we close it anyway - codes is identified by internal slot and its
// length is read through the intrinsic getter (idb-vector-44v, idb-vector-5xr)
// - but anything that only works by forging properties in-process is OUT OF
// SCOPE by design, and the right answer to it is this paragraph, not another
// round of guessing which built-in gets shadowed next.
//
// The four tables are then defended where they are read, at a cost that stays
// off the hot loop:
//   - codes is the big one (count * dims). It is checked by TYPE, not value:
//     the ADR's format is Int8Array, and an integer container cannot carry
//     undefined or NaN into the dot product. A value scan here would double the
//     cost of the hottest loop in the store for no extra guarantee.
//   - mins is dims long, so its values are checked up front: a NaN min poisons
//     baseOffset for EVERY score, which no per-row tripwire would see.
//   - scales are checked by sq8QueryWeights() for every dimension before any
//     score is computed (positive and finite), and norms per scored row, so
//     neither needs a second pass here.
function assertCodeRecordShape(codeRecord) {
  const corrupt = (reason) =>
    new TypeError(`Stored code record is not scorable: ${reason}. Rebuild the side-store.`);

  if (codeRecord === null || typeof codeRecord !== 'object') {
    throw corrupt(`expected a code-record object, got ${codeRecord === null ? 'null' : typeof codeRecord}`);
  }

  const { count, dims, keys, norms, mins, scales, codes } = codeRecord;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw corrupt(`count must be a non-negative integer, got ${String(count)}`);
  }
  // The epoch stamp (mirrored as revision since the format was introduced) is
  // what ties a record to the corpus it was built from (ADR 0001 Invariant 8).
  // querySideStore() pins and compares it, but the scan itself must not score
  // an unstamped record either: nothing would show it belongs to the corpus
  // being queried, and every build since this format existed stamps it.
  for (const field of ['epoch', 'revision']) {
    if (codeRecord[field] === undefined || codeRecord[field] === null) {
      throw corrupt(`the ${field} stamp is missing, so the record cannot be tied to a corpus revision (ADR 0001 Invariant 8)`);
    }
  }
  if (count === 0) return;
  if (!Number.isSafeInteger(dims) || dims < 1) {
    throw corrupt(`dims must be a positive integer for ${count} records, got ${String(dims)}`);
  }
  // Checking `length >= count * dims` is only meaningful if the product itself
  // is exact; beyond 2^53 the comparison would pass for a truncated array.
  if (!Number.isSafeInteger(count * dims)) {
    throw corrupt(`count * dims (${count} x ${dims}) is not a safe integer, so the code array length cannot be verified`);
  }

  // How a refusing message names the container it was handed.
  const shape = (value) => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'an Array';
    if (ArrayBuffer.isView(value)) return `a ${Object.prototype.toString.call(value).slice(8, -1)}`;
    const length = typeof value === 'object' && Number.isSafeInteger(value.length) ? ` with length ${value.length}` : '';
    return `a ${typeof value}${length}`;
  };

  // A table must be a real indexed container of at least the required length:
  // a plain object that only reports a length has nothing to read. A typed
  // array's length is read through the intrinsic getter, so an own `length`
  // property cannot claim buffer space that does not exist. A DataView is also
  // an ArrayBuffer view, survives structured clone, and has no indexed
  // elements: the typed-array getter throws for it, so the brand test IS the
  // getter - a receiver it refuses is not a typed array, and the caller gets
  // this field's guidance instead of a raw "incompatible receiver" TypeError
  // (review finding idb-vector-usa).
  const tableLength = (value) => {
    if (!ArrayBuffer.isView(value)) return value.length;
    try {
      return typedArrayLength.call(value);
    } catch {
      return null;
    }
  };
  const requireTable = (name, value, required) => {
    if (!Array.isArray(value) && !ArrayBuffer.isView(value)) {
      throw corrupt(`${name} must be an Array or a typed array, got ${shape(value)}`);
    }
    const length = tableLength(value);
    if (length === null) {
      throw corrupt(`${name} is ${shape(value)}, which has no typed-array elements to read; store an Array or a typed array`);
    }
    if (!Number.isSafeInteger(length) || length < required) {
      throw corrupt(`${name}.length is ${Number.isSafeInteger(length) ? length : 'missing or not an integer'}, expected at least ${required}`);
    }
  };

  // Exact primary keys: an Array, since a key can be any IndexedDB key type and
  // the scan canonicalises each one.
  requireTable('keys', keys, count);
  if (!Array.isArray(keys)) {
    throw corrupt(`keys must be an Array of exact primary keys, got ${shape(keys)}`);
  }
  // Identity by internal slot, never by a brand a caller can forge: `codes`
  // must be a real Int8Array (ADR 0001's format). Symbol.toStringTag is an own
  // property anyone can set, so a SPARSE Array with a forged tag read
  // `[object Int8Array]` and ranked NaN (review finding idb-vector-44v);
  // ArrayBuffer.isView() reads the slot instead, and `instanceof` keeps the
  // element type pinned while a prototype-only fake (Object.create(
  // Int8Array.prototype)) fails isView. An integer view cannot hold undefined
  // or NaN, and a value pass over count * dims would double the cost of the
  // store's hottest loop.
  if (!ArrayBuffer.isView(codes) || !(codes instanceof Int8Array)) {
    throw corrupt(`codes must be a real Int8Array of count * dims SQ8 codes (ADR 0001's format), got ${shape(codes)}; a sparse Array, an array-like object or a forged Symbol.toStringTag tag can carry undefined or NaN into the dot product`);
  }
  requireTable('codes', codes, count * dims);
  requireTable('norms', norms, count);
  requireTable('mins', mins, dims);
  requireTable('scales', scales, dims);
  // A NaN min reaches baseOffset once and poisons every score, so no per-row
  // check can catch it later.
  for (let d = 0; d < dims; d++) {
    if (!Number.isFinite(mins[d])) {
      throw corrupt(`mins[${d}] is ${String(mins[d])}, so every score's base offset would be NaN`);
    }
  }
}

// Scan int8 codes to select at most candidateBudget eligible candidates.
// Intersects eligibleKeys BEFORE candidate budget truncation (ADR 0001 Invariant 11).
// Uses canonical key serialization to match Date and Array keys by value (ADR 0001 Invariant 10).
export function scanSideStore(codeRecord, queryVector, candidateBudget = 300, eligibleKeys = null) {
  assertCodeRecordShape(codeRecord);
  const { count, dims, keys, norms, mins, scales, codes } = codeRecord;
  if (count === 0 || candidateBudget <= 0) return [];
  if (queryVector.length !== dims) {
    throw new TypeError(`Side-store query has ${queryVector.length} dimensions; expected ${dims}`);
  }

  const queryMagnitude = scoreableQueryMagnitude(queryVector, 'Query');

  const { weights, baseOffset } = sq8QueryWeights(queryVector, mins, scales);
  const budget = Math.min(candidateBudget, count);
  const candidates = new SortedArray(budget, 'score');

  let eligibleCanonicalSet = null;
  if (eligibleKeys !== null && eligibleKeys !== undefined) {
    if (typeof eligibleKeys === 'function') {
      throw new TypeError('eligibleKeys must be a collection of IndexedDB primary keys, not a predicate');
    }
    eligibleCanonicalSet = new Set();
    const iterable = eligibleKeys instanceof Set || Array.isArray(eligibleKeys)
      ? eligibleKeys
      : [eligibleKeys];
    for (const k of iterable) {
      eligibleCanonicalSet.add(canonicalKey(k));
    }
  }

  for (let i = 0; i < count; i++) {
    const key = keys[i];
    // The keys table can be a plain Array, so it can be sparse or hold explicit
    // undefined: without this the candidates come back with `key: undefined` and
    // the caller's fetch fails somewhere else, naming nothing (idb-vector-44v).
    if (key === undefined) {
      throw new TypeError(`Stored code record has no primary key at index ${i}, so its row cannot be matched to a stored record. Rebuild the side-store.`);
    }

    // Eligibility check before candidate scoring/truncation (ADR 0001 Invariant 11 & 10)
    if (eligibleCanonicalSet !== null && !eligibleCanonicalSet.has(canonicalKey(key))) {
      continue;
    }

    let dotApprox = 0;
    const offset = i * dims;
    for (let d = 0; d < dims; d++) {
      dotApprox += weights[d] * codes[offset + d];
    }
    const dot = dotApprox + baseOffset;
    // A stored norm that is not positive and finite means the record was built
    // before range validation existed: Infinity from Float32 overflow, or 0
    // from underflow / a zero vector. buildCodeRecord() no longer stores any of
    // these, so fail loudly (with a rebuild instruction) rather than silently
    // mis-ranking (idb-vector-pku).
    if (!(norms[i] > 0) || !Number.isFinite(norms[i])) {
      throw new TypeError(`Stored code record has a non-finite or zero norm at index ${i}; it cannot be scored safely. Rebuild the side-store.`);
    }
    const denom = queryMagnitude * norms[i];
    const score = dot / denom;

    candidates.insert({
      index: i,
      key,
      score,
    });
  }

  return Array.from(candidates.slice(0, budget));
}

// Exact Float64 cosine rerank over fetched original records.
// - Enforces 0 dead rows on the current pinned revision.
// - Preserves exact IndexedDB primary keys via candidateKeys (ADR 0001 Invariant 1).
export function rerankCandidates(
  fetchedRecords,
  vectorPath,
  queryVector,
  limit = 10,
  threshold = null,
  candidateKeys = null,
) {
  if (!Array.isArray(candidateKeys) || candidateKeys.length !== fetchedRecords.length) {
    throw new TypeError('rerankCandidates() requires the exact primary key of every fetched record');
  }
  const queryMagnitude = scoreableQueryMagnitude(queryVector, 'Query');

  const top = new SortedArray(limit, 'similarity');
  const queryDims = queryVector.length;

  for (let i = 0; i < fetchedRecords.length; i++) {
    const record = fetchedRecords[i];
    if (record === undefined || record === null) {
      throw new Error(`Candidate record at index ${i} is missing or deleted; 0 dead rows acceptable on the current revision`);
    }

    const key = candidateKeys[i];
    if (key === undefined) {
      throw new Error(`Candidate record at index ${i} has no identifiable primary key`);
    }

    const vector = record[vectorPath];
    if (!Array.isArray(vector)) {
      throw new TypeError(`Record has invalid vectorPath "${vectorPath}"`);
    }
    if (vector.length !== queryDims) {
      throw new TypeError(`Record has vector length ${vector.length}, expected ${queryDims}`);
    }

    let dot = 0;
    let normSq = 0;
    for (let d = 0; d < queryDims; d++) {
      const v = vector[d];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new TypeError(`Record ${JSON.stringify(key)} has an invalid vector coordinate ${d}`);
      }
      dot += queryVector[d] * v;
      normSq += v * v;
    }
    if (normSq === 0) throw new TypeError(`Record ${JSON.stringify(key)} has a zero vector`);
    // idb-vector-jdr: measure the record magnitude and refuse a non-finite one BY KEY, mirroring the
    // exact scan (index.js cfr) and the snapshot reads (c2o). normSq had no finiteness check, so a
    // coordinate above ~1.34e154 squared to Infinity, the norm became Infinity, and the score
    // dot / Infinity = 0 - a FINITE 0 that ranked the unscoreable record as orthogonal, silently
    // disagreeing with the exact paths that refuse the same record.
    const recordMagnitude = Math.sqrt(normSq);
    if (!Number.isFinite(recordMagnitude)) {
      throw new TypeError(`Record ${JSON.stringify(key)} has a vector whose squared magnitude overflows Float64 (norm ${recordMagnitude}): a coordinate above ~1.34e154 overflows, so its exact cosine score cannot be computed. Scale that record's vector to a sane magnitude or delete it, then query again.`);
    }
    // The former `Math.sqrt(normSq) || 1` is dead now: zero throws above, non-finite throws here.
    const similarity = dot / (queryMagnitude * recordMagnitude);
    // Mirrors index.js:551-557: the ranking must only ever see finite scores. Unreachable while the
    // two magnitude guards above hold (Cauchy-Schwarz bounds dot by MAX_VALUE), but it keeps that
    // invariant local if the hoisting changes, and a NaN score used to rank (idb-vector-dy5).
    if (!Number.isFinite(similarity)) {
      throw new TypeError(`Record ${JSON.stringify(key)} produced a non-finite cosine similarity (${similarity}) against a scoreable query, so its exact score cannot be computed. Scale the record's vector or the query, or delete the record, then query again.`);
    }

    if (threshold !== null && similarity < threshold) {
      continue;
    }

    top.insert({ object: record, key, similarity });
  }

  return Array.from(top.slice(0, limit));
}

