// tools/evaluate-quantized-pass.mjs writes its report where tools/report-target.mjs says. A fixed
// os.tmpdir() name let two concurrent runs clobber each other's report (idb-vector-8oy), so each
// run gets a unique mkdtemp directory it removes when done — unless the caller pinned a path.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { reportTarget } from '../../tools/report-target.mjs';

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
