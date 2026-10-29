import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { execSync as namedExecSync } from 'node:child_process';
import { createRequire } from 'node:module';
import httpsModule from 'node:https';
import httpModule from 'node:http';
import netModule from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fastTierBlockedBindings, fastTierBlockedConstructs, fastTierOptOuts } from '../support/fast-tier-guard.mjs';

// The fast tier's shape rule (no spawn, no socket bind) is enforced at runtime, not by reading source:
// `npm run test:fast` preloads tests/support/fast-tier-guard.mjs, which replaces the entry points
// below with throwing stubs. This file proves the stubs bite and that the wiring is fast-tier only.
// It must not spawn anything itself - the guard is active in this process, which is the point.
const requireFromSuite = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
const gate = readFileSync(resolve('tools/fast-gate.sh'), 'utf8');
const docs = readFileSync(resolve('docs/speed.md'), 'utf8');
const guard = readFileSync(resolve('tests/support/fast-tier-guard.mjs'), 'utf8');

// The entry points as a suite would reach them: the module objects that the guard rewrites.
const entryPoints = {
  'child_process.execSync': () => childProcess.execSync('true'),
  'child_process.execFileSync': () => childProcess.execFileSync('true', []),
  'child_process.spawn': () => childProcess.spawn('true'),
  'child_process.spawnSync': () => childProcess.spawnSync('true'),
  'child_process.exec': () => childProcess.exec('true'),
  'child_process.execFile': () => childProcess.execFile('true', []),
  'child_process.fork': () => childProcess.fork('unused.mjs'),
  'net.createServer': () => netModule.createServer(),
  'net.Server.prototype.listen': () => new netModule.Server().listen(0),
  'http.createServer': () => httpModule.createServer(),
  'https.createServer': () => httpsModule.createServer(),
};

test('every blocked construct throws in the suite that uses it and names where the suite belongs', () => {
  assert.deepEqual(Object.keys(entryPoints), fastTierBlockedConstructs, 'the guard blocks exactly what is proven here');
  for (const [construct, call] of Object.entries(entryPoints)) {
    assert.throws(call, (error) => {
      assert.match(error.message, new RegExp(`fast-tier-guard: ${construct.replace(/\./g, '\\.')}\\(\\)`), construct);
      assert.match(error.message, /MIDDLE tier/, `${construct}: the refusal names the tier the suite belongs in`);
      assert.match(error.message, /tools\/unit-tier-suites\.sh/, `${construct}: the refusal names the one place the split is defined`);
      assert.match(error.message, /fast-tier-guard\.test\.mjs/, `${construct}: the refusal names the suite that used it`);
      return true;
    });
  }
});

test('the raw bindings behind those constructors are refused too, and other bindings still resolve', () => {
  assert.deepEqual(fastTierBlockedBindings, ['spawn_sync', 'tcp_wrap', 'pipe_wrap']);
  for (const name of fastTierBlockedBindings) {
    assert.throws(() => process.binding(name), (error) => {
      assert.match(error.message, new RegExp(`fast-tier-guard: process\\.binding\\('${name}'\\)`), name);
      assert.match(error.message, /MIDDLE tier/, `${name}: the refusal names the tier the suite belongs in`);
      assert.match(error.message, /tools\/unit-tier-suites\.sh/, `${name}: the refusal names the one place the split is defined`);
      return true;
    });
  }
  // The exact shape a fast suite would use to spawn or bind behind the patched constructors.
  assert.throws(
    () =>
      process.binding('spawn_sync').spawn({
        file: '/bin/true',
        args: ['/bin/true'],
        stdio: [{ type: 'ignore' }, { type: 'ignore' }, { type: 'ignore' }],
        envPairs: [],
      }),
    /fast-tier-guard: process\.binding\('spawn_sync'\)/,
  );
  assert.throws(() => process.binding('tcp_wrap').TCP.bind('127.0.0.1', 0), /fast-tier-guard: process\.binding\('tcp_wrap'\)/);
  // Everything else must pass through: the guard refuses a shortcut, it does not break the runtime.
  assert.equal(typeof process.binding('util'), 'object', 'unblocked bindings must still resolve');
});

