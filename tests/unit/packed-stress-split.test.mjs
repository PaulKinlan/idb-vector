// idb-vector-bqw / ADR idb-vector-80j: the 100000x128 packed-snapshot measurement is a benchmark, and it
// must stay out of the merger's full gate. It used to run inside npm run test:packed, where it pushed the
// gate past 900s at host load ~10 (37% of the 2400s allowance) to re-check something the small corpora
// already prove. The size-dependent check is not dropped: it has its own command, a scheduled owner, and
// evidence that survives the run. This guard is text-level on purpose - it costs nothing, cannot flake,
// and fails loudly if the corpus or the schedule wiring is quietly removed or moved back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path, { join } from 'node:path';
import { resolveEvidenceDir, targetFiles } from '../packed-snapshot-stress.mjs';

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
  assert.match(stressLeg, /const\s*\{\s*dir:\s*evidenceDir\s*\}\s*=\s*resolveEvidenceDir\(\)/, 'driver must call resolveEvidenceDir()');

  // Verify targetFiles helper enforces path-component containment:
  const sampleDir = '/tmp/sample-evidence-dir';
  const targets = Object.values(targetFiles(sampleDir));
  assert.equal(targets.length, 2);
  for (const target of targets) {
    const rel = path.relative(sampleDir, target);
    assert.ok(rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel), `target (${target}) must be inside ${sampleDir}`);
  }

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

test('stress driver entry point executes when invoked through symlink and refuses silent skip (idb-vector-c2po)', (t) => {
  assert.match(
    stressLeg,
    /realpathSync\.native\(process\.argv\[1\]\)\s*===\s*realpathSync\.native\(fileURLToPath\(import\.meta\.url\)\)/,
    'must use realpathSync to resolve symlinked argv[1] against import.meta.url',
  );

  // 1. Invocation through a symlinked path enters runStress (does not skip):
  const tmp = join(os.tmpdir(), `idb-c2po-test-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const symlinkPath = join(tmp, 'sym-packed-snapshot-stress.mjs');
  const realDriverPath = path.resolve('tests/packed-snapshot-stress.mjs');
  symlinkSync(realDriverPath, symlinkPath);

  let threwSymlink = false;
  try {
    execFileSync(process.execPath, [symlinkPath], {
      env: { ...process.env, PACKED_SNAPSHOT_STRESS_COUNT: 'invalid' },
      stdio: 'pipe',
    });
  } catch (err) {
    threwSymlink = true;
    assert.match(err.stderr.toString(), /PACKED_SNAPSHOT_STRESS_COUNT must be a safe integer/);
  }
  assert.ok(threwSymlink, 'symlinked invocation must execute runStress and enter driver logic');

  // 2. Mismatched target named packed-snapshot-stress refuses silent skip with exit code 1:
  let threwMismatch = false;
  try {
    execFileSync(
      process.execPath,
      [
        '-e',
        `process.argv[1] = "/tmp/mismatch/packed-snapshot-stress.mjs"; await import("${realDriverPath}");`,
      ],
      { stdio: 'pipe' },
    );
  } catch (err) {
    threwMismatch = true;
    assert.equal(err.status, 1, 'must exit non-zero');
    assert.match(
      err.stderr.toString(),
      /Refusing silent skip: target \/tmp\/mismatch\/packed-snapshot-stress\.mjs does not resolve to/,
      'must print explicit refusal message to stderr',
    );
  }
  assert.ok(threwMismatch, 'mismatched target must exit non-zero, never skip silently');
});

test('driver writes output report strictly to configured evidence dir and leaves tracked repo files untouched (idb-vector-aiz)', (t) => {
  // Out of scope: arbitrary OS-level filesystem writes outside the checkout/evidence dir
  // (e.g. hardcoded /tmp paths written via unintercepted primitives).
  const tmp = mkdtempSync(join(os.tmpdir(), 'idb-scratch-'));
  const checkoutDir = join(tmp, 'checkout');
  const evidenceDir = join(tmp, 'evidence');

  mkdirSync(checkoutDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  t.after(() => rm(tmp, { recursive: true, force: true }));

  // Copy working tree to scratch checkout: hardlink source code, but copy reports/ independently
  // (cp -a, not -al) so any regression writing to reports/packed-snapshot.md does not mutate the real worktree file (idb-vector-cnc2):
  execFileSync('cp', ['-al', 'index.js', 'utils', 'tests', 'tools', 'package.json', `${checkoutDir}/`]);
  execFileSync('cp', ['-a', 'reports', `${checkoutDir}/`]);

  // Replace cdp.mjs and demo-server.mjs with lightweight test doubles in checkout:
  unlinkSync(join(checkoutDir, 'tests', 'lib', 'cdp.mjs'));
  writeFileSync(join(checkoutDir, 'tests', 'lib', 'cdp.mjs'), `
import fs from 'node:fs';
export async function launch() {
  return {
    goto: async () => {},
    send: async () => '130',
    screenshot: async (p) => { fs.writeFileSync(typeof p === 'string' ? p : p.path, 'PNG'); },
    evaluate: async () => ({
      name: 'seeded uniform 1000x128',
      count: 1000,
      dimensions: 128,
      maxBytes: 1024,
      allocatedBytes: 1024,
      writeMs: 1,
      buildMs: 1,
      diagnostic: {},
      runs: [{ queryId: 42, baselineMs: 1, cachedMs: 1, byteIdentical: true }],
    }),
    close: async () => {},
  };
}
`);

  unlinkSync(join(checkoutDir, 'tools', 'demo-server.mjs'));
  writeFileSync(join(checkoutDir, 'tools', 'demo-server.mjs'), `
export async function serve() {
  return { server: { close: (cb) => cb() }, url: 'http://localhost' };
}
`);

  const worktreeReport = 'reports/packed-snapshot.md';
  const worktreeHashBefore = readFileSync(worktreeReport, 'utf8');

  const trackedFile = join(checkoutDir, 'reports', 'packed-snapshot.md');
  const trackedContentBefore = readFileSync(trackedFile, 'utf8');

  execFileSync(process.execPath, [join(checkoutDir, 'tests', 'packed-snapshot-stress.mjs')], {
    cwd: checkoutDir,
    env: {
      ...process.env,
      GIT_DIR: path.resolve('.git'),
      PACKED_SNAPSHOT_STRESS_DIR: evidenceDir,
      PACKED_SNAPSHOT_STRESS_COUNT: '1000',
    },
    stdio: 'pipe',
  });

  // (a) Tracked report file in checkout and worktree are UNCHANGED:
  assert.equal(readFileSync(worktreeReport, 'utf8'), worktreeHashBefore, 'Real worktree report file must remain untouched');
  assert.equal(readFileSync(trackedFile, 'utf8'), trackedContentBefore, 'Tracked report file must remain untouched');

  // (b) Report exists in routed evidence dir:
  const generatedReport = join(evidenceDir, 'packed-snapshot-stress.json');
  assert.ok(existsSync(generatedReport), 'Report must exist in routed evidence dir');

  // (c) Screenshot exists in routed evidence dir:
  const generatedPng = join(evidenceDir, 'packed-snapshot-stress.png');
  assert.ok(existsSync(generatedPng), 'Screenshot must exist in routed evidence dir');
});
