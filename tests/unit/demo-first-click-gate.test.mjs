// tests/unit/demo-first-click-gate.test.mjs — the first #load click waits for demo/app.js's init (idb-vector-deh0).
//
// demo/app.js attaches the #load listener only at the end of its top-level await (the IndexedDB open,
// then the stored-corpus read), while demo/index.html supplies an already-enabled button. Chromium
// fires loadEventFired without waiting for that await, so a click dispatched between page.goto and
// the listener attach lands on a listener-less button and is dropped silently; the driver then waits
// out its whole READY_WAIT_MS (600 s) on a load that never started. Three recorded failures had this
// signature, all at tests/wikipedia-demo.mjs's first load phase with #status still at its markup
// default. The driver's later navigations already wait for data-storage-probe; this suite pins that
// the first navigation does too, and that the attribute still means what the wait reads it as.
// It launches no browser: the sources are read as text.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const FIRST_GOTO = 'await page.goto(url);';
const FIRST_LOAD_CLICK = "await page.click('#load');";
const PROBE_READY = "document.documentElement.dataset.storageProbe === 'done'";

test('tests/wikipedia-demo.mjs waits for the demo init before its first #load click (idb-vector-deh0)', async () => {
  const src = await readSource('tests/wikipedia-demo.mjs');
  const gotoAt = src.indexOf(FIRST_GOTO);
  const clickAt = src.indexOf(FIRST_LOAD_CLICK);
  assert.ok(gotoAt >= 0, 'the driver must navigate to the demo page');
  assert.ok(clickAt > gotoAt, `the driver must load the corpus after navigating, found the click at ${clickAt}`);

  // The race window is exactly this slice: a click dispatched here, before the page's module init has
  // finished, is the click the defect drops. The wait has to be inside it - a gate placed later in the
  // run would be the restore waits that already exist and would not protect this click.
  const between = src.slice(gotoAt + FIRST_GOTO.length, clickAt);
  assert.ok(
    between.includes('waitForPhase(') && between.includes(PROBE_READY),
    `tests/wikipedia-demo.mjs must wait for ${PROBE_READY} between its first goto and its first #load click: demo/app.js attaches that listener only after a top-level await, so the click is dropped and the run burns READY_WAIT_MS on a load that never started (idb-vector-deh0)`,
  );
  assert.ok(
    between.includes('budgetMs: PAGE_WORK_WAIT_MS'),
    'the init gate is page work, not a corpus load: it must spend the shared PAGE_WORK_WAIT_MS budget (tests/lib/wait-budget.mjs)',
  );
  // A stalled init has two different causes, and the timeout has to say which one it hit: still
  // running is host contention, never publishing at all is a module that failed to evaluate.
  assert.match(
    between,
    /stalledHint: '[^']*host contention[^']*module failed'/,
    'the init gate must distinguish "module init still running => host contention" from "no probe => module failed" in its stalledHint',
  );
});

test('demo/app.js publishes data-storage-probe before it attaches the #load listener (idb-vector-deh0)', async () => {
  const src = await readSource('demo/app.js');
  const publishedAt = src.indexOf("document.documentElement.dataset.storageProbe = 'done'");
  const listenerAt = src.indexOf("$('load').addEventListener('click'");
  assert.ok(publishedAt > 0, 'demo/app.js must publish data-storage-probe, or the drivers have nothing to wait for');
  assert.ok(listenerAt > 0, 'demo/app.js must attach the #load click listener');
  assert.ok(
    listenerAt > publishedAt,
    'the driver waits for data-storage-probe and then clicks #load, so the attribute must be published in the same tail that attaches the listener, not before an earlier step',
  );
  // And the attribute keeps meaning "the init has finished" only while nothing awaits between the
  // two: an await inserted there would reopen the window the driver's wait then passes straight into.
  const tail = src.slice(publishedAt, listenerAt);
  assert.doesNotMatch(
    tail,
    /\bawait\b/,
    'no await may sit between publishing data-storage-probe and attaching the #load listener: the attribute is the driver\'s signal that the listener is attached',
  );
});