test('the guard and the docs state the boundary it enforces and what it does not', () => {
  for (const [name, text] of [
    ['tests/support/fast-tier-guard.mjs', guard],
    ['docs/speed.md', docs],
  ]) {
    assert.match(text, /OUT OF SCOPE BY DESIGN|Out of scope by design/, `${name}: the boundary must be written down`);
    assert.match(text, /not a sandbox/, `${name}: the guard is a guardrail, not a sandbox`);
    for (const escape of [/process\.binding/, /process\.mainModule/, /native addons?/, /second Node process/]) {
      assert.match(text, escape, `${name}: ${escape} is out of scope and must be named`);
    }
    assert.match(text, /idb-vector-bmq/, `${name}: the same boundary is already recorded for idb-vector-bmq`);
  }
});

test('every reviewed way of reaching child_process and net is still refused', async () => {
  // The review walked each of these; the guard must not regress to property access only.
  const message = /fast-tier-guard: child_process\.execSync\(\)/;
  assert.throws(() => childProcess.execSync('true'), message, 'default import');
  assert.throws(() => namedExecSync('true'), message, 'named ESM import');
  const dynamicChildProcess = await import('node:child_process');
  assert.throws(() => dynamicChildProcess.execSync('true'), message, 'await import()');
  assert.throws(() => requireFromSuite('node:child_process').execSync('true'), message, 'createRequire');
  assert.throws(
    () => netModule.Server.prototype.listen.call(new netModule.Server(), 0),
    /fast-tier-guard: net\.Server\.prototype\.listen\(\)/,
    'listen reached through .call on a detached prototype method',
  );
  assert.throws(
    () => httpModule.createServer().listen(0),
    /fast-tier-guard: http\.createServer\(\)/,
    'http.createServer().listen',
  );
});

test('only the fast tier preloads the guard; middle and merged gates keep spawn and listen', () => {
  assert.match(
    pkg.scripts['test:fast'],
    /^NODE_OPTIONS="\$NODE_OPTIONS --import=\.\/tests\/support\/fast-tier-guard\.mjs" node --test\b/,
    'the fast tier command must preload the guard, or a suite that spawns passes',
  );
  for (const name of ['test', 'test:middle']) {
    assert.doesNotMatch(pkg.scripts[name], /fast-tier-guard/, `npm run ${name} must not load the guard: its suites spawn and listen`);
  }
  // The gate must dispatch that one command rather than calling node --test itself, which is what
  // makes the guard impossible to bypass by running the fast script.
  assert.match(gate, /^npm run test:fast$/m, 'tools/fast-gate.sh dispatches the guarded fast tier command');
  assert.doesNotMatch(gate, /node --test/, 'tools/fast-gate.sh must not start node --test on its own');
});

test('the opt-out list is one documented exception, and the doc no longer calls the rule unenforced', () => {
  assert.deepEqual(fastTierOptOuts.map((entry) => entry.suite), ['tests/unit/fast-style-coverage.test.mjs']);
  for (const entry of fastTierOptOuts) {
    assert.ok(entry.reason.length > 0, `${entry.suite} needs a recorded reason`);
    for (const construct of entry.constructs) {
      assert.ok(fastTierBlockedConstructs.includes(construct), `${entry.suite}: ${construct} is not a blocked construct`);
    }
    assert.match(docs, new RegExp(entry.suite.replace(/[.]/g, '\\.')), 'docs/speed.md records the exception');
  }
  // A guard that claims to be planned is how the previous round shipped a false guarantee.
  assert.match(docs, /fast-tier-guard\.mjs/, 'docs/speed.md names the shipped guard');
  assert.match(docs, /idb-vector-kljx/, 'docs/speed.md names the bead that owns it');
  assert.match(guard, /syncBuiltinESMExports/, 'named ESM imports must be re-synced, or `import { execSync }` slips past');
});
