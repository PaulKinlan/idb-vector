// Fast-tier runtime shape guard (idb-vector-kljx, docs/speed.md).
//
// The fast tier admits only suites that never spawn a child process and never bind a socket: those
// costs track host load, so a suite that pays them drags the per-lane tier between ~55 s and ~273 s
// on the same commit (idb-vector-t7u). Four attempts to prove that rule by reading source were each
// evaded by valid JavaScript, and there is no parser on this VM, so it is enforced here instead: the
// entry points below throw in the suite that uses them.
//
// Loaded only by the fast tier - `npm run test:fast` (dispatched by tools/fast-gate.sh) sets
// `NODE_OPTIONS=--import ./tests/support/fast-tier-guard.mjs`. The middle tier and the merged gate
// must NOT load it: their suites spawn processes and bind loopback sockets on purpose.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// What a fast suite may not do. Each name is what the refusal reports.
export const fastTierBlockedConstructs = [
  'child_process.execSync',
  'child_process.execFileSync',
  'child_process.spawn',
  'child_process.spawnSync',
  'child_process.exec',
  'child_process.execFile',
  'child_process.fork',
  'net.createServer',
  'net.Server.prototype.listen',
  'http.createServer',
  'https.createServer',
];

// Suites that may use a blocked construct, keyed by path relative to the repo root. Every entry is a
// hole in the shape rule, so the list is deliberately tiny and each one carries its reason.
export const fastTierOptOuts = [
  {
    suite: 'tests/unit/fast-style-coverage.test.mjs',
    constructs: ['child_process.execFileSync'],
    // Runs git init/add/commit in a throwaway /tmp repo (~2.5 s) to pin the CSS/HTML reporter against
    // a real git history. docs/speed.md records it as the fast tier's one documented exception: a fixed
    // local cost, no network, no browser, and it does not track host load.
    reason: 'pins tools/report-fast-style-coverage.sh against a real git history in a throwaway repo',
  },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// `node --test` launches each suite file in its own child process; that parent runner has to spawn
// them, so it is never patched. Suites run in the children (NODE_TEST_CONTEXT is set there).
const isTestRunnerParent = !process.env.NODE_TEST_CONTEXT && process.execArgv.includes('--test');

if (!isTestRunnerParent) {
  const require = createRequire(import.meta.url);
  const suite = process.argv[1] ? path.relative(repoRoot, process.argv[1]) : '';
  const optedOut = new Set(fastTierOptOuts.find((entry) => entry.suite === suite)?.constructs ?? []);

  // The refusal a fast suite sees: the construct, the suite, and the two ways out - move it to the
  // middle tier, or record an opt-out - so the next reader does not rediscover the rule.
  const stub = (construct) =>
    function fastTierGuardBlocked() {
      throw new Error(
        `fast-tier-guard: ${construct}() is not allowed in the fast tier (suite: ${suite || 'unknown'}).\n` +
          'The fast tier contains only suites that never spawn a child process and never bind a socket: ' +
          'those costs track host load and blow the 120 s per-lane budget (docs/speed.md).\n' +
          'This suite belongs in the MIDDLE tier: add it to the `middle` list in ' +
          'tools/unit-tier-suites.sh (idb-vector-t7u) and run `npm run test:middle` before hand-off.\n' +
          'If it genuinely needs the construct, add an explicit opt-out with a reason in ' +
          'tests/support/fast-tier-guard.mjs.',
      );
    };

  const childProcess = require('node:child_process');
  for (const construct of fastTierBlockedConstructs.filter((name) => name.startsWith('child_process.'))) {
    if (optedOut.has(construct)) continue;
    childProcess[construct.slice('child_process.'.length)] = stub(construct);
  }

  const net = require('node:net');
  if (!optedOut.has('net.createServer')) net.createServer = stub('net.createServer');
  if (!optedOut.has('net.Server.prototype.listen')) {
    net.Server.prototype.listen = stub('net.Server.prototype.listen');
  }

  const http = require('node:http');
  if (!optedOut.has('http.createServer')) http.createServer = stub('http.createServer');

  const https = require('node:https');
  if (!optedOut.has('https.createServer')) https.createServer = stub('https.createServer');

  // `import { execSync } from 'node:child_process'` snapshots the builtin's exports when the ESM
  // facade is created, so replacing the property alone would leave named imports unguarded.
  syncBuiltinESMExports();
}
