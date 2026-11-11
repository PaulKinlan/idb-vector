// `npm publish` runs out of .github/workflows/npm-publish-github-packages.yml against every tracked
// path .gitignore does not match, so before package.json had a "files" allowlist the published
// tarball was 271 files / 51,976,876 bytes unpacked: demo/models 23M, demo/vendor 11M, demo/data
// 4.6M, tests/, tools/ (HTTP servers, corpus downloaders, raw-CDP drivers), reports/, and the
// tracked bead state under .beads/ (sync.remote in config.yaml, interactions.jsonl with actor names
// and issue ids) - idb-vector-72ag. The same property tools/audit-staged-site.mjs guarantees for the
// Pages artifact, on the npm path.
//
// The declaration is not the outcome: "files" only takes effect inside npm's packlist, so these
// cases read the real pack output. `npm pack --dry-run --json --ignore-scripts` is cheap here
// (0.7s once the allowlist is in place, 5.2s for the old 271-file tree) because a dry run neither
// compresses the tarball nor runs lifecycle scripts, so the suite asserts on it rather than on
// package.json alone. That also means the suite would keep passing against a package.json-only
// declaration that npm later ignored - the pack output is what publish sends.
//
// Middle tier: each case spawns npm, so tools/unit-tier-suites.sh lists it under `middle` rather than
// letting it default into the fast tier, whose contract is no child processes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { moduleClosure } from '../../tools/stage-site.mjs';

const repoRoot = resolve('.');
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

// Repository-internal trees no entry point reads at runtime: the demo site and its vendored model,
// runtime and corpus bytes, the test/tool/report trees, the research corpus, and the tracked agent
// and bead state. A published package needs none of them.
const REPO_INTERNAL = ['tests/', 'tools/', 'reports/', 'demo/', 'docs/', 'research/', 'test-harness/', '.beads/', '.agents/', '.claude/', '.codex/'];

// npm includes these in every tarball whatever "files" says, so they are part of the expected set
// even though listing them is redundant.
const ALWAYS_SHIPPED = ['LICENSE', 'README.md', 'package.json'];

const toPosix = (path) => path.split(sep).join('/');

function pack() {
  const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });
  const [report] = JSON.parse(stdout);
  return report;
}

const report = pack();
const packed = report.files.map((file) => file.path).sort();

test('package.json declares a files allowlist', () => {
  assert.ok(
    Array.isArray(pkg.files),
    'package.json needs a "files" array; without one npm packs every tracked path .gitignore does not match',
  );
  assert.ok(pkg.files.length > 0, 'an empty "files" array would publish no library code');
  for (const entry of pkg.files) assert.equal(typeof entry, 'string', `files entry ${JSON.stringify(entry)} is not a string`);
});

test('the packed tarball contains no repository-internal path', () => {
  const leaked = packed.filter((path) => REPO_INTERNAL.some((prefix) => path.startsWith(prefix)));
  assert.deepEqual(leaked, [], `npm pack shipped repository-internal paths: ${leaked.join(', ')}`);
});

test('the packed tarball is the library import closure plus the files npm always ships', () => {
  const closure = moduleClosure('index.js', repoRoot).map((file) => toPosix(relative(repoRoot, file)));
  assert.deepEqual(packed, [...closure, ...ALWAYS_SHIPPED].sort());
});

test('the packed tarball stays far below the demo assets it used to ship', () => {
  assert.ok(
    report.unpackedSize < 1_000_000,
    `unpacked tarball is ${report.unpackedSize} bytes; the library closure is ~140 kB, so this is not the library alone`,
  );
});
