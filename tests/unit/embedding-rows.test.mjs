// tests/unit/embedding-rows.test.mjs — provider row placement for the paid Wikipedia embedding run.
//
// idb-vector-oaeb: tools/embed-wikipedia.mjs placed provider rows by ARRAY POSITION and never
// checked data[].index, so a response that arrived reordered, short, or with a repeated/skipped
// index silently wrote vectors — and the cached .f32 evidence — against the WRONG passages. No
// network here: a stub stands in for the provider, and each stub vector is named by the passage it
// was computed from, so a misplacement is visible as the wrong name at the wrong position.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { orderedEmbeddingVectors } from '../../tools/embedding-rows.mjs';

const dimensions = 3;
// passage i gets the vector [i + 1, 0, 1], so the vector itself names its passage.
const vectorFor = index => [index + 1, 0, 1];
const passageOf = vector => vector[0] - 1;

function provider(rows) {
  return { object: 'list', model: 'text-embedding-3-small', usage: { prompt_tokens: 1, total_tokens: 1 }, data: rows };
}

test('rows returned in order are placed by index', () => {
  const response = provider([0, 1, 2, 3, 4].map(index => ({ object: 'embedding', index, embedding: vectorFor(index) })));
  const vectors = orderedEmbeddingVectors(response, 5, dimensions);
  assert.deepEqual(vectors.map(passageOf), [0, 1, 2, 3, 4]);
});

test('shuffled rows land against the passages their indexes name, not their array positions', () => {
  const indexes = [3, 0, 4, 2, 1];
  const response = provider(indexes.map(index => ({ object: 'embedding', index, embedding: vectorFor(index) })));
  const vectors = orderedEmbeddingVectors(response, 5, dimensions);
  // Array order would give [3, 0, 4, 2, 1] and put every vector on the wrong passage:
  assert.deepEqual(vectors.map(passageOf), [0, 1, 2, 3, 4]);
  assert.deepEqual(vectors[3], vectorFor(3), 'passage 3 keeps the vector the provider computed for index 3');
});

test('a short response throws the count it received against the count it was asked for', () => {
  const response = provider([0, 1, 2].map(index => ({ object: 'embedding', index, embedding: vectorFor(index) })));
  assert.throws(() => orderedEmbeddingVectors(response, 5, dimensions),
    /returned 3 rows; expected 5 \(one per requested passage\)/);
});

test('a repeated index throws instead of leaving its neighbour unplaced', () => {
  const response = provider([0, 1, 1, 3, 4].map(index => ({ object: 'embedding', index, embedding: vectorFor(index) })));
  assert.throws(() => orderedEmbeddingVectors(response, 5, dimensions),
    /missing indexes 2; expected each of 0\.\.4 exactly once, received indexes 0, 1, 1, 3, 4/);
});

test('a skipped index throws instead of shifting every later vector', () => {
  const response = provider([0, 1, 3, 4, 5].map(index => ({ object: 'embedding', index, embedding: vectorFor(index) })));
  assert.throws(() => orderedEmbeddingVectors(response, 5, dimensions),
    /Embedding row index 5 is outside the requested 0\.\.4; received indexes 0, 1, 3, 4, 5/);
});

test('a response with no provider index is refused, never assumed to be in array order', () => {
  const response = provider([0, 1, 2, 3, 4].map(index => ({ object: 'embedding', embedding: vectorFor(index) })));
  assert.throws(() => orderedEmbeddingVectors(response, 5, dimensions),
    /Embedding row index undefined is outside the requested 0\.\.4/);
});

test('a row of the wrong width or with no nonzero component is refused', () => {
  const short = provider([0, 1].map(index => ({ object: 'embedding', index, embedding: vectorFor(index) })));
  short.data.push({ object: 'embedding', index: 2, embedding: [1, 0] });
  assert.throws(() => orderedEmbeddingVectors(short, 3, dimensions), /row 2 is not 3 finite numbers/);
  const zero = provider([0, 1, 2].map(index => ({ object: 'embedding', index, embedding: index === 1 ? [0, 0, 0] : vectorFor(index) })));
  assert.throws(() => orderedEmbeddingVectors(zero, 3, dimensions), /row 1 is not 3 finite numbers with a nonzero component/);
});

// The paid path must keep using the asserted mapper: a future edit that reads body.data directly
// would reintroduce the silent misalignment these tests cover.
test('the embedding tool routes its provider response through the asserted mapper', async () => {
  const source = await readFile(new URL('../../tools/embed-wikipedia.mjs', import.meta.url), 'utf8');
  assert.match(source, /orderedEmbeddingVectors\(body, requested\.length, dimensions\)/);
  assert.doesNotMatch(source, /body\.data\?\.sort/);
});
