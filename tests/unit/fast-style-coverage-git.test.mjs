import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Middle-tier suite: exercises git-fixture integration tests for tools/report-fast-style-coverage.sh
// and tools/report-changed-middle-suites.sh (split from tests/unit/fast-style-coverage.test.mjs under
// proposal idb-vector-hfra). Because these tests create temporary repositories and invoke git, they
// belong in the middle tier where child processes are permitted.
const reporter = resolve('tools/report-fast-style-coverage.sh');
const suiteReporter = resolve('tools/report-changed-middle-suites.sh');
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
const tier = (name) => run(process.cwd(), 'bash', ['tools/unit-tier-suites.sh', name]).split('\n');

test('a changed middle-tier suite is named with the command that runs it, and a fast one is not', () => {
  // idb-vector-ap0u: the contract maps product paths, so a changed suite that the fast tier never runs
  // used to produce a bare "unmapped changed file" with no next step - twice on real branches (0bd3829,
  // 0612767). The middle list is read from the one tier definition, so this holds for every sheet added
  // there rather than for the two suites that happened to be changed.
  const middle = tier('middle');
  const changedMiddle = middle.find((suite) => suite.endsWith('demo-server-routing.test.mjs'));
  const changedFast = 'tests/unit/geometry.test.mjs';
  assert.ok(changedMiddle, 'the bead\'s own case must stay a middle-tier suite');
  assert.ok(!middle.includes(changedFast), 'the pin needs one suite the fast tier runs');
  const cwd = mkdtempSync(join(tmpdir(), 'idb-changed-suite-'));
  try {
    run(cwd, 'git', ['init', '-q']);
    mkdirSync(join(cwd, 'tests/unit'), { recursive: true });
    for (const suite of [changedMiddle, changedFast]) writeFileSync(join(cwd, suite), 'base\n');
    run(cwd, 'git', ['add', '.']);
    run(cwd, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
    for (const suite of [changedMiddle, changedFast]) writeFileSync(join(cwd, suite), 'changed\n');
    run(cwd, 'git', ['add', '.']);
    run(cwd, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'changed']);
    assert.deepEqual(run(cwd, 'bash', [suiteReporter, 'HEAD^', 'HEAD']).split('\n'), [
      `fast-gate: middle-tier-uncovered: ${changedMiddle} (changed here, and the fast gate never runs the middle tier); run it before hand-off: node --test ${changedMiddle}`,
    ]);
    // A commit that touches no suite says nothing: the report is driven by the diff, not printed always.
    assert.equal(run(cwd, 'bash', [suiteReporter, 'HEAD', 'HEAD']), '');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a CSS-only or HTML-only commit is explicitly unmapped, never a silent pass', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'idb-style-gate-'));
  try {
    run(cwd, 'git', ['init', '-q']);
    for (const name of ['page.css', 'page.html', 'app.js']) writeFileSync(join(cwd, name), 'initial\n');
    run(cwd, 'git', ['add', '.']);
    run(cwd, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base']);
    const base = run(cwd, 'git', ['rev-parse', 'HEAD']);
    for (const [name, marker] of [['page.css', 'fast-gate: unmapped: page.css'], ['page.html', 'fast-gate: unmapped: page.html']]) {
      writeFileSync(join(cwd, name), 'changed\n');
      run(cwd, 'git', ['add', name]);
      run(cwd, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', name]);
      const tip = run(cwd, 'git', ['rev-parse', 'HEAD']);
      assert.equal(run(cwd, 'bash', [reporter, `${tip}^`, tip]), marker);
    }
    writeFileSync(join(cwd, 'app.js'), 'changed\n');
    run(cwd, 'git', ['add', 'app.js']);
    run(cwd, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'js']);
    assert.equal(run(cwd, 'bash', [reporter, 'HEAD^', 'HEAD']), '');
    assert.equal(run(cwd, 'bash', [reporter, base, 'HEAD']).split('\n').length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an unavailable base is reported as unknown, not silently ignored', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'idb-style-no-base-'));
  try {
    run(cwd, 'git', ['init', '-q']);
    assert.match(run(cwd, 'bash', [reporter]), /^fast-gate: unknown: no base branch/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the fast suite source contains no spawn, execFile, or createTempGitRepo, and the guard covers it', () => {
  const fastSource = readFileSync(resolve('tests/unit/fast-style-coverage.test.mjs'), 'utf8');
  assert.doesNotMatch(fastSource, /\bspawn\b/, 'fast suite source must not contain spawn');
  assert.doesNotMatch(fastSource, /\bexecFile\b/, 'fast suite source must not contain execFile');
  assert.doesNotMatch(fastSource, /\bcreateTempGitRepo\b/, 'fast suite source must not contain createTempGitRepo');
  const guardSource = readFileSync(resolve('tests/support/fast-tier-guard.mjs'), 'utf8');
  assert.doesNotMatch(guardSource, /fast-style-coverage\.test\.mjs/, 'fast-tier-guard must not excuse fast-style-coverage');
});

test('bash tools/unit-tier-suites.sh partitions every unit suite', () => {
  const all = readdirSync('tests/unit').filter((name) => name.endsWith('.test.mjs')).map((name) => `tests/unit/${name}`);
  const fast = tier('fast');
  const middle = tier('middle');
  assert.deepEqual([...fast, ...middle].sort(), all.sort(), 'no suite drops out of both tiers');
  assert.deepEqual(fast.filter((suite) => middle.includes(suite)), [], 'a suite is in one tier only');
  assert.ok(middle.includes('tests/unit/fast-style-coverage-git.test.mjs'), 'fast-style-coverage-git is in middle tier');
  assert.ok(fast.includes('tests/unit/fast-style-coverage.test.mjs'), 'fast-style-coverage is in fast tier');
});
