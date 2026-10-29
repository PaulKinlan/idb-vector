// The only place an embedding provider names which input row a vector belongs to is data[i].index.
// tools/embed-wikipedia.mjs placed rows by array position and left the index set unchecked, so a
// response that repeated, skipped or omitted an index wrote vectors — and the cached .f32 evidence
// behind every measurement — against the wrong passage without any error (idb-vector-oaeb). This
// module is the one mapper the paid path uses: place each row by its own index, and refuse the
// whole batch unless the indexes are exactly 0..expectedRows-1, one per requested passage.
export function orderedEmbeddingVectors(response, expectedRows, dimensions) {
  const rows = response?.data;
  if (!Array.isArray(rows)) {
    throw new Error(`Embedding response has no data array; expected ${expectedRows} rows indexed 0..${expectedRows - 1}`);
  }
  if (rows.length !== expectedRows) {
    throw new Error(`Embedding response returned ${rows.length} rows; expected ${expectedRows} (one per requested passage)`);
  }
  const receivedIndexes = rows.map(row => row?.index);
  const vectors = new Array(expectedRows);
  for (const row of rows) {
    const index = row?.index;
    // Number.isSafeInteger also rejects undefined, null, numeric strings and fractional indexes.
    if (!Number.isSafeInteger(index) || index < 0 || index >= expectedRows) {
      throw new Error(`Embedding row index ${JSON.stringify(index)} is outside the requested 0..${expectedRows - 1}; received indexes ${receivedIndexes.join(', ')}`);
    }
    const embedding = row.embedding;
    if (!Array.isArray(embedding) || embedding.length !== dimensions || embedding.some(x => !Number.isFinite(x)) || !embedding.some(x => x !== 0)) {
      throw new Error(`Embedding row ${index} is not ${dimensions} finite numbers with a nonzero component`);
    }
    vectors[index] = embedding;
  }
  // A hole here means a repeated index: an explicit loop, because every Array prototype helper
  // walks straight past a hole and would report a complete batch.
  const missing = [];
  for (let index = 0; index < expectedRows; index++) if (vectors[index] === undefined) missing.push(index);
  if (missing.length) {
    throw new Error(`Embedding response is missing indexes ${missing.join(', ')}; expected each of 0..${expectedRows - 1} exactly once, received indexes ${receivedIndexes.join(', ')}`);
  }
  return vectors;
}
