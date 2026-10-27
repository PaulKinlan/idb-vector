// idb-vector-bqw / ADR idb-vector-80j: the 100000x128 packed-snapshot measurement is a benchmark, and it
// must stay out of the merger's full gate. It used to run inside npm run test:packed, where it pushed the
// gate past 900s at host load ~10 (37% of the 2400s allowance) to re-check something the small corpora
// already prove. The size-dependent check is not dropped: it has its own command, a scheduled owner, and
// evidence that survives the run. This guard is text-level on purpose - it costs nothing, cannot flake,
// and fails loudly if the corpus or the schedule wiring is quietly removed or moved back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { resolveEvidenceDir } from '../packed-snapshot-stress.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const gateLeg = readFileSync('tests/packed-snapshot.mjs', 'utf8');
const stressLeg = readFileSync('tests/packed-snapshot-stress.mjs', 'utf8');
const speed = readFileSync('docs/speed.md', 'utf8');
const workflow = readFileSync('.github/workflows/packed-stress.yml', 'utf8');

test('the full-gate packed leg is the small correctness leg and the stress run has its own command', () => {
  assert.equal(pkg.scripts['test:packed'], 'node tests/packed-snapshot.mjs');
  assert.equal(pkg.scripts['measure:packed-snapshot'], 'node tests/packed-snapshot-stress.mjs');
  assert.doesNotMatch(gateLeg, /count:\s*100000/, 'the 100000-vector corpus must not run in the merger gate');
  assert.match(gateLeg, /count:\s*1000,\s*dimensions:\s*128/, 'a synthetic corpus must stay in the gate');
  assert.match(stressLeg, /100000/, 'the stress command still names the high-cardinality run');
  assert.match(speed, /measure:packed-snapshot/, 'docs/speed.md names the command');
  assert.match(speed, /packed-stress\.yml/, 'docs/speed.md names the schedule owner');
});

test('the stress measurement has a scheduled, change-triggered owner that keeps its evidence', () => {
  assert.match(workflow, /^on:/m);
  assert.match(workflow, /^\s*schedule:/m, 'the stress run must not depend on someone remembering it');
  assert.match(workflow, /utils\/packed-snapshot\.js/, 'changes to the packed-snapshot path trigger it');
  assert.match(workflow, /upload-artifact/, 'the evidence is published, not left in a temp dir');
  assert.match(stressLeg, /Evidence kept/, 'the run prints where its evidence went');
  assert.doesNotMatch(stressLeg, /rm\(evidenceDir/, 'the evidence directory must survive the run');
  assert.doesNotMatch(stressLeg, /reportTarget/, 'a tracked report must never be mutated by a measurement');
});

test('the stress measurement routes its evidence directory through tools/report-target.mjs', async (t) => {
  assert.match(stressLeg, /from\s+['"]\.\.\/tools\/report-target\.mjs['"]/, 'must import report-target.mjs');
  assert.match(stressLeg, /runDir\(configured,\s*['"]idb-packed-stress-['"]\)/, 'must route through runDir with prefix');
  assert.doesNotMatch(stressLeg, /\bmkdtemp\b/, 'must not call mkdtemp directly');
  assert.doesNotMatch(stressLeg, /\bmkdir\b/, 'must not call mkdir directly');

  // Verify the stress driver's routed evidence directory choice:
  // 1. Configured directory is used verbatim and unowned:
  const configured = join(os.tmpdir(), `idb-stress-configured-${process.pid}`);
  t.after(() => rm(configured, { recursive: true, force: true }));
  const pinnedResult = resolveEvidenceDir(configured);
  assert.equal(pinnedResult.dir, configured);
  assert.equal(pinnedResult.owned, false);
  assert.ok(existsSync(configured));

  // 2. Default (unconfigured) runs get unique owned directories under temp with idb-packed-stress- prefix:
  const defaultA = resolveEvidenceDir(undefined);
  const defaultB = resolveEvidenceDir(undefined);
  t.after(async () => {
    await rm(defaultA.dir, { recursive: true, force: true });
    await rm(defaultB.dir, { recursive: true, force: true });
  });
  assert.notEqual(defaultA.dir, defaultB.dir);
  assert.ok(defaultA.owned && defaultB.owned);
  assert.ok(existsSync(defaultA.dir) && existsSync(defaultB.dir));
  assert.ok(defaultA.dir.includes('idb-packed-stress-'));
});
