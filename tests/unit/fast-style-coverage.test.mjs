import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const reporter = resolve('tools/report-fast-style-coverage.sh');
const gate = readFileSync(resolve('tools/fast-gate.sh'), 'utf8');
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();

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
