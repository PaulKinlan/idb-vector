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

  // One length predicate for the four tables plus the key array: an array-like
  // with a usable integer length, short of what the indexed reads require.
  const requireLength = (name, value, required, { arrayOnly = false } = {}) => {
    if (arrayOnly && !Array.isArray(value)) {
      throw corrupt(`${name} must be an array of exact primary keys, got ${typeof value}`);
    }
    const length = value !== null && typeof value === 'object' && Number.isSafeInteger(value.length)
      ? value.length
      : null;
    if (length === null || length < required) {
      throw corrupt(`${name}.length is ${length === null ? 'missing or not an integer' : length}, expected at least ${required}`);
    }
  };

  requireLength('keys', keys, count, { arrayOnly: true });
  requireLength('norms', norms, count);
  requireLength('codes', codes, count * dims);
  requireLength('mins', mins, dims);
  requireLength('scales', scales, dims);
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
    const similarity = dot / (queryMagnitude * (Math.sqrt(normSq) || 1));

    if (threshold !== null && similarity < threshold) {
      continue;
    }

    top.insert({ object: record, key, similarity });
  }

  return Array.from(top.slice(0, limit));
}

