// tools/wiki-demo-server.mjs confined reads with a name regex alone (idb-vector-r5wg). The regex is a
// guard on an unnormalised string, while the read target is whatever `new URL(file, root)` resolves
// to — `/idb-vector//demo/app.js` strips to the absolute `/demo/app.js` and resolves against the
// filesystem root, refused today only because the pattern rejects a leading slash. These tests hold
// the layer underneath: resolve the name against the server root, refuse anything that does not land
// inside it, and refuse again after realpath() in case a symlink inside the tree points outwards.
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

  // Files inside keep serving, including from a nested directory, and a name that merely does not
  // exist stays a 404 for readFile rather than being reported as a confinement failure.
  assert.equal(await confinedFile('demo/index.html', root), await realpath(join(root, 'demo', 'index.html')));
  assert.equal(await confinedFile('demo/compute/index.html', root), join(root, 'demo', 'compute', 'index.html'));
  assert.equal(await confinedFile('demo/missing.html', root), join(root, 'demo', 'missing.html'));
});
