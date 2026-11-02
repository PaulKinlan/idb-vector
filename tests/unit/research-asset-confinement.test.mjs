// The research acceptance driver's loopback server admitted a request path by resolving it LEXICALLY -
// `resolve(root, '.' + path)` plus a string prefix compare - so a symlink planted under demo/ or utils/
// was read from wherever it pointed: /etc/passwd, .git/config, node_modules, anything, answered 200
// while the driver's header and receipt still claimed "everything else in the worktree stays
// unreachable" (idb-vector-gb9n). tests/research.mjs binds a socket and launches Chromium at module top
// level, so no unit suite can import it; the allowlist decision therefore lives in
// tools/research-asset-allowlist.mjs, and these tests hold that helper.
//
// The pattern is the one tools/wiki-demo-server.mjs settled on for the same class (idb-vector-r5wg,
// tests/unit/wiki-demo-server-confinement.test.mjs): refuse lexically out-of-root candidates first,
// then realpath() both the candidate and the allowed directory and require the RESOLVED target to stay
// inside. Deliberate difference from that helper, inherited from this bead's prescribed fix: the target
// must stay inside the RESOLVED ALLOWED DIRECTORY, not merely inside the worktree, because here the
// allowlist is made of directory prefixes and nothing else in the worktree is named.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acceptanceAsset } from '../../tools/research-asset-allowlist.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
// The driver's allowlist shape, spelled against this checkout. tests/unit/research-driver-contract.test.mjs
// pins the driver's own literals; this file pins the decision made with that shape.
const assetFiles = new Map([
  ['/research/index.html', resolve(repoRoot, 'research/index.html')],
  ['/research/architecture.md', resolve(repoRoot, 'research/architecture.md')],
  ['/index.js', resolve(repoRoot, 'index.js')],
]);
const assetDirs = ['/demo/', '/utils/'];
const allowlist = { assetFiles, assetDirs };

test('the assets the driver requires are served, and nothing else in this checkout is', async () => {
  for (const path of ['/research/index.html', '/research/architecture.md', '/index.js']) {
    assert.equal(await acceptanceAsset(path, repoRoot, allowlist), resolve(repoRoot, path.slice(1)), `exact allowlisted file: ${path}`);
  }
  for (const path of ['/demo/style.css', '/demo/app.js', '/demo/encoder.js', '/utils/options.js', '/utils/side-store.js']) {
    assert.equal(await acceptanceAsset(path, repoRoot, allowlist), await realpath(join(repoRoot, path)), `file under an allowed directory: ${path}`);
  }
  for (const path of ['/package.json', '/README.md', '/tests/research.mjs', '/tools/research-asset-allowlist.mjs', '/research', '/demo']) {
    assert.equal(await acceptanceAsset(path, repoRoot, allowlist), null, `path outside the allowlist: ${path}`);
  }
});

test('a symlink under an allowed directory that points outside the root is refused', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'research-asset-root-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'demo'), { recursive: true });
  await mkdir(join(root, 'utils'), { recursive: true });
  await writeFile(join(root, 'demo', 'app.js'), 'export {};');
  await writeFile(join(root, 'utils', 'options.js'), 'export {};');
  const secret = join(scratch, 'secret.txt');
  await writeFile(secret, 'secret');

  // The regression case. The request path `/demo/escape.js` is lexically inside an allowed directory
  // and the file it names exists, so a lexical check serves it; only realpath() shows that the read
  // would land outside the worktree.
  await symlink(secret, join(root, 'demo', 'escape.js'));
  assert.equal(await acceptanceAsset('/demo/escape.js', root, allowlist), null,
    'a symlink under an allowed directory that points outside the root must be refused (idb-vector-gb9n)');

  // A link that climbs out and back in on the other side of the allowlist boundary is refused for the
  // same reason the intra-directory link below is allowed: the target is not in the named directory.
  await symlink(join(root, 'utils', 'options.js'), join(root, 'demo', 'cross.js'));
  assert.equal(await acceptanceAsset('/demo/cross.js', root, allowlist), null, 'a link into a different allowed directory is refused');

  // A whole allowed directory that is itself a link out of the worktree must not carry its resolved
  // contents with it, which is the root check the driver asserts separately.
  const loose = join(scratch, 'loose');
  await mkdir(loose, { recursive: true });
  await writeFile(join(loose, 'app.js'), 'export {};');
  const widenedRoot = join(scratch, 'widened-root');
  await mkdir(join(widenedRoot, 'utils'), { recursive: true });
  await writeFile(join(widenedRoot, 'utils', 'options.js'), 'export {};');
  await symlink(loose, join(widenedRoot, 'demo'));
  assert.equal(await acceptanceAsset('/demo/app.js', widenedRoot, allowlist), null,
    'an allowed directory that is itself a symlink out of the root must not carry its contents in');

  // A link inside an allowed directory that points at another file in that SAME directory is admitted,
  // matching tools/wiki-demo-server.mjs, whose confinedFile() admits in-root links and whose test
  // asserts the resolved path is returned: the read still lands on a file the allowlist would serve.
  await symlink(join(root, 'demo', 'app.js'), join(root, 'demo', 'alias.js'));
  assert.equal(await acceptanceAsset('/demo/alias.js', root, allowlist), await realpath(join(root, 'demo', 'app.js')));

  // A `..` that climbs out of an allowed directory is still refused, by the lexical layer that stayed
  // in place as defence in depth: the resolved candidate is no longer under demo/ before any
  // realpath() runs.
  assert.equal(await acceptanceAsset('/demo/../secret.txt', root, allowlist), null, "traversal out of an allowed directory with '..' must be refused");
  assert.equal(await acceptanceAsset('/demo/../../secret.txt', root, allowlist), null, "nested '..' out of the root must be refused");

  // A file inside an allowed directory that does not exist is still returned as a path, so the server
  // reports it through readFile exactly as it did before this change instead of as a refusal.
  assert.equal(await acceptanceAsset('/demo/missing.js', root, allowlist), join(root, 'demo', 'missing.js'));
});
