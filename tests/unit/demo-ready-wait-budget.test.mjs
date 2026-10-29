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

// Everything in tests/wikipedia-demo.mjs that is not a corpus load (a query encodes through the model,
// the storage probes read 2,000 IndexedDB records) gets one eighth of the full gate's 2400s allowance,
// the derivation tests/browser.mjs uses for its search wait. A literal below either floor assumes a
// fair CPU share, which is what let waitFor's 15s default fail a correct tree (idb-vector-g85a).
const MIN_PAGE_WORK_WAIT_MS = 300000;

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

/**
 * The arguments of the call that opens at `open`, split at top-level commas. String literals are
 * skipped so a bracket inside a message cannot move the depth counter.
 */
function callArguments(src, open) {
  const closers = { '(': ')', '[': ']', '{': '}' };
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < src.length; i += 1) {
    const char = src[i];
    if (char === "'" || char === '"' || char === '`') {
      for (i += 1; i < src.length && src[i] !== char; i += 1) if (src[i] === '\\') i += 1;
      continue;
    }
    if (closers[char]) depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return args;
      }
    } else if (char === ',' && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  assert.fail('a waitForPhase call must be closed');
}

/** A budget written as a numeric literal, or the numeric literal a named constant is declared with. */
function resolveBudget(src, token) {
  const literal = Number(token.replaceAll('_', ''));
  if (!Number.isNaN(literal)) return literal;
  const declaration = new RegExp(`const\\s+${token}\\s*=\\s*(\\d[\\d_]*)`).exec(src);
  assert.ok(declaration, `wait budget constant ${token} must be declared as a numeric literal`);
  return Number(declaration[1].replaceAll('_', ''));
}

/**
 * Every waitForPhase call site, with the phase label and budget token written in the options object AT
 * THAT CALL. The helper's own declaration is skipped: it passes its parameters on, and the call sites
 * are what a reviewer would have to change.
 */
function phaseWaits(src) {
  const waits = [];
  for (const match of src.matchAll(/waitForPhase\(/g)) {
    if (/function\s+$/.test(src.slice(0, match.index))) continue;
    const [, , options] = callArguments(src, match.index + 'waitForPhase'.length);
    assert.ok(options?.trim().startsWith('{'), `the waitForPhase call at offset ${match.index} must pass an options object`);
    const phase = /(?:^|[,{]\s*)phase\s*:\s*(?<value>'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/.exec(options)?.groups.value;
    const budgetToken = /(?:^|[,{]\s*)budgetMs\s*:\s*(?<value>[A-Za-z_$][\w$]*|\d[\d_]*)/.exec(options)?.groups.value;
    waits.push({ phase, budgetToken });
  }
  return waits;
}

test('tests/wikipedia-demo.mjs gives every page wait a gate-derived budget and names its phase (idb-vector-g85a)', async () => {
  const src = await readSource('tests/wikipedia-demo.mjs');
  assert.doesNotMatch(
    src,
    /timeout:\s*(?:120000|180000)\b/,
    'tests/wikipedia-demo.mjs must not bound a demo load wait at 120s/180s: those budgets are shorter than the workload under host load (idb-vector-k6wh)',
  );

  const declared = name => resolveBudget(src, name);
  assert.ok(
    declared('READY_WAIT_MS') >= MIN_READY_WAIT_MS,
    `READY_WAIT_MS is ${declared('READY_WAIT_MS')}ms; a corpus load measured 242.8s in the full gate, so its budget cannot be shorter than ${MIN_READY_WAIT_MS}ms (idb-vector-g85a)`,
  );
  assert.ok(
    declared('PAGE_WORK_WAIT_MS') >= MIN_PAGE_WORK_WAIT_MS,
    `PAGE_WORK_WAIT_MS is ${declared('PAGE_WORK_WAIT_MS')}ms; a page phase gets an eighth of the full gate's 2400s allowance, so not below ${MIN_PAGE_WORK_WAIT_MS}ms`,
  );

  // Every wait in the driver goes through the one budgeted helper: a bare page.waitFor (15s default)
  // cannot come back anywhere in the file, and the helper must spend its parameter, not a literal.
  const rawWaits = [...src.matchAll(/\.waitFor\(/g)];
  assert.equal(rawWaits.length, 1, `the only waitFor call must be the one inside waitForPhase that spends its budget, found ${rawWaits.length}`);
  const helper = /async function waitForPhase\(page, predicate, \{ phase, budgetMs,\s*[\s\S]*?\n\}/.exec(src);
  assert.ok(helper, 'waitForPhase must take the phase label and its budget as parameters');
  assert.match(helper[0], /timeout:\s*budgetMs\b/, 'waitForPhase must spend its budgetMs parameter, never a literal nor the 15s default');
  assert.match(helper[0], /label:\s*phase\b/, 'waitForPhase must label the wait with the phase it guards');
  assert.match(helper[0], /elapsedMs:\s*Date\.now\(\)\s*-\s*start/, 'waitForPhase must measure how long the phase took');
  assert.match(src, /ms budget; page #status:/, 'a timed-out wait must report elapsed ms, the budget and the last #status text');

  const waits = phaseWaits(src);
  assert.ok(waits.length >= 8, `expected every wait in the driver to go through waitForPhase, found ${waits.length}`);
  for (const wait of waits) {
    assert.ok(wait.phase, 'every waitForPhase call must name its phase so a timeout says which one stalled');
    assert.ok(wait.budgetToken, `waitForPhase call (${wait.phase}) must pass an explicit budgetMs, not waitFor's 15s default`);
    const budget = resolveBudget(src, wait.budgetToken);
    const floor = /load|restore/i.test(wait.phase) ? MIN_READY_WAIT_MS : MIN_PAGE_WORK_WAIT_MS;
    assert.ok(
      budget >= floor,
      `waitForPhase call (${wait.phase}) spends ${budget}ms of its ${wait.budgetToken} budget, below the ${floor}ms floor for ${/load|restore/i.test(wait.phase) ? 'a corpus load' : 'a page phase'}`,
    );
  }

  // The defect this pins: the wait added after the 2,000-passage load spends the load budget, because
  // that load alone measured 242.8s and this wait sat on waitFor's 15s default (ea71d3f, 2026-10-29).
  const injected = waits.find(wait => /injected write failure/i.test(wait.phase ?? ''));
  assert.ok(injected, 'the injected-write-failure wait must name its phase');
  assert.equal(injected.budgetToken, 'READY_WAIT_MS', 'the injected-write-failure wait guards a corpus load, so it spends READY_WAIT_MS');

  // Each corpus load phase and each non-load phase the driver waits for is still covered, by budget:
  const loadPhases = waits.filter(wait => /load|restore/i.test(wait.phase));
  assert.ok(loadPhases.length >= 5, `expected the five corpus load phases, found ${loadPhases.length}`);
  const pagePhases = waits.filter(wait => !/load|restore/i.test(wait.phase));
  assert.ok(pagePhases.length >= 3, `expected the query, offline and clear waits to be budgeted too, found ${pagePhases.length}`);
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
