// Pure research module for idb-vector-kuc.6: compact candidate passes over an exact oracle.
// No DOM, no IndexedDB: importable from Node and served to the browser for comparable latency.
// Approximations are for CANDIDATE ORDERING only; final rankings come from exact Float64 rerank.

export const POP8 = new Uint8Array(256);
for (let i = 1; i < 256; i++) POP8[i] = (i & 1) + POP8[i >> 1];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussianMaker(seed) {
  const next = mulberry32(seed);
  return () => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

function normalizeInto(target, dims) {
  let norm = 0;
  for (let d = 0; d < dims; d++) norm += target[d] * target[d];
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dims; d++) target[d] /= norm;
}

// Seeded uniform [-1,1) rows, matching the corpus style of test-harness/experiment.js.
export function uniformCorpus(count, dims, seed = 42, queryCount = 10) {
  const next = mulberry32(seed);
  const vectors = new Float32Array(count * dims);
  for (let i = 0; i < vectors.length; i++) vectors[i] = next() * 2 - 1;
  const queries = [];
  for (let q = 0; q < queryCount; q++) {
    const query = new Float64Array(dims);
    for (let d = 0; d < dims; d++) query[d] = next() * 2 - 1;
    queries.push(query);
  }
  return { vectors, queries };
}

// Adversarial near-duplicates: rows hug cluster centers (sigma 0.02) so angular margins are tiny;
// queries are looser perturbations (sigma 0.05) of held-out centers, so true neighbours are ambiguous.
export function adversarialCorpus(count, dims, seed = 7, queryCount = 10) {
  const gauss = gaussianMaker(seed);
  const centers = Math.max(2, Math.floor(count / 50));
  const centerData = new Float64Array(centers * dims);
  for (let i = 0; i < centerData.length; i++) centerData[i] = gauss();
  const vectors = new Float32Array(count * dims);
  const row = new Float64Array(dims);
  for (let i = 0; i < count; i++) {
    const base = i % centers;
    for (let d = 0; d < dims; d++) row[d] = centerData[base * dims + d] + 0.02 * gauss();
    normalizeInto(row, dims);
    vectors.set(row, i * dims);
  }
  const queries = [];
  for (let q = 0; q < queryCount; q++) {
    const base = (count + q) % centers;
    for (let d = 0; d < dims; d++) row[d] = centerData[base * dims + d] + 0.05 * gauss();
    normalizeInto(row, dims);
    queries.push(Float64Array.from(row));
  }
  return { vectors, queries };
}

// Real-corpus queries: perturbed copies of held-out rows (sigma relative to unit norm).
export function perturbedRealQueries(vectors, count, dims, heldOutStart, queryCount = 10, sigma = 0.25, seed = 11) {
  const gauss = gaussianMaker(seed);
  const queries = [];
  const row = new Float64Array(dims);
  for (let q = 0; q < queryCount; q++) {
    const source = Math.min(count - 1, heldOutStart + q);
    for (let d = 0; d < dims; d++) row[d] = vectors[source * dims + d] + sigma * gauss();
    normalizeInto(row, dims);
    queries.push(Float64Array.from(row));
  }
  return queries;
}

export function precomputeNorms(vectors, count, dims) {
  const norms = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += vectors[i * dims + d] ** 2;
    norms[i] = Math.sqrt(norm);
  }
  return norms;
}

// ---- SQ8 per-dimension affine scalar quantisation ----
export function encodeSq8(vectors, count, dims) {
  const codes = new Int8Array(count * dims);
  const mins = new Float32Array(dims), scales = new Float32Array(dims);
  for (let d = 0; d < dims; d++) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < count; i++) {
      const value = vectors[i * dims + d];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    mins[d] = min;
    scales[d] = (max - min) / 254 || 1;
  }
  for (let i = 0; i < count; i++) for (let d = 0; d < dims; d++) {
    codes[i * dims + d] = Math.round((vectors[i * dims + d] - mins[d]) / scales[d]) - 127;
  }
  return { codes, mins, scales, bytes: codes.length + mins.byteLength + scales.byteLength };
}

