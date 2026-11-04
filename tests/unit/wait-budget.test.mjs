// tests/unit/wait-budget.test.mjs — the one pin over the browser drivers' wait budgets (idb-vector-t5wv).
//
// The budgets and the timeout attribution used to be declared in each driver, and two suites pinned
// them independently: tests/unit/browser.test.mjs carried MIN_DATASET_SEED_TIMEOUT_MS /
// MIN_SEARCH_COMPLETE_TIMEOUT_MS and tests/unit/demo-ready-wait-budget.test.mjs carried
// MIN_READY_WAIT_MS / MIN_PAGE_WORK_WAIT_MS. Two floors over two copies of one derivation can
// disagree with the values they guard. Both floors now derive from one constant here, and the
// drivers must import the module rather than re-deriving anything.
//
// Membership in the shared set is not a floor (idb-vector-t5wv review): under it a corpus-load phase
// could be swapped onto the page-work budget and every suite stayed green. EXPECTED_PHASE_BUDGETS
// restores the per-phase floor - which phase spends which constant, at the call site - and the gate
// test pairs GATE_CHECK_TIMEOUT_MS with the conf that sets it, because a floor derived from a
// constant accepts every value of that constant.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GATE_CHECK_TIMEOUT_MS,
  PAGE_WORK_WAIT_MS,
  READY_WAIT_MS,
  STORAGE_PROBE_WAIT_MS,
} from '../lib/wait-budget.mjs';

// Every driver that spends these budgets. They are the drivers the old per-file floors covered, and
// a fourth driver would arrive here rather than declaring a budget of its own.
const DRIVERS = ['tests/browser.mjs', 'tests/wikipedia-demo.mjs', 'tests/demo-restore-trust.mjs'];

// What tests/lib/wait-budget.mjs spends: the imported names a driver may hand a wait. `budgetMs` is
// waitForPhase forwarding its own parameter, so it is a passthrough rather than a budget of its own.
const SHARED_BUDGETS = { READY_WAIT_MS, PAGE_WORK_WAIT_MS, STORAGE_PROBE_WAIT_MS };

// The full-gate total, as the explicit literal ~/.fleet/idb-vector-check.conf sets in CHECK_TIMEOUT.
// Asserted rather than derived: every floor below is a fraction of GATE_CHECK_TIMEOUT_MS, so the
// floors alone accept any value that constant takes, and a careless edit of it would move all three
// budgets' base without a red.
const EXPECTED_GATE_CHECK_TIMEOUT_MS = 3600000;

// Where the conf that owns CHECK_TIMEOUT lives. It is a local file outside this repo (and one an
// install script has clobbered once), so a checkout may not have it: the test then asserts the
// in-repo literal and says so, and fails on a mismatch whenever the file is there.
const CHECK_CONF = process.env.FLEET_CHECK_CONF || join(homedir(), '.fleet', 'idb-vector-check.conf');

// Which phase spends which budget, read from the call site. The left column is the phase label the
// driver writes next to the wait, so a red names the driver and the phase a reviewer has to look at.
// A wait labelled with a phase missing from this table fails: a new wait arrives with its floor.
const EXPECTED_PHASE_BUDGETS = {
  'tests/wikipedia-demo.mjs': [
    ['query results for ${JSON.stringify(value)}', 'PAGE_WORK_WAIT_MS'],
    ['explicit load of the 250-passage corpus', 'READY_WAIT_MS'],
    ['offline network emulation', 'PAGE_WORK_WAIT_MS'],
    ['offline 2,000-passage load fails', 'READY_WAIT_MS'],
    ['injected write failure during the 2,000-passage load', 'READY_WAIT_MS'],
    ['2,000-passage load after synchronous write failure', 'READY_WAIT_MS'],
    ['stored corpus probe', 'PAGE_WORK_WAIT_MS'],
    ['restore of stored 2,000-passage corpus', 'READY_WAIT_MS'],
    ['clear of stored passages, vectors and model cache', 'PAGE_WORK_WAIT_MS'],
    ['storage probe after clear', 'PAGE_WORK_WAIT_MS'],
  ],
  // The dataset build behind #generate is this driver's one corpus load. Its three searches pass a
  // label to waitForSearchComplete, which spends PAGE_WORK_WAIT_MS inside the helper: that call shape
  // is pinned in tests/unit/browser.test.mjs, where the helper's budget is read.
  'tests/browser.mjs': [['dataset creation (#generate seeding)', 'READY_WAIT_MS']],
  'tests/demo-restore-trust.mjs': [
    ['incomplete storage message after reload', 'STORAGE_PROBE_WAIT_MS'],
    ['demo restore: waiting for Ready', 'READY_WAIT_MS'],
    ['invalid storage message after reload', 'STORAGE_PROBE_WAIT_MS'],
  ],
};

