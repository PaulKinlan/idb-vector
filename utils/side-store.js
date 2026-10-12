// utils/side-store.js — compact int8 code side-store with bounded exact rerank (idb-vector-kuc.10)
import { SortedArray } from './sortedarray.js';

// Precomputes the L2 norm of a vector.
export function vectorNorm(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    sum += vector[i] * vector[i];
  }
  return Math.sqrt(sum);
}

// Builds an int8 scalar quantized code record from an array of records.
// Each vector coordinate is mapped to [-127, 127] via per-dimension affine tables (mins, scales).
// Storage per 100k x 128: 12.8 MB of codes + 400 KB norms + 1 KB affine tables (~13.2 MB total),
// 25% of the original Float32 bytes and 12.5% of Float64.
export function buildCodeRecord(records, options = {}) {
  const {
    revision = 1,
    vectorPath = 'embedding',
    keyPath = 'id',
  } = options;

  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`revision must be a nonnegative safe integer; got ${revision}`);
  }

  const count = records.length;
  if (count === 0) {
    const dims = options.dims ?? 0;
    return {
      revision,
      count: 0,
      dims,
      keys: [],
      codes: new Int8Array(0),
      norms: new Float32Array(0),
      mins: new Float32Array(dims),
      scales: new Float32Array(dims),
      bytes: 0,
    };
  }

  const firstVector = records[0][vectorPath] ?? records[0].vector;
  if (!Array.isArray(firstVector) && !ArrayBuffer.isView(firstVector)) {
    throw new TypeError(`Record vector at path "${vectorPath}" must be an Array or TypedArray`);
  }
  const dims = options.dims ?? firstVector.length;

  const keys = new Array(count);
  const norms = new Float32Array(count);
  const mins = new Float32Array(dims);
  const scales = new Float32Array(dims);

  mins.fill(Infinity);
  const maxs = new Float32Array(dims);
  maxs.fill(-Infinity);

  // First pass: record keys, compute norms, find per-dimension min and max
  for (let i = 0; i < count; i++) {
    const rec = records[i];
    const key = rec[keyPath] ?? rec.key ?? rec.id ?? i;
    keys[i] = key;

    const vec = rec[vectorPath] ?? rec.vector;
    if (!vec || vec.length !== dims) {
      throw new Error(`Record ${JSON.stringify(key)} has vector length ${vec?.length}, expected ${dims}`);
    }

    let normSq = 0;
    for (let d = 0; d < dims; d++) {
      const val = vec[d];
      if (!Number.isFinite(val)) {
        throw new TypeError(`Record ${JSON.stringify(key)} coordinate ${d} is not a finite number: ${val}`);
      }
      normSq += val * val;
      if (val < mins[d]) mins[d] = val;
      if (val > maxs[d]) maxs[d] = val;
    }
    norms[i] = Math.sqrt(normSq);
  }

  // Compute per-dimension scales
  for (let d = 0; d < dims; d++) {
    scales[d] = (maxs[d] - mins[d]) / 254 || 1;
  }

  // Second pass: quantize each vector to int8 (-127..127)
  const codes = new Int8Array(count * dims);
  for (let i = 0; i < count; i++) {
    const vec = records[i][vectorPath] ?? records[i].vector;
    const base = i * dims;
    for (let d = 0; d < dims; d++) {
      codes[base + d] = Math.round((vec[d] - mins[d]) / scales[d]) - 127;
    }
  }

  const bytes = codes.byteLength + norms.byteLength + mins.byteLength + scales.byteLength;

  return {
    revision,
    count,
    dims,
    keys,
    codes,
    norms,
    mins,
    scales,
    bytes,
  };
}

// Precomputes query weights and constant offset for SQ8 dot product scoring.
// w[d] = query[d] * scales[d]
// offset = sum(query[d] * (mins[d] + 127 * scales[d]))
export function sq8QueryWeights(queryVector, mins, scales) {
  const dims = mins.length;
  const w = new Float64Array(dims);
  let offset = 0;
  for (let d = 0; d < dims; d++) {
    w[d] = queryVector[d] * scales[d];
    offset += queryVector[d] * (mins[d] + 127 * scales[d]);
  }
  return { w, offset };
}

