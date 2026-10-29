// tests/research.mjs is the research publication acceptance driver. It binds a loopback
// allowlist server and drives real Chromium over CDP at module top level, so NO unit suite can
// import it: importing it launches a browser and a socket. Since idb-vector-lk98 the merged gate
// runs it as its own timed leg - `npm run gate:research`, appended to the merger's CHECK_CMD - and
// `npm run test:research` remains the unbounded manual form. (idb-vector-isyy wrote this file before
// any gate ran the driver; what is still true is that no unit suite here exercises the browser
// behaviour, only the static contract below.)
//
// What is pinned here is the part of the driver that can be checked without a browser, and only
// where a wrong answer is silent today: the driver's own run is the only place that notices its
// 200-allowlist no longer matches the worktree, or that its receipt moved away from the path the
// README documents. Each test below turns one of those driver-run-only failures into a fast-tier one.
//
// Bead idb-vector-isyy: this file is the declared cover for tests/research.mjs in
// tests/coverage-contract.json. Before that entry, the shared coverage extractor placed the driver
// by matching `research` inside `import ... from '../lib/research-link-policy.mjs'` in a sibling
// suite, so a change to the driver was reported as covered by a test that never touches it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, repoRoot), 'utf8');
const driver = read('tests/research.mjs');
const pkg = JSON.parse(read('package.json'));

// Relative import specifiers, including a literal dynamic import: those are what the browser
// resolves as it loads the demo, so they must already be inside the driver's served set.
const relativeSpecifier = /\bfrom\s*['"](\.[^'"]*)['"]|\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)|\bimport\s+['"](\.[^'"]*)['"]/g;
const specifiersIn = (source) => [...source.matchAll(relativeSpecifier)].flatMap((m) => [m[1] ?? m[2] ?? m[3]]);

// The driver's served set, read from the driver rather than restated here, so a test cannot pass
// while the allowlist and the assertions disagree.
const driverSection = (pattern, what) => {
  const match = pattern.exec(driver);
  assert.ok(match, `tests/research.mjs no longer has ${what}; update this pin`);
  return match[1];
};
const quotedUrlPaths = (source) => [...source.matchAll(/['"](\/[^'"]*)['"]/g)].map((m) => m[1]);
const servedFiles = quotedUrlPaths(driverSection(/const assetFiles = new Map\(\[([\s\S]*?)\]\)/, 'an assetFiles map'));
const servedDirs = quotedUrlPaths(driverSection(/const assetDirs = \[([^\]]*)\]/, 'an assetDirs list'));
const probedPaths = quotedUrlPaths(driverSection(
  /Exercise the actual loopback server[\s\S]*?for \(const path of \[([\s\S]*?)\]\)/,
  'the allowed-asset probe loop',
));

// The driver serves a directory request as its index.html, and every other path as itself.
const fileFor = (urlPath) => (urlPath.endsWith('/') ? `${urlPath.slice(1)}index.html` : urlPath.slice(1));
const isServed = (repoPath) => servedFiles.includes(`/${repoPath}`)
  || servedDirs.some((dir) => `/${repoPath}`.startsWith(dir));

test('both research commands name the driver, and the gated one carries its own bound', () => {
  // The README tells a publisher to verify the report with this command and nothing else, so the
  // script has to keep naming the driver: renaming the file without it leaves the documented
  // acceptance run pointing at nothing.
  assert.equal(pkg.scripts['test:research'], 'node tests/research.mjs');
  assert.ok(existsSync(new URL('tests/research.mjs', repoRoot)));
  // idb-vector-lk98: the merged gate reaches the driver through `gate:research`, and the merger's
  // CHECK_CMD names that script from outside this repo (~/.fleet/idb-vector-check.conf). A leg that
  // quietly stops naming the driver - renamed, pointed elsewhere, or folded into `test` - is the
  // state that bead fixed, so both the command and the 300s bound are pinned by value: changing
  // either is a reviewed edit with a fresh measurement (docs/speed.md), not a silent loosening.
  assert.equal(pkg.scripts['gate:research'], 'timeout --kill-after=15s 300s node tests/research.mjs');
});

