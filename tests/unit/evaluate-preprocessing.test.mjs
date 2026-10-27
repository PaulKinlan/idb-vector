import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { encodeQueries } from '../../tools/evaluate-preprocessing.mjs';

test('encodeQueries batches queries into a single encoder call with padding options rather than serializing per query', async () => {
  let callCount = 0;
  let receivedBatch = null;
  let receivedOptions = null;
  const stubEncoder = async (batch, options) => {
    callCount++;
    receivedBatch = batch;
    receivedOptions = options;
    return batch.map((_, i) => new Array(384).fill(i));
  };

  const queries = [
    'Which scientific field studies stars, planets and the universe?',
    'How do living things interact with their environments?'
  ];
  const vectors = await encodeQueries(stubEncoder, queries);

  assert.equal(callCount, 1, 'must invoke the encoder exactly ONCE for the query batch');
  assert.deepEqual(receivedBatch, queries, 'batch argument must match the queries array');
  assert.equal(receivedOptions?.padding, true, 'padding must be enabled for multi-query batches');
  assert.equal(receivedOptions?.truncation, true, 'truncation must be enabled for multi-query batches');
  assert.equal(vectors.length, queries.length);
  assert.equal(vectors[0].length, 384);
  assert.equal(vectors[0][0], 0);
  assert.equal(vectors[1][0], 1);
});

test('tools/evaluate-preprocessing.mjs page.evaluate batches held-out queries in a single call with padding', async () => {
  const source = await readFile(new URL('../../tools/evaluate-preprocessing.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /for\s*\(.*query\s+of\s+queries\).*await\s+encode/s, 'must not await encode once per query');
  assert.match(source, /return\s+await\s+encode\(queries,\s*\{\s*padding:\s*true,\s*truncation:\s*true\s*\}\)/, 'page.evaluate must batch queries through encode(queries, { padding: true, truncation: true })');
});

test('FeatureExtractionPipeline passes padding and truncation to tokenizer', async () => {
  const vendorSource = await readFile(new URL('../../demo/vendor/transformers.min.js', import.meta.url), 'utf8');
  assert.match(vendorSource, /this\.tokenizer\(e,\{padding:!0,truncation:!0\}\)/, 'FeatureExtractionPipeline._call enforces padding and truncation on tokenizer');
});
