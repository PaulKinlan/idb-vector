// Pure research module for idb-vector-kuc.9: the record a compact candidate side-store would
// persist, and the exact rerank over rows fetched back by key.
// No DOM and no IndexedDB: importable from Node and served to the browser, so the same code
// builds the side-store and reranks in both.
import { encodeSq8, precomputeNorms } from './quantized-pass.js';

// What a side-store has to carry so a query can score without the originals: the int8 codes, the
// row norms cosine needs, the per-dimension affine tables the codes were built with, and the
// revision they belong to. A query pins one revision; mixing revisions is what the revision
// stamp exists to prevent.
export function buildCodeRecord(vectors, count, dims, revision = 1) {
  const sq8 = encodeSq8(vectors, count, dims);
  const norms = precomputeNorms(vectors, count, dims);
  return {
    revision,
    count,
    dims,
    codes: sq8.codes,
    norms,
    mins: sq8.mins,
    scales: sq8.scales,
    bytes: sq8.codes.byteLength + norms.byteLength + sq8.mins.byteLength + sq8.scales.byteLength,
  };
}

// Exact Float64 cosine over rows fetched by key. `fetched` are { id, embedding } entries in
// candidate order; a null/undefined entry or a missing embedding means the pinned revision had a
// deleted row the candidate list still referenced, and it is skipped rather than scored as zero.
export function rerankFetched(fetched, query, k, dims) {
  let queryNorm = 0;
  for (let d = 0; d < dims; d++) queryNorm += query[d] * query[d];
  queryNorm = Math.sqrt(queryNorm) || 1;
  const top = [];
  for (const entry of fetched) {
    if (!entry || !entry.embedding) continue;
    const embedding = entry.embedding;
    if (embedding.length !== dims) throw new Error(`fetched row ${entry.id} has ${embedding.length} dimensions, expected ${dims}`);
    let dot = 0, norm = 0;
    for (let d = 0; d < dims; d++) { const value = embedding[d]; dot += query[d] * value; norm += value * value; }
    const similarity = dot / (queryNorm * (Math.sqrt(norm) || 1));
    if (top.length < k) {
      top.push({ index: entry.id, similarity });
      if (top.length === k) top.sort((a, b) => b.similarity - a.similarity);
    } else if (similarity > top[top.length - 1].similarity) {
      top[top.length - 1] = { index: entry.id, similarity };
      let j = top.length - 1;
      while (j > 0 && top[j - 1].similarity < top[j].similarity) { const t = top[j]; top[j] = top[j - 1]; top[j - 1] = t; j--; }
    }
  }
  return top;
}
