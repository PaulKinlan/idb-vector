// tests/unit/browser.test.mjs — regression protection for idb-vector-6b1, idb-vector-yhy, idb-vector-q8s9 and idb-vector-t2vo.
//
// The budgets this driver spends are no longer declared here or in the driver: tests/lib/wait-budget.mjs
// holds them and tests/unit/wait-budget.test.mjs pins them against the gate's bound (idb-vector-t5wv).
// What is left to check here is the driver's side of the contract - each wait labelled, budgeted with
// a shared budget, and reported through the shared attribution helper.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PAGE_WORK_WAIT_MS, READY_WAIT_MS, timedOutAfter } from '../lib/wait-budget.mjs';

// The names tests/browser.mjs may hand a wait: one of the shared budgets, or the phase's own label
// forwarded by waitForSearchComplete. A numeric literal or an unimported name is a budget nothing pins.
const SHARED_BUDGETS = { READY_WAIT_MS, PAGE_WORK_WAIT_MS };

function readBrowserSource() {
  return readFile(new URL('../../tests/browser.mjs', import.meta.url), 'utf8');
}

/** The budget a wait passes as `timeout:` must be one of the shared budgets. */
function assertSharedBudget(token, wait) {
  assert.ok(
    token in SHARED_BUDGETS,
    `the ${wait} wait spends ${token}; it must spend a budget tests/lib/wait-budget.mjs exports (${Object.keys(SHARED_BUDGETS).join(', ')})`,
  );
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

  // The budget must be a shared one imported from tests/lib/wait-budget.mjs: a literal here would be
  // a budget with no floor over it, which is the shape idb-vector-k6wh removed.
  assertSharedBudget(call[1], 'dataset creation (#generate seeding)');

  // Must include descriptive label naming dataset creation:
  assert.match(
    browserSrc,
    /label:\s*['"][^'"]*dataset creation[^'"]*['"]/,
    'must include label identifying dataset creation on timeout',
  );

  // A timeout must say whether the host was contended or the page hung: elapsed vs budget plus the
  // page's last #status line. That report is the shared helper's wording (pinned by the q8s9 test
  // below), so what the driver owes is to spend it for this wait.
  assert.match(
    browserSrc,
    /timedOutAfter\(page, error, \{[^}]*phase: 'dataset creation \(#generate seeding\)'/,
    'a timed-out dataset creation must report elapsed ms, the budget and the last #status text',
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

test('tests/browser.mjs search-complete wait spends the shared page-work budget and each search phase is labelled (idb-vector-t2vo)', async () => {
  const browserSrc = await readBrowserSource();

  // The search wait resolves its budget at the call site, like the dataset wait does.
  const predicate = browserSrc.indexOf("'Search complete'");
  assert.ok(predicate !== -1, "must wait for the page's 'Search complete' status");
  const budgetToken = /timeout:\s*([A-Za-z_$][\w$]*|\d[\d_]*)/.exec(browserSrc.slice(predicate));
  assert.ok(budgetToken, 'the search-complete wait must pass an explicit budget, not the 15s default');
  assertSharedBudget(budgetToken[1], 'search-complete');

  // Every search wait names its phase at the call site, so a timeout says which click stalled.
  const phases = [...browserSrc.matchAll(/waitForSearchComplete\(\s*page\s*,\s*(['"])([^'"\n]+)\1\s*\)/g)]
    .map(match => match[2]);
  assert.ok(phases.length >= 3, `expected a labelled wait for each search phase, found ${phases.length}`);
  assert.ok(
    phases.some(phase => phase.startsWith('search complete after #search')),
    `a search phase label must read "search complete after #search", got ${JSON.stringify(phases)}`,
  );

  // The search wait must carry that label itself: resolve the label in the options object at THIS
  // call site. A `label:` anywhere later in the file must not satisfy it, because the phase each
  // caller passes only reaches the timeout when this wait forwards it.
  const optionsStart = browserSrc.indexOf('{', predicate);
  const optionsEnd = browserSrc.indexOf('}', optionsStart);
  assert.ok(
    optionsStart !== -1 && optionsEnd > optionsStart,
    'the search-complete wait must pass a timeout and label options object',
  );
  const searchWaitOptions = browserSrc.slice(optionsStart, optionsEnd + 1);
  const labelEntry = /(?:^|[,{]\s*)label\s*(?::\s*(?<value>['"][^'"]*['"]|[A-Za-z_$][\w$]*))?\s*(?=[,}])/.exec(searchWaitOptions);
  assert.ok(labelEntry, 'the search-complete wait must pass a label naming the phase it guards');
  // `label: 'literal'` names the phase here; a forwarded label (`label` or `label: x`) only names it
  // if the helper takes that as a parameter and its callers pass a search phase.
  const labelValue = labelEntry.groups.value;
  const literalLabel = labelValue?.startsWith("'") || labelValue?.startsWith('"') ? labelValue.slice(1, -1) : undefined;
  if (literalLabel === undefined) {
    const labelRef = labelValue ?? 'label';
    const param = new RegExp(`function\\s+waitForSearchComplete\\s*\\([^)]*\\b${labelRef}\\b[^)]*\\)`);
    assert.match(browserSrc, param, `the search wait's label ${labelRef} must be a waitForSearchComplete parameter`);
  }
  const searchLabels = literalLabel === undefined ? phases : [literalLabel];
  assert.ok(
    searchLabels.every(label => /search/i.test(label)),
    `the search-complete wait's label must name the search phase, got ${JSON.stringify(searchLabels)}`,
  );

  // A timed-out search must report elapsed ms, the budget and the page's last #status text, reusing
  // the same attribution as the dataset wait rather than a second variant of it.
  assert.match(
    browserSrc,
    /timedOutAfter\(page, error, \{[^}]*phase: label/,
    'timed-out search must report elapsed ms, the budget and the last #status text',
  );

  // The driver reports the measured search duration so contention is visible in the log.
  assert.match(browserSrc, /Search complete in \$\{/, 'must log the measured search duration');
});

// The dataset timeout message was reviewed and cleared on idb-vector-q8s9: the phase is named once,
// by the wait's own message, and `after` follows on its own line. The helper is called here from the
// shared module the driver imports (idb-vector-t5wv), so the wording a lane reads is exactly this.
test('the shared timeout attribution keeps the cleared q8s9 wording (idb-vector-t2vo)', async () => {
  const timedOut = await timedOutAfter(
    { evaluate: async () => 'creating dataset: 42%' },
    new Error('timed out waiting for dataset creation (#generate seeding); last value false'),
    {
      phase: 'dataset creation (#generate seeding)',
      elapsedMs: 600000,
      budgetMs: 600000,
      stalledHint: 'still creating => host contention; unchanged since the click => page hang',
    },
  );
  assert.equal(
    timedOut.message,
    'timed out waiting for dataset creation (#generate seeding); last value false\n' +
      '  after 600000 ms of a 600000 ms budget; page #status: "creating dataset: 42%"\n' +
      '  (still creating => host contention; unchanged since the click => page hang)',
  );
});