export function encodeSq8Row(vectors, row, dims, sq8) {
  const { mins, scales } = sq8;
  const code = new Int8Array(dims);
  for (let d = 0; d < dims; d++) code[d] = Math.round((vectors[row * dims + d] - mins[d]) / scales[d]) - 127;
  return code;
}

export function sq8QueryWeights(query, sq8) {
  const { mins, scales } = sq8;
  const dims = mins.length;
  const w = new Float64Array(dims);
  let offset = 0;
  for (let d = 0; d < dims; d++) {
    w[d] = query[d] * scales[d];
    // Code 0 decodes to mins[d] + 127*scales[d]; the +127 must sit in the offset,
    // otherwise the missing constant shifts each row's cosine by a norm-dependent amount.
    offset += query[d] * (mins[d] + 127 * scales[d]);
  }
  return { w, offset };
}

// ---- 1-bit sign codes (dims padded to a byte boundary) ----
export function signBytes(dims) {
  return (dims + 7) >> 3;
}

export function encodeSign(vectors, count, dims) {
  const stride = signBytes(dims);
  const codes = new Uint8Array(count * stride);
  for (let i = 0; i < count; i++) for (let d = 0; d < dims; d++) {
    if (vectors[i * dims + d] > 0) codes[i * stride + (d >> 3)] |= 1 << (d & 7);
  }
  return { codes, stride, bytes: codes.length };
}

export function encodeSignRow(vectors, row, dims, stride) {
  const code = new Uint8Array(stride);
  for (let d = 0; d < dims; d++) if (vectors[row * dims + d] > 0) code[d >> 3] |= 1 << (d & 7);
  return code;
}

export function signCosineEstimate(a, b, stride, dims) {
  let hamming = 0;
  for (let i = 0; i < stride; i++) hamming += POP8[a[i] ^ b[i]];
  return (dims - 2 * hamming) / dims; // sign(a).sign(b)/dims; norms cancel in cosine
}

// Same estimate without creating a per-row view (allocation-free hot loop).
export function signCosineEstimateAt(codes, base, packed, stride, dims) {
  let hamming = 0;
  for (let i = 0; i < stride; i++) hamming += POP8[codes[base + i] ^ packed[i]];
  return (dims - 2 * hamming) / dims;
}

// ---- Coarse buckets (cosine k-means on a sample, single assignment per row) ----
export function trainBuckets(vectors, count, dims, k, iters, sampleLimit, seed = 3) {
  const step = Math.max(1, Math.floor(count / sampleLimit));
  const sampleCount = Math.min(count, Math.floor((count - 1) / step) + 1);
  const sample = new Float32Array(sampleCount * dims);
  for (let i = 0; i < sampleCount; i++) for (let d = 0; d < dims; d++) sample[i * dims + d] = vectors[i * step * dims + d];
  const gauss = gaussianMaker(seed);
  const centroids = new Float32Array(k * dims);
  for (let i = 0; i < centroids.length; i++) centroids[i] = gauss();
  const sums = new Float64Array(k * dims);
  const counts = new Int32Array(k);
  for (let iter = 0; iter < iters; iter++) {
    sums.fill(0); counts.fill(0);
    for (let i = 0; i < sampleCount; i++) {
      let best = 0, bestScore = -Infinity;
      for (let c = 0; c < k; c++) {
        let dot = 0, cn = 0;
        for (let d = 0; d < dims; d++) { const value = centroids[c * dims + d]; dot += sample[i * dims + d] * value; cn += value * value; }
        const score = dot / (Math.sqrt(cn) || 1);
        if (score > bestScore) { bestScore = score; best = c; }
      }
      counts[best]++;
      for (let d = 0; d < dims; d++) sums[best * dims + d] += sample[i * dims + d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dims; d++) centroids[c * dims + d] = sums[c * dims + d] / counts[c];
    }
  }
  const centroidNorms = new Float32Array(k);
  for (let c = 0; c < k; c++) {
    let norm = 0;
    for (let d = 0; d < dims; d++) norm += centroids[c * dims + d] ** 2;
    centroidNorms[c] = Math.sqrt(norm) || 1;
  }
  return { centroids, centroidNorms, k, dims };
}

