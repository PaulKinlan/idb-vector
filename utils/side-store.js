// utils/side-store.js — opt-in int8 code side-store with bounded exact rerank (ADR 0001)
import { SortedArray } from './sortedarray.js';

export function vectorNorm(vector) {
  let sumSq = 0;
  for (let i = 0; i < vector.length; i++) {
    sumSq += vector[i] * vector[i];
  }
  return Math.sqrt(sumSq) || 1;
}

// Builds an INT8 affine code record with per-dimension min/scale tables and precomputed L2 norms.
// Exact primary keys must be provided via options.keys (matching cursor.primaryKey, ADR 0001).
export function buildCodeRecord(records, options = {}) {
  const {
    revision = 1,
    vectorPath = 'embedding',
    keys: explicitKeys = null,
    revisionPath = 'revision',
  } = options;

  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError(`revision must be a nonnegative safe integer; got ${revision}`);
  }

  const count = records.length;
  if (count === 0) {
    return {
      revision,
      count: 0,
      dims: 0,
      keys: [],
      norms: new Float32Array(0),
      mins: new Float32Array(0),
      scales: new Float32Array(0),
      codes: new Int8Array(0),
      bytes: 0,
    };
  }

  const sampleVec = records[0][vectorPath] ?? records[0].vector;
  if (!sampleVec || typeof sampleVec.length !== 'number' || sampleVec.length === 0) {
    throw new Error(`Record at index 0 has invalid or empty vectorPath "${vectorPath}"`);
  }
  const dims = sampleVec.length;

  const keys = new Array(count);
  const norms = new Float32Array(count);
  const mins = new Float32Array(dims);
  const scales = new Float32Array(dims);

  mins.fill(Infinity);
  const maxs = new Float32Array(dims);
  maxs.fill(-Infinity);

  // First pass: extract primary keys, verify revision property, compute L2 norms, find per-dimension min and max
  for (let i = 0; i < count; i++) {
    const rec = records[i];
    const key = explicitKeys ? explicitKeys[i] : (rec.key ?? rec.id);
    if (key === undefined) {
      throw new Error(`Record at index ${i} has no identifiable primary key`);
    }
    keys[i] = key;

    // Revision check on build: every original must carry the revision property (ADR 0001 Invariant 3)
    const recRev = rec[revisionPath];
    if (recRev === undefined || recRev === null) {
      throw new TypeError(
        `Record ${JSON.stringify(key)} has no "${revisionPath}" property (revisionPath). Revision pinning requires all records to carry a matching revision property before building codes (expected revision ${revision}).`
      );
    }
    if (recRev !== revision) {
      throw new Error(
        `Record ${JSON.stringify(key)} has revision ${recRev}, expected ${revision}.`
      );
    }

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
    const offset = i * dims;
    for (let d = 0; d < dims; d++) {
      const scaled = (vec[d] - mins[d]) / scales[d] - 127;
      codes[offset + d] = Math.max(-127, Math.min(127, Math.round(scaled)));
    }
  }

  const bytes = codes.byteLength + norms.byteLength + mins.byteLength + scales.byteLength;

  return {
    revision,
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
  const weights = new Float32Array(dims);
  let baseOffset = 0;

  for (let d = 0; d < dims; d++) {
    const q = queryVector[d];
    const s = scales[d];
    const m = mins[d];
    weights[d] = q * s;
    baseOffset += q * (m + 127 * s);
  }

  return { weights, baseOffset };
}

// Scan int8 codes to select at most candidateBudget eligible candidates.
// Intersects eligibleKeys BEFORE the candidate budget (ADR 0001 Invariant 6).
export function scanSideStore(codeRecord, queryVector, candidateBudget = 300, eligibleKeys = null) {
  const { count, dims, keys, norms, mins, scales, codes } = codeRecord;
  if (count === 0 || candidateBudget <= 0) return [];

  let queryNormSq = 0;
  for (let d = 0; d < dims; d++) {
    queryNormSq += queryVector[d] * queryVector[d];
  }
  const queryMagnitude = Math.sqrt(queryNormSq) || 1;

  const { weights, baseOffset } = sq8QueryWeights(queryVector, mins, scales);
  const budget = Math.min(candidateBudget, count);
  const candidates = new SortedArray(budget, 'score');

  let eligibleSet = null;
  let isKeyEligible = null;
  if (eligibleKeys !== null && eligibleKeys !== undefined) {
    if (eligibleKeys instanceof Set) {
      eligibleSet = eligibleKeys;
    } else if (Array.isArray(eligibleKeys)) {
      eligibleSet = new Set(eligibleKeys);
    } else if (typeof eligibleKeys === 'function') {
      isKeyEligible = eligibleKeys;
    }
  }

  for (let i = 0; i < count; i++) {
    const key = keys[i];

    // Eligibility check before candidate scoring/truncation (ADR 0001 Invariant 6)
    if (eligibleSet !== null && !eligibleSet.has(key)) {
      continue;
    }
    if (isKeyEligible !== null && !isKeyEligible(key)) {
      continue;
    }

    let dotApprox = 0;
    const offset = i * dims;
    for (let d = 0; d < dims; d++) {
      dotApprox += weights[d] * codes[offset + d];
    }
    const dot = dotApprox + baseOffset;
    const denom = queryMagnitude * (norms[i] || 1);
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
// - Verifies 0 dead rows on the current pinned revision.
// - Verifies that each fetched original record carries a matching revision (ADR 0001 Invariant 2).
// - Preserves exact IndexedDB primary keys via candidateKeys (ADR 0001 Invariant 1).
export function rerankCandidates(
  fetchedRecords,
  vectorPath,
  queryVector,
  limit = 10,
  threshold = null,
  expectedRevision = null,
  revisionPath = 'revision',
  candidateKeys = null,
) {
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

    const key = candidateKeys ? candidateKeys[i] : (record.key ?? record.id);
    if (key === undefined) {
      throw new Error(`Candidate record at index ${i} has no identifiable primary key`);
    }

    // Revision check: each fetched original must have a matching revision (ADR 0001 Invariant 2)
    if (expectedRevision !== null && expectedRevision !== undefined) {
      const recordRev = record[revisionPath];
      if (recordRev === undefined || recordRev === null) {
        throw new Error(
          `Record ${JSON.stringify(key)} has no "${revisionPath}" property; revision cannot be verified for pinned revision ${expectedRevision}`
        );
      }
      if (recordRev !== expectedRevision) {
        throw new Error(
          `Record ${JSON.stringify(key)} has revision ${recordRev}, but query pinned revision ${expectedRevision}`
        );
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
