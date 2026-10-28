// tests/unit/cdp.test.mjs — regression protection for idb-vector-kxz2 and idb-vector-h5mq.
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

function resolveBudget(src, token) {
  const literal = Number(token.replaceAll('_', ''));
  if (!Number.isNaN(literal)) return literal;
  const decl = new RegExp(`(?:const|let|var|export\\s+const)\\s+${token}\\s*=\\s*(\\d[\\d_]*)`).exec(src);
  assert.ok(decl, `timeout budget constant ${token} must be declared as a numeric literal`);
  return Number(decl[1].replaceAll('_', ''));
}

test('tests/lib/cdp.mjs bounds DevTools endpoint wait from loaded cold-start measurement (idb-vector-kxz2)', async () => {
  const cdpSrc = await readFile(new URL('../lib/cdp.mjs', import.meta.url), 'utf8');

  // Must not keep the old 20s magic number on the launch timer (single-line or multiline):
  const wsBlock = /const\s+wsUrl\s*=\s*await\s+new\s+Promise\([\s\S]*?child\.on\("exit"[\s\S]*?\);/.exec(cdpSrc);
  assert.ok(wsBlock, 'cdp.mjs must contain wsUrl promise block');

  assert.doesNotMatch(
    wsBlock[0],
    /setTimeout\([\s\S]*?,\s*20000\s*\)/,
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

  // Must resolve the budget from the launch timer call site (idb-vector-h5mq):
  const timerCall = /setTimeout\(\s*\(\)\s*=>\s*reject\([\s\S]*?chromium did not print a DevTools endpoint[\s\S]*?\),\s*([A-Za-z_$][\w$]*|\d[\d_]*)\s*,?\s*\)/.exec(wsBlock[0]);
  assert.ok(timerCall, 'DevTools endpoint reject timer must be registered with a timeout argument');
  const launchBudget = resolveBudget(cdpSrc, timerCall[1]);
  assert.ok(
    launchBudget >= MIN_LAUNCH_BUDGET_MS,
    `launch timer budget at call site must be at least ${MIN_LAUNCH_BUDGET_MS}ms, got ${launchBudget}ms`,
  );

  // Must report elapsed duration in milliseconds on timeout or early exit:
  assert.match(
    wsBlock[0],
    /chromium did not print a DevTools endpoint after \$\{[^}]+\}ms/,
    'must report elapsed milliseconds on DevTools endpoint timeout',
  );
  assert.match(
    wsBlock[0],
    /chromium exited early \([^)]+\) after \$\{[^}]+\}ms/,
    'must report elapsed milliseconds on early process exit',
  );
});
