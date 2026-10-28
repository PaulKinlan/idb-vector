// tests/unit/demo-ready-wait-budget.test.mjs — regression protection for idb-vector-k6wh.
//
// The demo drivers wait for a '#status' that reports Ready: after the model is fetched and a corpus is
// committed. Those waits were per-site guesses (120s, 180s) shorter than the workload they guard:
// tests/demo-restore-trust.mjs measured 233s standalone under host load and timed out in the full gate
// on a correct tree. The budgets are now declared once per file, derived from the gate's allowance, and
// labelled so a timeout names its phase. This tier launches no browser: the sources are read as text.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const MIN_READY_WAIT_MS = 600000;

const readSource = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

function assertGateDerivedReadyBudget(src, file) {
  assert.doesNotMatch(
    src,
    /timeout:\s*(?:120000|180000)\b/,
    `${file} must not bound a demo load wait at 120s/180s: those budgets are shorter than the workload under host load (idb-vector-k6wh)`,
  );

  const declaration = /const READY_WAIT_MS = (\d+);/.exec(src);
  assert.ok(declaration, `${file} must declare its demo load wait budget as READY_WAIT_MS`);
  assert.ok(
    Number(declaration[1]) >= MIN_READY_WAIT_MS,
    `${file} READY_WAIT_MS is ${declaration[1]}ms; a load wait shorter than ${MIN_READY_WAIT_MS}ms cannot cover a loaded 250-passage load (measured 233s)`,
  );

  const sites = [...src.matchAll(/timeout: READY_WAIT_MS(, label: '[^']+')?/g)];
  assert.ok(sites.length > 0, `${file} must spend READY_WAIT_MS on its load waits`);
  assert.ok(
    sites.every(site => site[1]),
    `${file} must label every READY_WAIT_MS wait so a timeout names the phase that stalled`,
  );
}

test('tests/demo-restore-trust.mjs derives its Ready wait from the gate and reports the stalled status (idb-vector-k6wh)', async () => {
  const src = await readSource('tests/demo-restore-trust.mjs');

  assertGateDerivedReadyBudget(src, 'tests/demo-restore-trust.mjs');
  assert.match(src, /label: 'demo restore: waiting for Ready'/, 'the restore wait must name its phase');
  assert.match(src, /#status was/, 'a restore timeout must report the page status it stalled on');
  assert.match(src, /Restored 250 passages in/, 'the run must log the measured restore duration that justifies the budget');
});

test('tests/wikipedia-demo.mjs spends the same gate-derived budget on every corpus load phase (idb-vector-k6wh)', async () => {
  const src = await readSource('tests/wikipedia-demo.mjs');

  assertGateDerivedReadyBudget(src, 'tests/wikipedia-demo.mjs');
  const sites = [...src.matchAll(/timeout: READY_WAIT_MS, label: '([^']+)'/g)].map(site => site[1]);
  assert.ok(sites.length >= 3, 'the explicit load, the 2,000-passage load and the stored-corpus restore all spend READY_WAIT_MS');
});

test('no test driver keeps a 120s/180s magic-number wait budget (idb-vector-k6wh)', async () => {
  const dir = new URL('../../tests/', import.meta.url);
  const drivers = (await readdir(dir)).filter(name => name.endsWith('.mjs'));

  for (const driver of drivers) {
    assert.doesNotMatch(
      await readFile(new URL(driver, dir), 'utf8'),
      /timeout:\s*(?:120000|180000)\b/,
      `tests/${driver} carries a 120s/180s wait budget: derive it from the full gate's allowance and label the wait (idb-vector-k6wh)`,
    );
  }
});
