// tests/unit/browser.test.mjs — regression protection for idb-vector-6b1 and idb-vector-yhy.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('tests/browser.mjs dataset seeding wait budget is bounded near the full gate with clear attribution (idb-vector-6b1)', async () => {
  const browserSrc = await readFile(new URL('../../tests/browser.mjs', import.meta.url), 'utf8');

  // Must not contain the old hard-coded 120s wait:
  assert.doesNotMatch(
    browserSrc,
    /timeout:\s*120000/,
    'must not use the 120s dataset wait budget that flakes under high host load',
  );

  // Must have at least a 300s (300000ms) wait tied specifically to the dataset creation call site:
  assert.match(
    browserSrc,
    /page\.waitFor\([\s\S]*?Dataset failed[\s\S]*?Ready:[\s\S]*?timeout:\s*(?:300000|[3-9]\d{5,})[\s\S]*?label:\s*['"]dataset creation \(#generate seeding\)['"]/,
    'must provide at least 300s budget specifically for dataset creation (#generate seeding)',
  );

  // Must include descriptive label naming dataset creation:
  assert.match(
    browserSrc,
    /label:\s*['"][^'"]*dataset creation[^'"]*['"]/,
    'must include label identifying dataset creation on timeout',
  );

  // Must measure and print elapsed seeding time:
  assert.match(
    browserSrc,
    /Dataset seeded in/,
    'must log measured dataset seeding duration',
  );

  // Must fail fast on Dataset failed:
  assert.match(
    browserSrc,
    /Dataset failed:/,
    'must fail fast if page reports dataset generation failure',
  );
});
