// tests/lib/wait-budget.mjs — the wait budgets and the timeout attribution every browser driver shares.
//
// These were declared once per driver (idb-vector-t5wv): 600000 ms and 300000 ms in tests/browser.mjs,
// tests/wikipedia-demo.mjs and tests/demo-restore-trust.mjs, and lastStatusText/timedOutAfter copied
// byte-for-byte between two of them. Every copy had to be edited by hand when a bound moved, which is
// how five derivations kept arguing from the old 2400 s CHECK_TIMEOUT after the conf moved to 3600 s
// (idb-vector-wjf5).
//
// The budgets are set by loaded-host measurements, not by arithmetic on the gate total:
//
// - READY_WAIT_MS covers the phase that builds or restores a corpus: the model download, dataset
//   generation, and the commit itself. A 250-passage load measured 233 s standalone under host load
//   (idb-vector-k6wh) and spent 242.8 s inside the full gate (idb-vector-g85a), which is why the 180 s
//   bound tests/demo-restore-trust.mjs carried failed a correct tree; seeding the synthetic dataset
//   measured 17.9 s at load 5.7 and 25-34 s at load 17, and a full gate run at load >16 blew through
//   300 s.
// - PAGE_WORK_WAIT_MS covers every other page phase: a search, a query encode, a 2,000-record
//   IndexedDB probe, a clear. The full gate failed a search wait at 30 s on a correct tree at load
//   >16, and the run that measured 108.1 s of seeding at load 14.79 took 206 s end to end.
//
// Both are compared against the full gate's total: 600000 ms is a sixth of it, 300000 ms a twelfth.
// GATE_CHECK_TIMEOUT_MS below is that total, and tests/unit/wait-budget.test.mjs pins the two
// fractions against it, so the numbers cannot go stale against the gate they run inside.
export const READY_WAIT_MS = 600000;
export const PAGE_WORK_WAIT_MS = 300000;

/**
 * `~/.fleet/idb-vector-check.conf` `CHECK_TIMEOUT` (3600 s, raised from 2400 s by idb-vector-9dze).
 * The conf is a local file outside this repo - and one an install script has already clobbered once -
 * so the tree keeps one copy of the number and the test derives the floors from it, rather than a
 * driver run depending on a file it cannot see.
 */
export const GATE_CHECK_TIMEOUT_MS = 3600000;

/**
 * The storage-probe waits in tests/demo-restore-trust.mjs: after a reload the page's `#storage` line
 * is written by an async IndexedDB inspection, so the wait is for that message, not for a click.
 */
export const STORAGE_PROBE_WAIT_MS = 60000;

/** The page's last #status line, bounded: a hung renderer must not turn a failure into a stall. */
export async function lastStatusText(page) {
  let timer;
  const unreadable = new Promise(resolve => {
    timer = setTimeout(() => resolve('<unreadable: page unresponsive>'), 5000);
  });
  try {
    return await Promise.race([
      page.evaluate(() => document.querySelector('#status')?.textContent ?? ''),
      unreadable,
    ]);
  } catch (error) {
    return `<unreadable: ${error.message}>`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a wait that ran out of budget into a report of which phase stalled and why: elapsed ms
 * against the budget plus the page's last #status line, so contention (status still mid-work) is
 * distinguishable from a hang (status unchanged since the action).
 */
export async function timedOutAfter(page, error, { phase, elapsedMs, budgetMs, stalledHint }) {
  // page.waitFor's own message already names the label it was given, so a phase the message names
  // must not be prefixed again: the message keeps the wording it was reviewed with.
  const named = error.message.includes(phase) ? '' : `${phase} `;
  return new Error(
    `${error.message}\n  ${named}after ${elapsedMs} ms of a ${budgetMs} ms budget; page #status: ${JSON.stringify(await lastStatusText(page))}` +
      `\n  (${stalledHint})`,
    { cause: error },
  );
}
