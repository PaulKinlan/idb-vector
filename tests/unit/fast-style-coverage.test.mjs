import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// This file pins the unit tier PARTITION and the gate wiring around it - both exact and cheap.
// The fast tier's shape rule (zero child processes, zero sockets, zero repo staging) is enforced
// at runtime by tests/support/fast-tier-guard.mjs (bead idb-vector-kljx), which `npm run test:fast`
// preloads. Git-history coverage fixtures were moved to tests/unit/fast-style-coverage-git.test.mjs
// under proposal idb-vector-hfra, leaving this fast suite with zero opt-outs.
const gate = readFileSync(resolve('tools/fast-gate.sh'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

function readMiddleSuites() {
  const toolSource = readFileSync(resolve('tools/unit-tier-suites.sh'), 'utf8');
  const match = /^middle=\(\n([\s\S]*?)\n\)/m.exec(toolSource);
  if (!match) throw new Error('Could not parse middle array from tools/unit-tier-suites.sh');
  return match[1]
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function tier(name) {
  if (name === 'middle') {
    return readMiddleSuites();
  }
  if (name === 'fast') {
    const middle = readMiddleSuites();
    const all = readdirSync('tests/unit')
      .filter((file) => file.endsWith('.test.mjs'))
      .map((file) => `tests/unit/${file}`)
      .sort();
    return all.filter((suite) => !middle.includes(suite));
  }
  throw new Error(`unknown tier: ${name}`);
}

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
  for (const suite of middle) {
    assert.ok(existsSync(suite), `middle suite exists on disk: ${suite}`);
  }
  for (const name of ['test:fast', 'test:middle']) {
    assert.match(pkg.scripts[name], /--test-concurrency=2\b/, `${name} keeps concurrency at VM capacity`);
    assert.doesNotMatch(pkg.scripts[name], /--test-only\b/, `an only-filter would silently drop tests from ${name}`);
  }
});

test('the merger full gate runs the middle tier, because `npm test` does not glob tests/unit', () => {
  // CHECK_CMD, which lives outside this repo (~/.fleet/idb-vector-check.conf), is
  // `npm test && npm run test:packed && npm run test:wikipedia && npm run gate:research`, and
  // `npm test` runs tests/*.mjs only. Naming the middle tier there is the whole reason coverage is
  // unchanged; the research leg is the one the merger names from the conf, so the repo's half of it
  // has to keep existing as a bounded script (pinned by value in research-driver-contract.test.mjs).
  assert.match(pkg.scripts.test, /npm run test:middle$/, 'npm test must end with the middle tier');
  assert.doesNotMatch(pkg.scripts.test, /test:fast/, 'the merged gate must not re-pay the per-lane tier');
  assert.ok(pkg.scripts['gate:research'], 'the merged gate appends `npm run gate:research`, so the script must stay named');
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

test('the fast gate runs the changed-middle-suite report after the runner and keeps its status', () => {
  const runner = gate.indexOf('\nnpm run test:fast\n');
  const report = gate.indexOf('bash tools/report-changed-middle-suites.sh');
  assert.ok(runner >= 0, 'the dispatch keeps its own line, which is what fast-tier-guard.test.mjs pins');
  assert.ok(report > runner, 'the report is the tail fleet-check records, so it comes after the runner');
  assert.match(gate, /rc=\$\?\nset -e/, "the runner's status is captured rather than exited on");
  assert.ok(gate.trimEnd().endsWith('exit "$rc"'), 'the gate still fails when the runner fails');
});
