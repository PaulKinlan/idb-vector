import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// This file pins the unit tier PARTITION and the gate wiring around it - both exact and cheap. The fast
// tier's shape rule (no spawn, no socket, no clone/stage) is enforced at runtime by
// tests/support/fast-tier-guard.mjs (bead idb-vector-kljx), which `npm run test:fast` preloads; this
// file is its one documented opt-out, because the coverage-reporter check below runs `git` in a
// throwaway repo. Four rounds of static source analysis on idb-vector-t7u were each evaded by valid
// JavaScript (a string holding "comment//here" hid a call from a lexer; a same-line `import` and a
// computed `import(expr)` slipped past a module allowlist), and there is no parser to depend on here,
// so no static shape check lives in this file.
const reporter = resolve('tools/report-fast-style-coverage.sh');
const gate = readFileSync(resolve('tools/fast-gate.sh'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
const tier = (name) => run(process.cwd(), 'bash', ['tools/unit-tier-suites.sh', name]).split('\n');

// The fast tier is the per-lane contract (docs/speed.md, idb-vector-t7u). What makes the split safe
// is not a shape check but this partition: every unit suite is in exactly one tier, and the split has
// one definition in tools/unit-tier-suites.sh, so a suite cannot fall out of both.
test('the two unit tiers partition every unit suite, with a worker bound the 2-VCPU VM can host', () => {
  // idb-vector-fmm / ADR idb-vector-518: unbounded node --test put ~24 child processes on 2 vCPUs.
  const all = readdirSync('tests/unit').filter((name) => name.endsWith('.test.mjs')).map((name) => `tests/unit/${name}`);
  const fast = tier('fast');
  const middle = tier('middle');
  assert.deepEqual([...fast, ...middle].sort(), all.sort(), 'no suite drops out of both tiers');
  assert.deepEqual(fast.filter((suite) => middle.includes(suite)), [], 'a suite is in one tier only');
  assert.ok(middle.every((suite) => !suite.includes('*')), 'the middle tier is enumerated, never a glob');
  for (const name of ['test:fast', 'test:middle']) {
    assert.match(pkg.scripts[name], /--test-concurrency=2\b/, `${name} keeps concurrency at VM capacity`);
    assert.doesNotMatch(pkg.scripts[name], /--test-only\b/, `an only-filter would silently drop tests from ${name}`);
  }
});

test('the merger full gate runs the middle tier, because `npm test` does not glob tests/unit', () => {
  // CHECK_CMD is `npm test && npm run test:packed && npm run test:wikipedia`, and `npm test` runs
  // tests/*.mjs only. Naming the middle tier there is the whole reason coverage is unchanged.
  assert.match(pkg.scripts.test, /npm run test:middle$/, 'npm test must end with the middle tier');
  assert.doesNotMatch(pkg.scripts.test, /test:fast/, 'the merged gate must not re-pay the per-lane tier');
});

test('the fast gate names the middle suites it did not run', () => {
  assert.match(gate, /unit-tier-suites\.sh fast/, 'the dispatched list comes from the one tier definition');
  assert.match(gate, /not run here[^\n]*test:middle/, 'an excluded suite is announced, never a silent gap');
});

test('the fast gate invokes the CSS/HTML reporter before unit suites', () => {
  // A comment mentioning the command is not wiring: require an executable line.
  const invocation = /^bash tools\/report-fast-style-coverage\.sh$/m.exec(gate);
  assert.ok(invocation, 'fast gate must actually invoke the CSS/HTML reporter');
  assert.ok(invocation.index < gate.indexOf('npm run test:fast'));
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
