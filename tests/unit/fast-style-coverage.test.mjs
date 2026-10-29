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

// A fast suite's cost is decided by what it can REACH, so the rule is an allowlist of module
// specifiers, not a scan for prohibited calls. Rounds 1-2 of idb-vector-t7u tried the scan and a
// hand-rolled comment/string lexer lost both times: round 1 blanked everything after `//` inside a
// string (`const s = "comment//here"`), round 2 kept the string but still blanks a regex literal
// that holds a slash pair, so `assert.match(x, /[//]/); execSync('true')` loses the call entirely.
// Any mis-parse of a scanned file can HIDE a call. Read the other way round, a mis-parse of an
// allowlisted import can only invent a specifier that looks like one - a visible false positive,
// fixed in one line.
const ALLOWED_SPECIFIERS = [
  // Node internals whose cost does not track host load: assertions, the runner, paths/URLs, and
  // file reads. `node:fs` belongs here because the tier already reads its fixtures synchronously;
  // a scratch tree is still caught by COSTLY_CALL_SHAPES below.
  'node:assert',
  'node:assert/strict',
  'node:test',
  'node:path',
  'node:url',
  'node:os',
  'node:crypto',
  'node:fs',
  'node:fs/promises',
];

// Named, not merely absent from the allowlist, so the failure says what cost the module buys.
const FORBIDDEN_SPECIFIERS = {
  'node:child_process': 'spawns a child process',
  'node:net': 'binds a socket',
  'node:http': 'binds a socket',
  'node:https': 'binds a socket',
  'node:worker_threads': "runs work outside the tier's own budget",
};

// The sweep cannot read itself: it names every construct below by design. It is the tier's
// documented known exception (docs/speed.md) - it spawns `git` in a throwaway repo, measured ~2.5 s.
const SELF = 'tests/unit/fast-style-coverage.test.mjs';

// Deliberately narrow parsing: top-level `import`/`export ... from`, side-effect `import 'x'`, and
// dynamic `import('x')`. Nothing is comment- or string-stripped here on purpose (see above); the two
// static shapes are anchored at line start, so a `from '...'` inside a longer statement (an assert
// message quoting an import) is not a specifier.
const SPECIFIER_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*['"]([^'"\n]+)['"]/gm,
  /^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm,
  /\bimport[ \t]*\([ \t]*['"]([^'"\n]+)['"]/g,
];

