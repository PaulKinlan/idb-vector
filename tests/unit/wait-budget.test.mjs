// tests/unit/wait-budget.test.mjs — the one pin over the browser drivers' wait budgets (idb-vector-t5wv).
//
// The budgets and the timeout attribution used to be declared in each driver, and two suites pinned
// them independently: tests/unit/browser.test.mjs carried MIN_DATASET_SEED_TIMEOUT_MS /
// MIN_SEARCH_COMPLETE_TIMEOUT_MS and tests/unit/demo-ready-wait-budget.test.mjs carried
// MIN_READY_WAIT_MS / MIN_PAGE_WORK_WAIT_MS. Two floors over two copies of one derivation can
// disagree with the values they guard. Both floors now derive from one constant here, and the
// drivers must import the module rather than re-deriving anything.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const readSource = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('the shared wait budgets stay above their fractions of the full gate (idb-vector-t5wv)', () => {
  // The conf's CHECK_TIMEOUT is the total every driver here runs inside (all three run from
  // `npm test`, i.e. CHECK_CMD, not the fast tier). The floors below are the fractions the module's
  // comments claim - a sixth for a corpus load, a twelfth for any other page phase - so a raised gate
  // bound has to land in one place and the budgets move with it instead of quietly going stale.
  assert.ok(
    Number.isInteger(GATE_CHECK_TIMEOUT_MS) && GATE_CHECK_TIMEOUT_MS > 0,
    `GATE_CHECK_TIMEOUT_MS must be a whole number of milliseconds, got ${GATE_CHECK_TIMEOUT_MS}`,
  );
  assert.ok(
    READY_WAIT_MS >= GATE_CHECK_TIMEOUT_MS / 6,
    `READY_WAIT_MS is ${READY_WAIT_MS}ms; a corpus load gets a sixth of the full gate's ${GATE_CHECK_TIMEOUT_MS}ms, so not below ${GATE_CHECK_TIMEOUT_MS / 6}ms (measured 233s and 242.8s under load, idb-vector-k6wh/g85a)`,
  );
  assert.ok(
    PAGE_WORK_WAIT_MS >= GATE_CHECK_TIMEOUT_MS / 12,
    `PAGE_WORK_WAIT_MS is ${PAGE_WORK_WAIT_MS}ms; a page phase gets a twelfth of the full gate's ${GATE_CHECK_TIMEOUT_MS}ms, so not below ${GATE_CHECK_TIMEOUT_MS / 12}ms`,
  );
  assert.ok(
    READY_WAIT_MS > PAGE_WORK_WAIT_MS,
    `a corpus load (${READY_WAIT_MS}ms) must keep a longer budget than a page phase (${PAGE_WORK_WAIT_MS}ms)`,
  );
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