export function assignRow(vectors, row, dims, buckets) {
  const { centroids, centroidNorms, k } = buckets;
  let best = 0, bestScore = -Infinity;
  for (let c = 0; c < k; c++) {
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += vectors[row * dims + d] * centroids[c * dims + d];
    const score = dot / centroidNorms[c];
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

export function assignBuckets(vectors, count, dims, buckets) {
  const assignments = new Int32Array(count);
  const members = Array.from({ length: buckets.k }, () => []);
  for (let i = 0; i < count; i++) {
    const bucket = assignRow(vectors, i, dims, buckets);
    assignments[i] = bucket;
    members[bucket].push(i);
  }
  const lists = members.map(ids => Int32Array.from(ids));
  const bytes = assignments.byteLength + lists.reduce((sum, list) => sum + list.byteLength, 0) + buckets.centroids.byteLength;
  return { assignments, lists, bytes };
}

// Predicate-before-candidate: eligibility decided per row id BEFORE candidates are chosen.
export function eligibleMask(count, predicate) {
  const mask = new Uint8Array(count);
  if (!predicate) { mask.fill(1); return mask; }
  for (let i = 0; i < count; i++) mask[i] = predicate(i) ? 1 : 0;
  return mask;
}

// ---- Exact oracle and rerank (Float64 accumulation, inline norms like the library scan) ----
export function exactTopK(vectors, count, dims, query, k, mask = null) {
  const top = [];
  let queryNorm = 0;
  for (let d = 0; d < dims; d++) queryNorm += query[d] * query[d];
  queryNorm = Math.sqrt(queryNorm) || 1;
  for (let i = 0; i < count; i++) {
    if (mask && !mask[i]) continue;
    let dot = 0, norm = 0;
    for (let d = 0; d < dims; d++) { const value = vectors[i * dims + d]; dot += query[d] * value; norm += value * value; }
    const similarity = dot / (queryNorm * Math.sqrt(norm));
    if (top.length < k) {
      top.push({ index: i, similarity });
      if (top.length === k) top.sort((a, b) => b.similarity - a.similarity);
    } else if (similarity > top[top.length - 1].similarity) {
      top[top.length - 1] = { index: i, similarity };
      let j = top.length - 1;
      while (j > 0 && top[j - 1].similarity < top[j].similarity) { const t = top[j]; top[j] = top[j - 1]; top[j - 1] = t; j--; }
    }
  }
  return top;
}

export function rerankTopK(vectors, dims, norms, ids, query, k) {
  let queryNorm = 0;
  for (let d = 0; d < dims; d++) queryNorm += query[d] * query[d];
  queryNorm = Math.sqrt(queryNorm) || 1;
  const top = [];
  for (const id of ids) {
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += query[d] * vectors[id * dims + d];
    const similarity = dot / (queryNorm * (norms[id] || 1));
    if (top.length < k) {
      top.push({ index: id, similarity });
      if (top.length === k) top.sort((a, b) => b.similarity - a.similarity);
    } else if (similarity > top[top.length - 1].similarity) {
      top[top.length - 1] = { index: id, similarity };
      let j = top.length - 1;
      while (j > 0 && top[j - 1].similarity < top[j].similarity) { const t = top[j]; top[j] = top[j - 1]; top[j - 1] = t; j--; }
    }
  }
  return top;
}

export function recallAtK(a, b, k = 10) {
  const keys = new Set(b.slice(0, k).map(row => row.index));
  return a.slice(0, k).filter(row => keys.has(row.index)).length / k;
}

// Fraction of the oracle top-k that is even PRESENT among the candidate ids: the recall ceiling
// a rerank could reach from those candidates, regardless of ordering.
export function candidateCeiling(candidateIds, oracleTop, k = 10) {
  const present = new Set(candidateIds);
  return oracleTop.slice(0, k).filter(row => present.has(row.index)).length / k;
}

// ---- Full scans over compact codes producing one ordered candidate list per query ----
// Predicate-before-candidate: `mask` is applied per row id BEFORE scoring, so the pass only
// scores eligible rows. Passing no mask ranks the whole corpus (predicate-after semantics).
export function sq8Scan(vectors, count, dims, sq8, norms, query, keep, mask = null) {
  const { w, offset } = sq8QueryWeights(query, sq8);
  const { codes } = sq8;
  const top = [];
  for (let i = 0; i < count; i++) {
    if (mask && !mask[i]) continue;
    let dot = offset;
    const base = i * dims;
    for (let d = 0; d < dims; d++) dot += w[d] * codes[base + d];
    const score = dot / (norms[i] || 1);
    if (top.length < keep) {
      top.push({ index: i, score });
      if (top.length === keep) top.sort((a, b) => b.score - a.score);
    } else if (score > top[top.length - 1].score) {
      top[top.length - 1] = { index: i, score };
      let j = top.length - 1;
      while (j > 0 && top[j - 1].score < top[j].score) { const t = top[j]; top[j] = top[j - 1]; top[j - 1] = t; j--; }
    }
  }
  return top;
}

export function signScan(sign, count, dims, query, keep, mask = null) {
  const { codes, stride } = sign;
  const packed = new Uint8Array(stride);
  for (let d = 0; d < dims; d++) if (query[d] > 0) packed[d >> 3] |= 1 << (d & 7);
  const top = [];
  for (let i = 0; i < count; i++) {
    if (mask && !mask[i]) continue;
    const score = signCosineEstimateAt(codes, i * stride, packed, stride, dims);
    if (top.length < keep) {
      top.push({ index: i, score });
      if (top.length === keep) top.sort((a, b) => b.score - a.score);
    } else if (score > top[top.length - 1].score) {
      top[top.length - 1] = { index: i, score };
      let j = top.length - 1;
      while (j > 0 && top[j - 1].score < top[j].score) { const t = top[j]; top[j] = top[j - 1]; top[j - 1] = t; j--; }
    }
  }
  return top;
}

export function bucketCandidates(buckets, index, query, budget, mask = null, dims) {
  const { centroids, centroidNorms, k } = buckets;
  let queryNorm = 0;
  for (let d = 0; d < dims; d++) queryNorm += query[d] * query[d];
  queryNorm = Math.sqrt(queryNorm) || 1;
  const order = [];
  for (let c = 0; c < k; c++) {
    let dot = 0;
    for (let d = 0; d < dims; d++) dot += query[d] * centroids[c * dims + d];
    order.push({ bucket: c, score: dot / (queryNorm * centroidNorms[c]) });
  }
  order.sort((a, b) => b.score - a.score);
  const candidates = [];
  for (const { bucket } of order) {
    const list = index.lists[bucket];
    for (let j = 0; j < list.length; j++) {
      const id = list[j];
      if (mask && !mask[id]) continue;
      candidates.push(id);
      if (candidates.length >= budget) return candidates;
    }
  }
  return candidates;
}

const time = fn => {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
};

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// ---- One corpus end-to-end ----
export function runExperiment({ name, kind, vectors, count, dims, queries, bucketK, bucketIters = 4, bucketSample = 10000, budgets = [100, 300, 1000], repetitions = 3, predicate = null, measureUpdates = true }) {
  const keep = Math.max(...budgets);
  const results = { name, kind, count, dims, budgets, queries: queries.length, methods: {} };

  const buildSq8 = time(() => encodeSq8(vectors, count, dims));
  const sq8 = buildSq8.value;
  const buildSign = time(() => encodeSign(vectors, count, dims));
  const sign = buildSign.value;
  const buildBuckets = time(() => {
    const trained = trainBuckets(vectors, count, dims, bucketK, bucketIters, bucketSample);
    const index = assignBuckets(vectors, count, dims, trained);
    return { trained, index };
  });
  const { trained, index } = buildBuckets.value;
  const norms = precomputeNorms(vectors, count, dims);
  results.build = { sq8Ms: buildSq8.ms, signMs: buildSign.ms, bucketsMs: buildBuckets.ms };
  results.memoryBytes = {
    originals: count * dims * 4,
    sq8: sq8.bytes,
    sign: sign.bytes,
    buckets: index.bytes + norms.byteLength,
  };

  const mask = eligibleMask(count, predicate);
  const eligibleCount = mask.reduce((sum, value) => sum + value, 0);
  if (predicate) results.predicate = { eligible: eligibleCount, selectivity: eligibleCount / count };

  // Oracles first (untimed): exact top-10 over the same set candidates are drawn from.
  const oracle = queries.map(query => exactTopK(vectors, count, dims, query, 10, mask));
  results.oracle = { recall: 1, oracleRows: predicate ? eligibleCount : count };

  const methodNames = ['exact', 'sq8', 'sign', 'bucket'];
  // Filtered corpora also measure the naive ordering: choose candidates over the WHOLE corpus,
  // then drop ineligible ids. Comparing that with the masked passes is the semantics result.
  if (predicate) methodNames.push('sq8-postfilter', 'sign-postfilter');
  const perMethod = Object.fromEntries(methodNames.map(name => [name, { ms: [], rerankMs: [], candidateMs: [], recall: [], candidateRecall: [] }]));

  // Each candidate pass as a function of (query, useMask) -> ordered ids, so the masked and
  // unmasked (predicate-after) semantics share one implementation.
  const passes = {
    sq8: (query, useMask) => sq8Scan(vectors, count, dims, sq8, norms, query, keep, useMask ? mask : null).map(row => row.index),
    sign: (query, useMask) => signScan(sign, count, dims, query, keep, useMask ? mask : null).map(row => row.index),
    bucket: (query, useMask) => bucketCandidates(trained, index, query, keep, useMask ? mask : null, dims),
  };

  for (let rep = 0; rep < repetitions; rep++) {
    for (let offset = 0; offset < methodNames.length; offset++) {
      const method = methodNames[(offset + rep) % methodNames.length];
      for (let q = 0; q < queries.length; q++) {
        const query = queries[q];
        if (method === 'exact') {
          const timed = time(() => exactTopK(vectors, count, dims, query, 10, mask));
          perMethod.exact.ms.push(timed.ms);
          perMethod.exact.recall.push(1);
          continue;
        }
        const postfilter = method.endsWith('-postfilter');
        const base = postfilter ? method.slice(0, -'-postfilter'.length) : method;
        // The eligibility filter for postfilter runs inside the timed block: it is part of the
        // candidate pass, so it must not fall between the scan and rerank timers.
        const scan = time(() => {
          const ids = passes[base](query, !postfilter);
          return postfilter ? ids.filter(id => mask[id]) : ids;
        });
        const candidateIds = scan.value;
        const rerank = time(() => rerankTopK(vectors, dims, norms, candidateIds, query, 10));
        const slot = perMethod[method];
        slot.candidateMs.push(scan.ms); slot.rerankMs.push(rerank.ms); slot.ms.push(scan.ms + rerank.ms);
        slot.recall.push(recallAtK(rerank.value, oracle[q]));
        slot.candidateRecall.push(candidateCeiling(candidateIds, oracle[q]));
      }
    }
  }
  for (const [method, samples] of Object.entries(perMethod)) {
    results.methods[method] = {
      medianMs: median(samples.ms),
      // First timed call of the method: cold for that method's JIT and caches, not a cold-disk claim.
      firstCallMs: samples.ms[0],
      medianCandidateMs: samples.candidateMs.length ? median(samples.candidateMs) : null,
      medianRerankMs: samples.rerankMs.length ? median(samples.rerankMs) : null,
      meanRecallAt10: samples.recall.reduce((a, b) => a + b, 0) / samples.recall.length,
      meanCandidateCeiling: samples.candidateRecall.length ? samples.candidateRecall.reduce((a, b) => a + b, 0) / samples.candidateRecall.length : null,
      perBudget: {},
    };
  }
  // Budget sweep: one ordered ranking per query, each budget a prefix of it, then the MEAN
  // recall/ceiling over every query (a single sample query is not a recall measurement).
  const budgetLists = Object.fromEntries(methodNames.filter(name => name !== 'exact').map(name => [name, []]));
  for (let q = 0; q < queries.length; q++) {
    for (const method of Object.keys(budgetLists)) {
      const postfilter = method.endsWith('-postfilter');
      const base = postfilter ? method.slice(0, -'-postfilter'.length) : method;
      const ids = passes[base](queries[q], !postfilter);
      budgetLists[method].push(postfilter ? ids.filter(id => mask[id]) : ids);
    }
  }
  for (const budget of budgets) {
    for (const [method, perQuery] of Object.entries(budgetLists)) {
      let recall = 0, ceiling = 0;
      for (let q = 0; q < queries.length; q++) {
        const subset = perQuery[q].slice(0, budget);
        recall += recallAtK(rerankTopK(vectors, dims, norms, subset, queries[q], 10), oracle[q]);
        ceiling += candidateCeiling(subset, oracle[q]);
      }
      results.methods[method].perBudget[budget] = {
        recallAt10: recall / queries.length,
        candidateCeilingAt10: ceiling / queries.length,
      };
    }
  }

  if (measureUpdates) {
    // Random row spread, not the first rows: a cache-hot prefix would flatter the per-row cost.
    const pick = mulberry32(99);
    const rows = Array.from({ length: 100 }, () => Math.floor(pick() * count));
    const sq8Update = time(() => { for (const row of rows) encodeSq8Row(vectors, row, dims, sq8); });
    const signUpdate = time(() => { for (const row of rows) encodeSignRow(vectors, row, dims, sign.stride); });
    const bucketUpdate = time(() => { for (const row of rows) assignRow(vectors, row, dims, trained); });
    results.updateMicrosPerRow = {
      sq8: (sq8Update.ms / 100) * 1000,
      sign: (signUpdate.ms / 100) * 1000,
      bucket: (bucketUpdate.ms / 100) * 1000,
    };
    // Delete: row codes are cleared in place (dims bytes) and the id must leave its bucket
    // list. The list edit is measured on a scratch copy of a real bucket; a tombstone is
    // O(1) instead, but then the query path must skip dead ids for the revision it pins.
    const scratch = Int32Array.from(index.lists[index.assignments[rows[0]]]);
    const shift = Math.floor(scratch.length / 2);
    const sq8Clear = time(() => { for (const row of rows) sq8.codes.fill(0, row * dims, (row + 1) * dims); });
    const signClear = time(() => { for (const row of rows) sign.codes.fill(0, row * sign.stride, (row + 1) * sign.stride); });
    const listShift = time(() => { for (let n = 0; n < 100; n++) { scratch.copyWithin(shift, shift + 1); scratch[scratch.length - 1] = -1; } });
    results.deleteMicrosPerRow = {
      sq8CodeClear: (sq8Clear.ms / 100) * 1000,
      signCodeClear: (signClear.ms / 100) * 1000,
      bucketListShift: (listShift.ms / 100) * 1000,
      bucketListLength: scratch.length,
    };
  }
  return results;
}
