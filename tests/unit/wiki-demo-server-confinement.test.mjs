// tools/wiki-demo-server.mjs confined reads with a name regex alone (idb-vector-r5wg). The regex is a
// guard on an unnormalised string, while the read target is whatever `new URL(file, root)` resolves
// to — `/idb-vector//demo/app.js` strips to the absolute `/demo/app.js` and resolves against the
// filesystem root, refused today only because the pattern rejects a leading slash. These tests hold
// the layer underneath: resolve the name against the server root, refuse anything that does not land
// inside it, and refuse again after realpath() in case a symlink inside the tree points outwards —
// including a symlink that realpath() cannot resolve at all, which is the shape this helper used to
// return unresolved (idb-vector-4c06).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinedFile } from '../../tools/wiki-demo-server.mjs';

test('confinement check refuses directory escapes, absolute paths, empty/whitespace names, and traversal', async () => {
  assert.equal(await confinedFile(''), null, 'empty string must be refused');
  assert.equal(await confinedFile('   '), null, 'whitespace string must be refused');
  assert.equal(await confinedFile('demo/index.html '), null, 'trailing space must be refused');
  assert.equal(await confinedFile(' demo/index.html'), null, 'leading space must be refused');
  assert.equal(await confinedFile('/demo/index.html'), null, 'leading slash / absolute must be refused');
  assert.equal(await confinedFile('../package.json'), null, 'parent traversal must be refused');
  assert.equal(await confinedFile('demo/../../package.json'), null, 'nested traversal out of root must be refused');
  assert.equal(await confinedFile('/etc/hostname'), null, 'absolute filesystem path must be refused');
  assert.equal(await confinedFile('//index.js'), null, 'doubled leading slash must be refused');
  assert.equal(await confinedFile('.'), null, 'dot directory must be refused');
  assert.equal(await confinedFile('./'), null, 'dot-slash directory must be refused');

  // Legitimate paths inside root resolve
  const index = await confinedFile('index.js');
  assert.ok(index !== null && index.endsWith('index.js'));
  const demoIndex = await confinedFile('demo/index.html');
  assert.ok(demoIndex !== null && demoIndex.endsWith('demo/index.html'));
});

test('confinement refuses a symlink that points outside the server root', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wiki-demo-root-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'demo', 'compute'), { recursive: true });
  await writeFile(join(root, 'demo', 'index.html'), '<html></html>');
  await writeFile(join(root, 'demo', 'compute', 'index.html'), '<html></html>');
  const secret = join(scratch, 'secret.txt');
  await writeFile(secret, 'secret');

  // A link inside the tree is lexically inside it: only realpath() reveals that reading it would
  // read a file the allow-list never named.
  await symlink(secret, join(root, 'demo', 'escape.html'));

  assert.equal(await confinedFile('demo/escape.html', root), null, 'a symlink out of the root must be refused');
  assert.equal(await confinedFile('../secret.txt', root), null);
  assert.equal(await confinedFile('demo/../../secret.txt', root), null);
  assert.equal(await confinedFile(secret, root), null, 'an absolute path outside the root must be refused');
  assert.equal(await confinedFile('', root), null, 'empty name must be refused');
  assert.equal(await confinedFile('demo/index.html ', root), null, 'trailing space must be refused');

  // Sibling directory with root prefix (/tmp/.../root-extra)
  const sibling = join(scratch, 'root-extra');
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, 'leak.txt'), 'leak');
  assert.equal(await confinedFile('../root-extra/leak.txt', root), null, 'sibling directory traversal must be refused');

  // Link inside pointing inside root
  await symlink(join(root, 'demo', 'index.html'), join(root, 'demo', 'link-inside.html'));
  assert.equal(await confinedFile('demo/link-inside.html', root), await realpath(join(root, 'demo', 'index.html')));

  // The regression case for idb-vector-4c06, and the shape tools/research-asset-allowlist.mjs already
  // refused: a DANGLING link out of the root. realpath() fails because the target does not exist yet,
  // and the `.catch(() => candidate)` fallback this helper had returned the unresolved in-root path,
  // which readFile then followed - a 404 while the target was absent, and a file outside the root as
  // soon as anything created it, one await before the read. Unresolvable is refused.
  const outside = join(scratch, 'outside.html');
  await symlink(outside, join(root, 'demo', 'dangling-escape.html'));
  assert.equal(await confinedFile('demo/dangling-escape.html', root), null,
    'a dangling symlink out of the root must be refused, not returned unresolved (idb-vector-4c06)');
  // The same link once its target exists: still refused, now by the root check, so creating the target
  // between the check and the read cannot turn the dangling case into an escape either.
  await writeFile(outside, 'outside');
  assert.equal(await confinedFile('demo/dangling-escape.html', root), null,
    'the link stays refused after its outside target appears');
  await rm(outside, { force: true });

  // A dangling link whose target would be inside the root is refused too: the rule is "unresolvable is
  // refused", not "outside is refused", so the answer does not depend on where the target would be.
  await symlink(join(root, 'demo', 'later.html'), join(root, 'demo', 'dangling-in-root.html'));
  assert.equal(await confinedFile('demo/dangling-in-root.html', root), null,
    'a dangling symlink whose target is inside the root is refused as well');

  // Files inside keep serving, including from a nested directory.
  assert.equal(await confinedFile('demo/index.html', root), await realpath(join(root, 'demo', 'index.html')));
  assert.equal(await confinedFile('demo/compute/index.html', root), join(root, 'demo', 'compute', 'index.html'));

  // A name that does not exist at all is unresolvable too, so it is refused rather than handed to
  // readFile: returning it unresolved is the same TOCTOU hole a dangling link opens (the name can be
  // turned into a link to the outside between the check and the read), and the research helper refuses
  // the same shape (tests/unit/asset-confinement-parity.test.mjs). The caller answers the shared refusal
  // status (tools/refusal.mjs) rather than readFile's answer, which is what keeps a refusal one status in
  // both loopback servers (tests/unit/refusal-status-parity.test.mjs, idb-vector-zs1u).
  assert.equal(await confinedFile('demo/missing.html', root), null,
    'a name under the root that does not exist is refused, not returned unresolved (idb-vector-4c06)');

  // A root that cannot be resolved is a configuration error: refused, not compared lexically.
  assert.equal(await confinedFile('demo/index.html', join(scratch, 'absent-root')), null,
    'a server root that does not resolve must be refused');
});
