// A restored passage is data the page did not just write, so every field the panel renders or links
// is checked before use (idb-vector-4skw). These are unit-level because the whole rule is one pure
// function over a record; the demo gate drives the browser end of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  EMBEDDING_DIMENSIONS,
  LINK_MAX,
  TEXT_MAX,
  TITLE_MAX,
  permittedLink,
  validateRecord,
  validateStoredMeta,
  validateStoredRecord,
} from '../../demo/record-validation.js';

const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => Math.sin(index));
const record = (overrides = {}) => ({
  title: 'Photosynthesis',
  pageid: 50650,
  revision: 1375986678,
  url: 'https://en.wikipedia.org/?curid=50650',
  text: 'Photosynthesis is a system of biological processes by which photopigments convert light energy into chemical energy.',
  embedding,
  ...overrides,
});

test('a stored corpus passage validates unchanged', () => {
  const passages = JSON.parse(readFileSync('demo/data/passages-250.json', 'utf8'));
  for (const passage of passages) {
    assert.equal(validateRecord(passage), null, passage.title);
    assert.equal(validateStoredRecord({ ...passage, embedding }), null, passage.title);
  }
});

test('a missing or oversized title is refused before it reaches a heading', () => {
  assert.equal(validateRecord(record({ title: undefined })), 'title is missing');
  assert.equal(validateRecord(record({ title: '' })), 'title is missing');
  assert.equal(validateRecord(record({ title: '   ' })), 'title is missing');
  assert.equal(validateRecord(record({ title: 42 })), 'title is missing');
  assert.equal(validateRecord(record({ title: 'x'.repeat(TITLE_MAX) })), null);
  assert.equal(validateRecord(record({ title: 'x'.repeat(TITLE_MAX + 1) })), `title is longer than ${TITLE_MAX} characters`);
});

test('a 10MB text field is refused instead of rendered', () => {
  const huge = record({ text: 'x'.repeat(10 * 1024 * 1024) });
  assert.equal(validateRecord(huge), `text is longer than ${TEXT_MAX} characters`);
  assert.equal(validateRecord(record({ text: undefined })), 'text is missing');
  assert.equal(validateRecord(record({ text: 'x'.repeat(TEXT_MAX) })), null);
});

test('pageid and revision, which become hrefs, must be positive integers', () => {
  for (const field of ['pageid', 'revision']) {
    for (const value of [undefined, null, 0, -1, 1.5, '42', Number.NaN, 2 ** 60]) {
      assert.equal(validateRecord(record({ [field]: value })), `${field} is not a positive integer`, `${field} ${String(value)}`);
    }
    assert.equal(validateRecord(record({ [field]: 42 })), null);
  }
});

test('a link field is https on the corpus host or it is not a link', () => {
  for (const url of ['javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'http://en.wikipedia.org/?curid=50650', 'https://evil.test/?curid=50650', 'https://en.wikipedia.org.evil.test/',
    'https://user:pass@en.wikipedia.org/', 'https://en.wikipedia.org:8443/', 'https://[::1]/', '/relative', 'not a url',
    `https://en.wikipedia.org/?curid=${'x'.repeat(LINK_MAX)}`]) {
    assert.equal(permittedLink(url), false, url);
    assert.equal(validateRecord(record({ url })), 'url is not an https en.wikipedia.org link', url);
  }
  assert.equal(validateRecord(record({ url: undefined })), null, 'the record\'s own url is not required');
});

test('the restore probe keeps the vector check it already had, and holes count as missing', () => {
  assert.equal(validateStoredRecord(record({ embedding: undefined })), `embedding is not ${EMBEDDING_DIMENSIONS} numbers`);
  assert.equal(validateStoredRecord(record({ embedding: new Float64Array(EMBEDDING_DIMENSIONS) })), `embedding is not ${EMBEDDING_DIMENSIONS} numbers`);
  assert.equal(validateStoredRecord(record({ embedding: embedding.slice(1) })), `embedding is not ${EMBEDDING_DIMENSIONS} numbers`);
  const sparse = embedding.slice();
  delete sparse[7];
  assert.equal(validateStoredRecord(record({ embedding: sparse })), 'embedding has a coordinate that is not a number');
  const notFinite = embedding.slice();
  notFinite[0] = Number.NaN;
  assert.equal(validateStoredRecord(record({ embedding: notFinite })), 'embedding has a coordinate that is not a number');
  assert.equal(validateStoredRecord(null), `embedding is not ${EMBEDDING_DIMENSIONS} numbers`);
  // The render check does not repeat it: query() already refuses an unscoreable stored vector.
  assert.equal(validateRecord(record({ embedding: undefined })), null);
  // A record with a good vector but a hostile field is still refused by the probe.
  assert.equal(validateStoredRecord(record({ url: 'javascript:alert(1)' })), 'url is not an https en.wikipedia.org link');
});

test('a record that is not an object is refused, and no reason quotes the record', () => {
  for (const value of [null, undefined, 'passage', 42, []]) assert.equal(validateRecord(value), 'the record is not an object');
  // Reasons land in the page's status text, so they must be built from the page's words only: a
  // hostile title is refused without its markup being echoed back into the document.
  const hostile = '<img src=x onerror=alert(1)>';
  assert.equal(validateRecord(record({ title: hostile })), null, 'a title is text, and text is rendered as text');
  const reason = validateRecord(record({ url: `javascript:${hostile}` }));
  assert.equal(reason, 'url is not an https en.wikipedia.org link');
  assert.equal(reason.includes('onerror'), false);
  const longTitle = validateRecord(record({ title: hostile.repeat(TITLE_MAX) }));
  assert.equal(longTitle.includes(hostile), false, 'a length refusal does not repeat the value');
});

// loadTiming() draws count and three durations from the stored `loaded` record and calls .toFixed on
// them, so the restore probe checks that record too: a store written by another connection must not
// throw out of the probe while it is rendering its own verdict.
test('the stored metadata the timing line draws from is checked before it is rendered', () => {
  const meta = { count: 250, totalMs: 1, setupMs: 2, writeMs: 3, browser: 'Chrome 120 on Linux' };
  assert.equal(validateStoredMeta(meta), null);
  for (const field of ['count', 'totalMs', 'setupMs', 'writeMs']) {
    for (const value of [undefined, null, '250', Number.NaN, -1]) {
      assert.notEqual(validateStoredMeta({ ...meta, [field]: value }), null, `${field} ${String(value)}`);
    }
  }
  assert.equal(validateStoredMeta({ ...meta, totalMs: undefined }), 'totalMs in the stored metadata is not a duration');
  assert.equal(validateStoredMeta({ ...meta, count: 1.5 }), 'count in the stored metadata is not a count');
  assert.equal(validateStoredMeta({ ...meta, count: ['unsafe', 'array'] }), 'count in the stored metadata is not a count');
  assert.equal(validateStoredMeta({ ...meta, count: { unsafe: 'object' } }), 'count in the stored metadata is not a count');
  assert.equal(validateStoredMeta({ ...meta, count: 'x'.repeat(10 * 1024 * 1024) }), 'count in the stored metadata is not a count');
  assert.equal(validateStoredMeta({ ...meta, browser: 42 }), 'browser in the stored metadata is not a label');
  assert.equal(validateStoredMeta({ ...meta, browser: 'x'.repeat(2001) }), 'browser in the stored metadata is not a label');
  for (const value of [null, undefined, 'meta', 42, []]) assert.equal(validateStoredMeta(value), 'the stored metadata is not an object');
});
