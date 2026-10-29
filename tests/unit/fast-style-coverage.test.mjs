import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const reporter = resolve('tools/report-fast-style-coverage.sh');
const gate = readFileSync(resolve('tools/fast-gate.sh'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
const tier = (name) => run(process.cwd(), 'bash', ['tools/unit-tier-suites.sh', name]).split('\n');

// The shape rule fails here or it is only prose: one fast suite that spawns a child process, binds a
// socket or clones/stages the repo is enough to make the tier's wall time track host load (55 s to
// 273 s on one commit, idb-vector-t7u). Each entry is [label, pattern, the cost it buys], and every
// pattern is a specific identifier or call shape so prose about servers or clones cannot trip it.
const SHAPE_BREACHES = [
  ['child_process', /\bnode:child_process\b/, 'spawns a child process'],
  ['execSync', /\bexecSync\b/, 'spawns a child process'],
  ['execFileSync', /\bexecFileSync\b/, 'spawns a child process'],
  ['spawn(', /\bspawn(Sync)?\s*\(/, 'spawns a child process'],
  ['.listen(', /\.listen\s*\(/, 'binds a socket'],
  ['createServer', /\bcreateServer\s*\(/, 'binds a socket'],
  ['git clone', /\bgit clone\b|['"]git['"]\s*,\s*\[\s*['"]clone['"]/, 'clones the repo'],
  ['mkdtemp', /\bmkdtemp(Sync)?\s*\(/, 'stages a scratch tree'],
];

// The sweep cannot read itself: it names every construct below by design. It is the tier's
// documented known exception (docs/speed.md) - it spawns `git` in a throwaway repo, measured ~2.5 s.
const SELF = 'tests/unit/fast-style-coverage.test.mjs';

// The one other fast suite that carries a construct, listed per (suite, construct) so the rest of
// that suite stays enforced: adding a socket bind or a child process to it still fails. A new entry
// here is a reviewed diff rather than a quiet widening of the tier.
const SHAPE_EXEMPTIONS = [
  ['tests/unit/wiki-demo-server-confinement.test.mjs', 'mkdtemp', 'a scratch root for the symlink fixture; it spawns nothing and binds nothing'],
];

// Comment text is not executable, so a comment naming a construct ("refused, no .listen() here")
// must not fail the sweep; string literals stay in, because a construct quoted in a string is still
// a construct waiting to be used. Tracking string state also keeps a URL out of the comment path.
function codeOnly(source) {
  const out = [];
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        out.push(ch, source[i + 1] ?? '');
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      out.push(ch);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out.push(ch);
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out.push('\n');
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
      out.push(' ');
      continue;
    }
    out.push(ch);
  }
  return out.join('');
}

// The fast tier is a SHAPE contract, not a file list (docs/speed.md, idb-vector-t7u): it holds only
// unit suites that never spawn a child process, bind a socket or clone/stage the repo, because those
// costs track host load. The suites that do are enumerated once in tools/unit-tier-suites.sh and run
// in the middle tier - per branch before hand-off, and inside `npm test` on the merged tree.
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

test('every fast-tier suite obeys the shape rule: no child process, no socket bind, no repo clone', () => {
  const fast = tier('fast');
  assert.ok(fast.includes(SELF), 'the sweep excludes itself, so it must still be a fast suite');
  const exempt = new Set(SHAPE_EXEMPTIONS.map(([suite, construct]) => `${suite} ${construct}`));
  const breaches = [];
  for (const suite of fast) {
    if (suite === SELF) continue;
    const code = codeOnly(readFileSync(suite, 'utf8'));
    for (const [construct, pattern, cost] of SHAPE_BREACHES) {
      if (pattern.test(code) && !exempt.has(`${suite} ${construct}`)) breaches.push(`${suite}: ${construct} (${cost})`);
    }
  }
  assert.deepEqual(breaches, [], 'the fast tier holds no spawn, socket bind or repo clone/staging; move the suite to `middle` in tools/unit-tier-suites.sh');
  // A stale exemption would quietly widen the tier, so each one must still be paying for itself.
  for (const [suite, construct, why] of SHAPE_EXEMPTIONS) {
    assert.ok(fast.includes(suite), `${suite} is exempt from the shape rule but is not in the fast tier`);
    const [, pattern] = SHAPE_BREACHES.find(([name]) => name === construct);
    assert.match(codeOnly(readFileSync(suite, 'utf8')), pattern, `stale exemption: ${suite} no longer references ${construct} (${why})`);
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