test('every path the driver requires to answer 200 exists in this checkout', () => {
  // A deny path that does not exist proves nothing, and the driver already asserts that at run
  // time; an ALLOWED path that does not exist makes the acceptance run fail at the browser stage,
  // which only a browser run reaches - the gated leg at merge time or the manual command on the
  // branch. Catch it in the fast tier instead.
  assert.ok(probedPaths.length > 0, 'the allowed-asset probe loop must name at least one path');
  for (const urlPath of probedPaths) {
    assert.ok(existsSync(new URL(fileFor(urlPath), repoRoot)), `allowed acceptance asset is missing from the worktree: ${urlPath}`);
  }
  for (const served of servedFiles) {
    assert.ok(existsSync(new URL(fileFor(served), repoRoot)), `served file is missing from the worktree: ${served}`);
  }
});

test('the demo page the driver loads is served entirely by its own allowlist', () => {
  // idb-vector-zyd: `/demo/` answering 200 while the modules it imports 404 is a page with no
  // script, and the driver's `demoBooted` check is the only thing that notices. Its allowlist
  // serves exact files plus the /demo/ and /utils/ directory prefixes, so the demo's module
  // closure must stay inside them - a module fetched from, say, /tools/ would 404 for the page
  // while every unit test passed.
  const entries = [...read('demo/index.html').matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)]
    .map((m) => posix.normalize(posix.join('demo', m[1])));
  assert.ok(entries.length > 0, 'the demo index must load a module entry point');

  const closure = new Set();
  const pending = [...entries];
  while (pending.length) {
    const repoPath = pending.pop();
    if (closure.has(repoPath)) continue;
    closure.add(repoPath);
    assert.ok(existsSync(new URL(repoPath, repoRoot)), `the demo imports a module that does not exist: ${repoPath}`);
    assert.ok(isServed(repoPath), `the demo imports a module the driver's allowlist refuses (idb-vector-zyd): ${repoPath}`);
    for (const specifier of specifiersIn(read(repoPath))) {
      const resolved = posix.normalize(posix.join(posix.dirname(repoPath), specifier));
      assert.ok(!resolved.startsWith('..'), `the demo imports outside the worktree root: ${specifier} (from ${repoPath})`);
      pending.push(resolved);
    }
  }
  // The page's own module closure, named: the entry point, the library it opens IndexedDB with,
  // and the demo's lazily imported encoder all have to be reachable at /demo/ and /index.js.
  for (const repoPath of ['demo/app.js', 'demo/encoder.js', 'utils/options.js', 'index.js']) {
    assert.ok(closure.has(repoPath), `the demo module closure must reach ${repoPath}`);
  }
  assert.ok(servedDirs.includes('/demo/') && servedDirs.includes('/utils/'), 'the demo and its library modules stay allowed');
  assert.ok(servedFiles.includes('/index.js'), 'the library entry point stays allowed as one exact file');
});

test('the receipt lands in the evidence directory the README documents, with the keys the report cites', () => {
  // README.md is where a publisher is told the screenshots and receipt go; reports/research-publication.md
  // cites the receipt's externalLinks and externalLinkFailures. Both are claims about a file the
  // driver's run writes, so neither breaks anything the unit tier would otherwise see.
  assert.match(driver, /process\.env\.RESEARCH_EVIDENCE \|\| resolve\(root, '\.cache\/research-evidence'\)/);
  assert.match(driver, /writeFile\(resolve\(evidence, 'browser\.json'\)/);
  assert.match(read('README.md'), /\.cache\/research-evidence\//, 'the README must name the receipt directory');

  const receipt = JSON.parse(read('reports/research-publication.json'));
  // `url` and `browser` are recorded in the receipt literal; the rest are assigned onto it later.
  const assigned = ['checks', 'externalLinks', 'externalLinkFailures', 'ok'];
  for (const key of ['url', 'browser', ...assigned]) {
    assert.ok(key in receipt, `the committed receipt must keep the ${key} field the report cites`);
  }
  assert.match(driver, /const receipt = \{ url,\s*browser:/, 'the receipt must still record the url and browser it was produced against');
  for (const key of assigned) {
    assert.match(driver, new RegExp(`receipt\\.${key}\\b`), `the driver must still write the ${key} field the committed receipt records`);
  }
});
