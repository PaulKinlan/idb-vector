// tools/evaluate-quantized-pass.mjs writes its report where tools/report-target.mjs says. A fixed
// os.tmpdir() name let two concurrent runs clobber each other's report (idb-vector-8oy), so each
// run gets a unique mkdtemp directory it removes when done — unless the caller pinned a path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { reportTarget, runDir } from '../../tools/report-target.mjs';

test('two unpinned runs get distinct, real directories under the temp root', async (t) => {
  const a = reportTarget(undefined, 'idb-vector-test-');
  const b = reportTarget(null, 'idb-vector-test-');
  t.after(async () => {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  });
  assert.notEqual(a.path, b.path, 'concurrent runs must not share a report path');
  assert.ok(a.dir.startsWith(join(os.tmpdir(), 'idb-vector-test-')));
  assert.ok(existsSync(a.dir) && existsSync(b.dir));
  // Each run can write its report into its own directory.
  await writeFile(a.path, '{}');
  await writeFile(b.path, '{}');
  // Cleanup removes the run's directory and nothing else.
  await rm(a.dir, { recursive: true, force: true });
  assert.ok(!existsSync(a.dir));
  assert.ok(existsSync(b.dir), 'cleaning one run must not touch another');
});

test('a pinned report path is used verbatim and owns no directory to clean up', () => {
  const pinned = join(os.tmpdir(), 'pinned-report.json');
  const target = reportTarget(pinned, 'idb-vector-test-');
  assert.equal(target.path, pinned);
  assert.equal(target.dir, null);
});

test('the report file keeps its descriptive name inside the unique directory', async (t) => {
  const target = reportTarget(undefined, 'idb-vector-test-', 'side-store-query-smoke.json');
  t.after(() => rm(target.dir, { recursive: true, force: true }));
  assert.ok(target.path.endsWith(join(target.dir.split('/').pop(), 'side-store-query-smoke.json'))
    || target.path === join(target.dir, 'side-store-query-smoke.json'));
  await writeFile(target.path, '{}');
});

test('runDir: two unpinned runs get distinct real directories; a pinned one is created and kept', async (t) => {
  const a = runDir(undefined, 'idb-vector-test-');
  const b = runDir(undefined, 'idb-vector-test-');
  t.after(async () => {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  });
  assert.notEqual(a.dir, b.dir);
  assert.ok(a.owned && b.owned);
  assert.ok(existsSync(a.dir) && existsSync(b.dir));

  const pinned = join(os.tmpdir(), `idb-vector-test-pinned-${process.pid}`);
  t.after(() => rm(pinned, { recursive: true, force: true }));
  const p = runDir(pinned, 'idb-vector-test-');
  assert.equal(p.dir, pinned);
  assert.equal(p.owned, false);
  assert.ok(existsSync(pinned), 'a pinned directory is created if missing');
});
