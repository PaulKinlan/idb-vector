// tests/unit/browser.test.mjs — regression protection for idb-vector-6b1, idb-vector-yhy and idb-vector-q8s9.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The dataset wait has to survive a host shared with several agent turns and a browser: seeding
// measured 17.9s at load 5.7 and 34.1s on the merge-base, and a real FULL gate blew through 300s at
// load >16. Anything below this floor is a budget that assumes a fair CPU share.
const MIN_DATASET_SEED_TIMEOUT_MS = 600000;

test('tests/browser.mjs dataset seeding wait budget is bounded near the full gate with clear attribution (idb-vector-6b1)', async () => {
  const browserSrc = await readFile(new URL('../../tests/browser.mjs', import.meta.url), 'utf8');

  // The dataset creation wait, with its label, and the budget expression it uses:
  const call = /page\.waitFor\([\s\S]*?Dataset failed[\s\S]*?Ready:[\s\S]*?timeout:\s*([A-Za-z_$][\w$]*|\d[\d_]*)[\s\S]*?label:\s*['"]dataset creation \(#generate seeding\)['"]/.exec(
    browserSrc,
  );
  assert.ok(
    call,
    'must provide a wait with a budget and the label "dataset creation (#generate seeding)"',
  );

  // The budget may be a literal here or a named constant nearby; either way it must resolve to a
  // number, and that number must not shrink back under the floor.
  const token = call[1];
  let budget = Number(token.replaceAll('_', ''));
  if (Number.isNaN(budget)) {
    const declaration = new RegExp(`const\\s+${token}\\s*=\\s*(\\d[\\d_]*)`).exec(browserSrc);
    assert.ok(declaration, `dataset creation budget constant ${token} must be declared as a numeric literal`);
    budget = Number(declaration[1].replaceAll('_', ''));
  }
  assert.ok(
    budget >= MIN_DATASET_SEED_TIMEOUT_MS,
    `dataset creation (#generate seeding) budget must be at least ${MIN_DATASET_SEED_TIMEOUT_MS}ms, got ${budget}ms`,
  );

  // Must include descriptive label naming dataset creation:
  assert.match(
    browserSrc,
    /label:\s*['"][^'"]*dataset creation[^'"]*['"]/,
    'must include label identifying dataset creation on timeout',
  );

  // A timeout must say whether the host was contended or the page hung: elapsed vs budget plus the
  // page's last #status line.
  assert.match(
    browserSrc,
    /ms budget; page #status:/,
    'timed-out dataset creation must report elapsed ms, the budget and the last #status text',
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