// Scans the code record to find the top candidate indices/keys.
// Bounded by candidateBudget (default <= 300).
// eligibleKeys: optional Set or (key => boolean) predicate to filter codes before scoring (predicate-before-candidate).
export function scanSideStore(codeRecord, queryVector, candidateBudget = 300, eligibleKeys = null) {
  if (!codeRecord || typeof codeRecord !== 'object') {
    throw new TypeError('codeRecord must be an object');
  }
  const { count, dims, keys, codes, norms, mins, scales } = codeRecord;
  if (queryVector.length !== dims) {
    throw new TypeError(`queryVector has ${queryVector.length} dimensions, expected ${dims}`);
  }

  const budget = Math.max(1, Math.min(candidateBudget, count));
  const { w, offset } = sq8QueryWeights(queryVector, mins, scales);
  const candidates = new SortedArray(budget, 'score');

  const hasFilter = eligibleKeys !== null && eligibleKeys !== undefined;
  const isSet = hasFilter && typeof eligibleKeys.has === 'function';
  const isFn = hasFilter && !isSet && typeof eligibleKeys === 'function';

  for (let i = 0; i < count; i++) {
    const key = keys ? keys[i] : i;
    if (hasFilter) {
      if (isSet && !eligibleKeys.has(key)) continue;
      if (isFn && !eligibleKeys(key)) continue;
    }

    let dot = offset;
    const base = i * dims;
    for (let d = 0; d < dims; d++) {
      dot += w[d] * codes[base + d];
    }
    const norm = norms[i] || 1;
    const score = dot / norm;

    candidates.insert({ index: i, key, score });
  }

  return Array.from(candidates.slice(0, budget));
}

// Exact Float64 cosine rerank over fetched original records.
// Verifies 0 dead rows on the current pinned revision, and verifies that fetched
// original records match the pinned revision when they carry a revision property (criterion 4).
export function rerankCandidates(fetchedRecords, vectorPath, queryVector, limit = 10, threshold = null, expectedRevision = null, revisionPath = 'revision') {
  let queryNormSq = 0;
  for (let d = 0; d < queryVector.length; d++) {
    queryNormSq += queryVector[d] * queryVector[d];
  }
  const queryMagnitude = Math.sqrt(queryNormSq) || 1;

  const top = new SortedArray(limit, 'similarity');
  const queryDims = queryVector.length;

  for (let i = 0; i < fetchedRecords.length; i++) {
    const record = fetchedRecords[i];
    if (record === undefined || record === null) {
      throw new Error(`Candidate record at index ${i} is missing or deleted; 0 dead rows acceptable on the current revision`);
    }

    const key = record.id ?? record.key ?? i;

    // Revision check: the record carries a revision; a query pins one and must refuse a record from another revision (acceptance criterion 4)
    if (expectedRevision !== null && expectedRevision !== undefined) {
      const recordRev = record[revisionPath];
      if (recordRev !== undefined && recordRev !== expectedRevision) {
        throw new Error(`Record ${JSON.stringify(key)} has revision ${recordRev}, but query pinned revision ${expectedRevision}`);
      }
    }

    const vector = record[vectorPath];
    if (!Array.isArray(vector) && !ArrayBuffer.isView(vector)) {
      throw new TypeError(`Record has invalid vectorPath "${vectorPath}"`);
    }
    if (vector.length !== queryDims) {
      throw new TypeError(`Record has vector length ${vector.length}, expected ${queryDims}`);
    }

    let dot = 0;
    let normSq = 0;
    for (let d = 0; d < queryDims; d++) {
      const v = vector[d];
      dot += queryVector[d] * v;
      normSq += v * v;
    }
    const similarity = dot / (queryMagnitude * (Math.sqrt(normSq) || 1));

    if (threshold !== null && similarity < threshold) {
      continue;
    }

    top.insert({ object: record, key, similarity });
  }

  return Array.from(top.slice(0, limit));
}