// `import(expr)` names no specifier, so it cannot be allow-listed: it fails rather than passing
// unexamined. That is the one place this parser refuses to guess.
const OPAQUE_IMPORT = /\bimport[ \t]*\((?![ \t]*['"])/g;

function moduleSpecifiers(source) {
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

// Blunt and impossible to fool by lexing: these substrings may appear NOWHERE in a fast suite,
// comments included. That trades a rare false positive - prose naming one of these builtins has to
// be written differently, or the suite moved to `middle` - for a guarantee: no string or regex can
// hide a child-process or socket module the way a slash pair inside a regex hid a call.
const FORBIDDEN_TEXT = ['node:child_process', 'node:net', 'node:http'];

// BEST-EFFORT, and only for what the allowlist cannot decide: a socket bind is reachable through an
// allowed repo module, and a scratch tree through the allowlisted `node:fs`. These run on
// comment-stripped code so prose cannot trip them - which also means a lexer bug can hide a call.
// The ALLOWLIST above is the guarantee; this list is not, and must not be read as if it were.
const COSTLY_CALL_SHAPES = [
  ['.listen(', /\.listen\s*\(/, 'binds a socket'],
  ['createServer', /\bcreateServer\s*\(/, 'binds a socket'],
  ['mkdtemp', /\bmkdtemp(Sync)?\s*\(/, 'stages a scratch tree'],
];

// The one other fast suite that carries a call shape, listed per (suite, construct) so the rest of
// that suite stays enforced: adding a socket bind to it still fails. A new entry here is a reviewed
// diff rather than a quiet widening of the tier. This suite's own imports (node:assert/strict,
// node:test, node:fs/promises, node:os, node:path, ../../tools/wiki-demo-server.mjs) are all
// allow-listed - `mkdtemp` is legal to IMPORT; the exemption is for calling it.
const SHAPE_EXEMPTIONS = [
  ['tests/unit/wiki-demo-server-confinement.test.mjs', 'mkdtemp', 'a scratch root for the symlink fixture; it spawns nothing and binds nothing'],
];

// Comment text is not executable, so a comment naming a call shape ("refused, no .listen() here")
// must not trip the best-effort check; string literals stay in. This is the lexer that failed in
// round 2, kept only where its cost is bounded and stated.
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

test('every fast-tier suite imports only allow-listed modules', () => {
  const fast = tier('fast');
  assert.ok(fast.includes(SELF), 'the sweep excludes itself, so it must still be a fast suite');
  const breaches = [];
  for (const suite of fast) {
    if (suite === SELF) continue;
    const source = readFileSync(suite, 'utf8');
    for (const specifier of moduleSpecifiers(source)) {
      const cost = FORBIDDEN_SPECIFIERS[specifier];
      if (cost) breaches.push(`${suite}: ${specifier} (${cost})`);
      else if (ALLOWED_SPECIFIERS.includes(specifier) || /^\.\.?\//.test(specifier)) continue;
      else breaches.push(`${suite}: ${specifier} (not on the fast tier's module allowlist)`);
    }
    if ([...source.matchAll(OPAQUE_IMPORT)].length) breaches.push(`${suite}: import(...) with a non-literal specifier (it can name any module, so it cannot be allow-listed)`);
  }
  assert.deepEqual(breaches, [], "the fast tier imports only node internals whose cost does not track host load, plus repo-relative modules; allow a new module in ALLOWED_SPECIFIERS in a reviewed diff, or move the suite to `middle` in tools/unit-tier-suites.sh");
});

test('no fast-tier suite names a child-process or socket builtin anywhere, comments included', () => {
  const fast = tier('fast');
  const hits = [];
  for (const suite of fast) {
    if (suite === SELF) continue;
    const source = readFileSync(suite, 'utf8');
    for (const text of FORBIDDEN_TEXT) {
      if (source.includes(text)) hits.push(`${suite}: mentions ${text}`);
    }
  }
  // Prose counts: a note saying "use node:child_process here" is a reviewed diff to write another
  // way, not a comment the sweep is allowed to reason about and dismiss.
  assert.deepEqual(hits, [], 'a fast suite may not mention node:child_process, node:net or node:http, even in a comment: rephrase it, or move the suite to `middle` in tools/unit-tier-suites.sh');
});

test('every fast-tier suite stays clear of socket binds and scratch trees (best effort)', () => {
  const fast = tier('fast');
  const exempt = new Set(SHAPE_EXEMPTIONS.map(([suite, construct]) => `${suite} ${construct}`));
  const breaches = [];
  for (const suite of fast) {
    if (suite === SELF) continue;
    const code = codeOnly(readFileSync(suite, 'utf8'));
    for (const [construct, pattern, cost] of COSTLY_CALL_SHAPES) {
      if (pattern.test(code) && !exempt.has(`${suite} ${construct}`)) breaches.push(`${suite}: ${construct} (${cost})`);
    }
  }
  assert.deepEqual(breaches, [], 'the fast tier holds no socket bind or scratch-tree staging; move the suite to `middle` in tools/unit-tier-suites.sh');
  // A stale exemption would quietly widen the tier, so each one must still be paying for itself.
  for (const [suite, construct, why] of SHAPE_EXEMPTIONS) {
    assert.ok(fast.includes(suite), `${suite} is exempt from the call-shape check but is not in the fast tier`);
    const [, pattern] = COSTLY_CALL_SHAPES.find(([name]) => name === construct);
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