const readSource = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every phase label a driver writes in an options object, as literal text. */
function phaseLabels(src) {
  return [...src.matchAll(/\b(?:phase|label)\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(match => match[2]);
}

/** The budget tokens written within 400 characters of each `phase`/`label` literal, for a red's message. */
function tokensNearPhase(src, phase) {
  const tokens = [];
  for (const match of src.matchAll(new RegExp(`\\b(?:phase|label)\\s*:\\s*(['"\`])${escapeRegExp(phase)}\\1`, 'g'))) {
    const window = src.slice(Math.max(0, match.index - 400), match.index + 400);
    tokens.push(...[...window.matchAll(/(?:timeout|budgetMs)\s*:\s*([A-Za-z_$][\w$]*|\d[\d_]*)/g)].map(found => found[1]));
  }
  return tokens;
}

/**
 * `true` when one `{ ... }` object literal in `src` carries this phase label and this budget token,
 * in either order. The object's own braces are excluded from the gaps, so a label and a budget from
 * two different call sites cannot satisfy it.
 */
function spendsOnPhase(src, phase, token) {
  const label = `(?:phase|label)\\s*:\\s*(['"\`])${escapeRegExp(phase)}\\1`;
  const budget = `(?:timeout|budgetMs)\\s*:\\s*${token}\\b`;
  return new RegExp(`\\{[^{}]*${label}[^{}]*${budget}`).test(src) || new RegExp(`\\{[^{}]*${budget}[^{}]*${label}`).test(src);
}

test('the shared wait budgets stay above their fractions of the full gate (idb-vector-t5wv)', () => {
  // The conf's CHECK_TIMEOUT is the total every driver here runs inside (all three run from
  // `npm test`, i.e. CHECK_CMD, not the fast tier). The floors below are the fractions the module's
  // comments claim - a sixth for a corpus load, a twelfth for any other page phase, a sixtieth for the
  // async storage probe - so a raised gate bound has to land in one place and the budgets move with
  // it instead of quietly going stale.
  assert.ok(
    Number.isInteger(GATE_CHECK_TIMEOUT_MS) && GATE_CHECK_TIMEOUT_MS > 0,
    `GATE_CHECK_TIMEOUT_MS must be a whole number of milliseconds, got ${GATE_CHECK_TIMEOUT_MS}`,
  );
  assert.ok(
    READY_WAIT_MS >= GATE_CHECK_TIMEOUT_MS / 6,
    `READY_WAIT_MS is ${READY_WAIT_MS}ms; the corpus-load phases in tests/wikipedia-demo.mjs (the 250- and 2,000-passage loads, the offline failure and the restore), tests/browser.mjs (the #generate dataset build) and tests/demo-restore-trust.mjs (the 250-passage restore) get a sixth of the full gate's ${GATE_CHECK_TIMEOUT_MS}ms, so READY_WAIT_MS must not be below ${GATE_CHECK_TIMEOUT_MS / 6}ms (measured 233s and 242.8s under load, idb-vector-k6wh/g85a)`,
  );
  assert.ok(
    PAGE_WORK_WAIT_MS >= GATE_CHECK_TIMEOUT_MS / 12,
    `PAGE_WORK_WAIT_MS is ${PAGE_WORK_WAIT_MS}ms; the page-work phases (a search in tests/browser.mjs, a query/offline/clear/storage probe in tests/wikipedia-demo.mjs) get a twelfth of the full gate's ${GATE_CHECK_TIMEOUT_MS}ms, so PAGE_WORK_WAIT_MS must not be below ${GATE_CHECK_TIMEOUT_MS / 12}ms`,
  );
  assert.ok(
    STORAGE_PROBE_WAIT_MS >= GATE_CHECK_TIMEOUT_MS / 60,
    `STORAGE_PROBE_WAIT_MS is ${STORAGE_PROBE_WAIT_MS}ms; the two storage-probe waits in tests/demo-restore-trust.mjs ('incomplete storage message after reload' and 'invalid storage message after reload', each an async IndexedDB inspection of 250 records after a reload) get a sixtieth of the full gate's ${GATE_CHECK_TIMEOUT_MS}ms, so STORAGE_PROBE_WAIT_MS must not be below ${GATE_CHECK_TIMEOUT_MS / 60}ms`,
  );
  assert.ok(
    READY_WAIT_MS > PAGE_WORK_WAIT_MS,
    `a corpus load (${READY_WAIT_MS}ms) must keep a longer budget than a page phase (${PAGE_WORK_WAIT_MS}ms)`,
  );
});

test('the in-repo gate total is the 3600 s the conf sets, and the conf agrees when this machine has it (idb-vector-t5wv)', async () => {
  assert.equal(
    GATE_CHECK_TIMEOUT_MS,
    EXPECTED_GATE_CHECK_TIMEOUT_MS,
    `tests/lib/wait-budget.mjs GATE_CHECK_TIMEOUT_MS is ${GATE_CHECK_TIMEOUT_MS}ms, not the ${EXPECTED_GATE_CHECK_TIMEOUT_MS}ms (3600 s) that ~/.fleet/idb-vector-check.conf sets in CHECK_TIMEOUT. All three wait budgets are floors derived from it, so a careless edit silences every floor at once: if CHECK_TIMEOUT moved, update GATE_CHECK_TIMEOUT_MS here with READY_WAIT_MS (a sixth), PAGE_WORK_WAIT_MS (a twelfth), STORAGE_PROBE_WAIT_MS (a sixtieth) and docs/speed.md:132 together; if it did not, put this back`,
  );

  let conf;
  try {
    conf = await readFile(CHECK_CONF, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log(
      `notice: no check conf at ${CHECK_CONF}, so only the in-repo ${EXPECTED_GATE_CHECK_TIMEOUT_MS} ms literal is asserted; on the fleet VM this test compares it with CHECK_TIMEOUT in that file`,
    );
    return;
  }

  const checkTimeout = /^CHECK_TIMEOUT\s*=\s*(\d+)\s*$/m.exec(conf);
  assert.ok(
    checkTimeout,
    `${CHECK_CONF} has no CHECK_TIMEOUT=<seconds> line, so the ${GATE_CHECK_TIMEOUT_MS}ms copy of it in tests/lib/wait-budget.mjs cannot be checked against anything`,
  );
  const confTimeoutMs = Number(checkTimeout[1]) * 1000;
  assert.equal(
    GATE_CHECK_TIMEOUT_MS,
    confTimeoutMs,
    `${CHECK_CONF} sets CHECK_TIMEOUT=${checkTimeout[1]} (${confTimeoutMs}ms) but tests/lib/wait-budget.mjs GATE_CHECK_TIMEOUT_MS is ${GATE_CHECK_TIMEOUT_MS}ms. The in-repo copy and the floors that derive from it move with the conf: update GATE_CHECK_TIMEOUT_MS, READY_WAIT_MS (a sixth), PAGE_WORK_WAIT_MS (a twelfth), STORAGE_PROBE_WAIT_MS (a sixtieth) and docs/speed.md:132 - or fix the conf if that raise was not intended (idb-vector-t5wv)`,
  );
});

test('every labelled wait spends the budget its own phase requires (idb-vector-t5wv)', async () => {
  for (const [driver, rows] of Object.entries(EXPECTED_PHASE_BUDGETS)) {
    const src = await readSource(driver);
    const labels = phaseLabels(src);

    for (const [phase, budget] of rows) {
      assert.equal(
        phaseLabels(await readSource(driver)).filter(label => label === phase).length > 0,
        true,
        `${driver} has no wait labelled ${JSON.stringify(phase)}, so this phase's floor covers nothing; the driver's waits are ${JSON.stringify(labels)}`,
      );
      assert.ok(
        spendsOnPhase(src, phase, budget),
        `${driver}: the ${JSON.stringify(phase)} phase does not spend ${budget} at its call site (found ${JSON.stringify(tokensNearPhase(src, phase))}). A corpus load, dataset build or restore spends READY_WAIT_MS (600000 ms), any other page phase PAGE_WORK_WAIT_MS (300000 ms), and the two async storage probes in tests/demo-restore-trust.mjs STORAGE_PROBE_WAIT_MS (60000 ms): swapping a phase onto another shared budget is what this floor catches (idb-vector-t5wv review)`,
      );
    }

    for (const label of labels) {
      assert.equal(
        rows.some(([phase]) => phase === label),
        true,
        `${driver} waits on the phase ${JSON.stringify(label)}, which EXPECTED_PHASE_BUDGETS does not list: add a row naming that phase and the budget it must spend, so a new wait arrives with a floor (idb-vector-t5wv)`,
      );
    }
  }
});

test('all three browser drivers spend the shared budgets instead of re-deriving them (idb-vector-t5wv)', async () => {
  for (const driver of DRIVERS) {
    const src = await readSource(driver);

    // The driver imports the one definition. A local declaration is what drifted before.
    assert.match(
      src,
      /import \{[^}]*\} from '\.\/lib\/wait-budget\.mjs';/,
      `${driver} must import its wait budgets from tests/lib/wait-budget.mjs`,
    );
    assert.doesNotMatch(
      src,
      /const\s+[A-Z][A-Z0-9_]*(?:TIMEOUT|WAIT)_MS\s*=\s*\d/,
      `${driver} must not declare its own wait budget: the one definition is tests/lib/wait-budget.mjs`,
    );
    assert.doesNotMatch(
      src,
      /(?:async\s+)?function\s+(?:lastStatusText|timedOutAfter)\s*\(/,
      `${driver} must not copy the timeout-attribution helpers: they are exported by tests/lib/wait-budget.mjs`,
    );

    // Every budget a wait spends is one of the shared names, never a literal: a numeric literal here
    // is how the 180s/15s budgets got in, and it bypasses the floors above.
    const tokens = [...src.matchAll(/(?:timeout|budgetMs)\s*:\s*([A-Za-z_$][\w$]*|\d[\d_]*)/g)].map(match => match[1]);
    assert.ok(tokens.length > 0, `${driver} must spend at least one budgeted wait`);
    for (const token of tokens) {
      if (token === 'budgetMs') continue;
      assert.ok(
        token in SHARED_BUDGETS,
        `${driver} spends ${token}, which tests/lib/wait-budget.mjs does not export; a wait budget comes from there, not from a literal or a local constant`,
      );
    }
  }
});
