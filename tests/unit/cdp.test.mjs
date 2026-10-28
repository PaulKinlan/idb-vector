// tests/unit/cdp-launch-budget.test.mjs — regression protection for idb-vector-kxz2.
//
// Chrome cold start on a contended 2-vCPU VM measured 53.7s under load (2026-10-28); the old 20s
// wait timed out before the DevTools endpoint printed, failing full-gate runs before any test
// executed. cdp.mjs names DEVTOOLS_ENDPOINT_TIMEOUT_MS >= 120000 and reports elapsed ms in errors.
// This test asserts the contract statically from source without launching a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DEVTOOLS_ENDPOINT_TIMEOUT_MS } from '../lib/cdp.mjs';

const MIN_LAUNCH_BUDGET_MS = 120000;

test('tests/lib/cdp.mjs bounds DevTools endpoint wait from loaded cold-start measurement (idb-vector-kxz2)', async () => {
  const cdpSrc = await readFile(new URL('../lib/cdp.mjs', import.meta.url), 'utf8');

  // Must not keep the old 20s magic number:
  assert.doesNotMatch(
    cdpSrc,
    /setTimeout\([^,]+,\s*20000\)/,
    'must not use the 20000ms launch wait that fails cold starts under load (idb-vector-kxz2)',
  );

  // Must declare DEVTOOLS_ENDPOINT_TIMEOUT_MS as a named constant >= 120000ms:
  const decl = /export const DEVTOOLS_ENDPOINT_TIMEOUT_MS = (\d+);/.exec(cdpSrc);
  assert.ok(decl, 'cdp.mjs must export named constant DEVTOOLS_ENDPOINT_TIMEOUT_MS');
  assert.ok(
    Number(decl[1]) >= MIN_LAUNCH_BUDGET_MS,
    `DEVTOOLS_ENDPOINT_TIMEOUT_MS must be at least ${MIN_LAUNCH_BUDGET_MS}ms (measured 53.7s cold start), got ${decl[1]}ms`,
  );
  assert.ok(
    DEVTOOLS_ENDPOINT_TIMEOUT_MS >= MIN_LAUNCH_BUDGET_MS,
    `imported DEVTOOLS_ENDPOINT_TIMEOUT_MS must be >= ${MIN_LAUNCH_BUDGET_MS}ms, got ${DEVTOOLS_ENDPOINT_TIMEOUT_MS}ms`,
  );

  // Must pass DEVTOOLS_ENDPOINT_TIMEOUT_MS to the timer at the call site:
  assert.match(
    cdpSrc,
    /setTimeout\([\s\S]*?DEVTOOLS_ENDPOINT_TIMEOUT_MS[\s\S]*?\)/,
    'must spend DEVTOOLS_ENDPOINT_TIMEOUT_MS on the DevTools endpoint timer',
  );

  // Must report elapsed duration in milliseconds on timeout or early exit:
  assert.match(
    cdpSrc,
    /chromium did not print a DevTools endpoint after \$\{[^}]+\}ms/,
    'must report elapsed milliseconds on DevTools endpoint timeout',
  );
  assert.match(
    cdpSrc,
    /chromium exited early \([^)]+\) after \$\{[^}]+\}ms/,
    'must report elapsed milliseconds on early process exit',
  );
});
