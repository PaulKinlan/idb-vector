// tests/unit/browser.test.mjs — regression protection for idb-vector-6b1, idb-vector-yhy, idb-vector-q8s9 and idb-vector-t2vo.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The dataset wait has to survive a host shared with several agent turns and a browser: seeding
// measured 17.9s at load 5.7 and 34.1s on the merge-base, and a real FULL gate blew through 300s at
// load >16. Anything below this floor is a budget that assumes a fair CPU share.
const MIN_DATASET_SEED_TIMEOUT_MS = 600000;

// The search phase runs on that same host right after seeding: the FULL gate failed this wait at 30s
// on a correct tree. One eighth of the 2400s full-gate allowance is the floor for a single phase.
const MIN_SEARCH_COMPLETE_TIMEOUT_MS = 300000;

function readBrowserSource() {
  return readFile(new URL('../../tests/browser.mjs', import.meta.url), 'utf8');
}

/**
 * The budget a wait passes as `timeout:`: a literal at the call site, or a named constant declared
 * nearby as a numeric literal. Returns the number of milliseconds.
 */
function resolveBudget(browserSrc, token) {
  const literal = Number(token.replaceAll('_', ''));
  if (!Number.isNaN(literal)) return literal;
  const declaration = new RegExp(`const\\s+${token}\\s*=\\s*(\\d[\\d_]*)`).exec(browserSrc);
  assert.ok(declaration, `timeout budget constant ${token} must be declared as a numeric literal`);
  return Number(declaration[1].replaceAll('_', ''));
}

test('tests/browser.mjs dataset seeding wait budget is bounded near the full gate with clear attribution (idb-vector-6b1)', async () => {
  const browserSrc = await readBrowserSource();

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
  const budget = resolveBudget(browserSrc, call[1]);
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

test('tests/browser.mjs search-complete wait budget is derived from the full gate and each search phase is labelled (idb-vector-t2vo)', async () => {
  const browserSrc = await readBrowserSource();

  // The search wait resolves its budget at the call site, like the dataset wait does.
  const predicate = browserSrc.indexOf("'Search complete'");
  assert.ok(predicate !== -1, "must wait for the page's 'Search complete' status");
  const budgetToken = /timeout:\s*([A-Za-z_$][\w$]*|\d[\d_]*)/.exec(browserSrc.slice(predicate));
  assert.ok(budgetToken, 'the search-complete wait must pass an explicit budget, not the 15s default');
  const budget = resolveBudget(browserSrc, budgetToken[1]);
  assert.ok(
    budget >= MIN_SEARCH_COMPLETE_TIMEOUT_MS,
    `search-complete budget must be at least ${MIN_SEARCH_COMPLETE_TIMEOUT_MS}ms, got ${budget}ms`,
  );

  // Every search wait names its phase at the call site, so a timeout says which click stalled.
  const phases = [...browserSrc.matchAll(/waitForSearchComplete\(\s*page\s*,\s*(['"])([^'"\n]+)\1\s*\)/g)]
    .map(match => match[2]);
  assert.ok(phases.length >= 3, `expected a labelled wait for each search phase, found ${phases.length}`);
  assert.ok(
    phases.some(phase => phase.startsWith('search complete after #search')),
    `a search phase label must read "search complete after #search", got ${JSON.stringify(phases)}`,
  );

  // Both status waits (dataset and search) carry a label: a timeout has to name the phase it guards.
  const waits = browserSrc.split('page.waitFor(').slice(1);
  assert.ok(waits.length >= 2, 'expected the dataset and search status waits');
  for (const [index, wait] of waits.entries()) {
    assert.match(
      wait,
      /\blabel[,:]\s*(['"]|[A-Za-z_$][\w$]*)/,
      `page.waitFor call #${index + 1} must pass a label naming the phase it guards`,
    );
  }

  // A timed-out search must report elapsed ms, the budget and the page's last #status text, reusing
  // the same attribution as the dataset wait rather than a second variant of it.
  assert.match(
    browserSrc,
    /ms budget; page #status:/,
    'timed-out search must report elapsed ms, the budget and the last #status text',
  );

  // The driver reports the measured search duration so contention is visible in the log.
  assert.match(browserSrc, /Search complete in \$\{/, 'must log the measured search duration');
});
