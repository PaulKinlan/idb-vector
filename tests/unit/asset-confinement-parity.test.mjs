// The repository confines file reads in two places: tools/wiki-demo-server.mjs confinedFile() for the
// loopback demo server, and tools/research-asset-allowlist.mjs acceptanceAsset() for the research
// acceptance driver. tools/research-asset-allowlist.mjs:6 says the second mirrors the first, and they
// are supposed to reach the same decision by the same mechanism - normalise, compare lexically, then
// realpath() and require the RESOLVED target to stay inside the resolved root.
//
// They drifted twice because each had its own suite pinning its own answer, so neither gate went red
// for the divergence: confinedFile() kept the dangling-link fallback gb9n removed from the research
// helper (idb-vector-4c06), and acceptanceAsset() waved exact allowlist hits through without realpath()
// while confinedFile() refused the identical shape (idb-vector-jz65). This file therefore asserts ONE
// table of shapes against BOTH helpers. A divergence fails here whichever side moves, and a new shape
// is added once rather than twice.
//
// The two helpers keep their own suites for what is genuinely theirs (the demo server's name regex and
// directory routing, the research driver's allowlist shape and driver contract); this file owns only
// the answers they share.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinedFile } from '../../tools/wiki-demo-server.mjs';
import { acceptanceAsset } from '../../tools/research-asset-allowlist.mjs';

// The same shape asked of both helpers: a root-relative name, with acceptanceAsset's leading-slash path
// form and its allowlist derived from it. The allowlist names one exact file (index.js) and one exact
// entry that is a symlink out of the root (library.js), plus the demo/ and utils/ directory prefixes.
const helpers = [
  ['confinedFile', (name, root) => confinedFile(name, root)],
  ['acceptanceAsset', (name, root) => acceptanceAsset('/' + name, root, {
    assetFiles: new Map([['/index.js', join(root, 'index.js')], ['/library.js', join(root, 'library.js')]]),
    assetDirs: ['/demo/', '/utils/'],
  })],
];

test('confinedFile and acceptanceAsset answer the same table of shapes the same way', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'confinement-parity-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'root');
  const secret = join(scratch, 'secret.txt');
  const outside = join(scratch, 'outside.js');
  await mkdir(join(root, 'demo', 'compute'), { recursive: true });
  await mkdir(join(root, 'utils'), { recursive: true });
  await writeFile(join(root, 'demo', 'index.html'), '<html></html>');
  await writeFile(join(root, 'demo', 'app.js'), 'export {};');
  await writeFile(join(root, 'demo', 'compute', 'index.html'), '<html></html>');
  await writeFile(join(root, 'utils', 'options.js'), 'export {};');
  await writeFile(join(root, 'index.js'), 'export {};');
  await writeFile(secret, 'SECRET OUTSIDE THE ROOT');
  await symlink(join(root, 'demo', 'app.js'), join(root, 'demo', 'alias.js'));
  await symlink(secret, join(root, 'demo', 'escape.js'));
  await symlink(join(root, 'utils', 'options.js'), join(root, 'demo', 'cross.js'));
  await symlink(outside, join(root, 'demo', 'dangling-escape.js'));
  await symlink(join(root, 'demo', 'later.js'), join(root, 'demo', 'dangling-in-root.js'));
  await symlink(secret, join(root, 'library.js'));

  // Rows run in order, and a row may prepare fixture state the next row reads (the dangling link
  // before and after its target exists), which is why this is a sequence rather than a set.
  //
  // `expect` is the answer both helpers must give: a resolved absolute path, or null for a refusal. The
  // one row where they are supposed to differ spells both answers out per helper.
  const shapes = [
    {
      shape: 'a plain file under an allowed directory',
      name: 'demo/app.js',
      expect: join(root, 'demo', 'app.js'),
    },
    {
      shape: 'a plain exact allowlisted file',
      name: 'index.js',
      expect: join(root, 'index.js'),
    },
    {
      shape: 'an intra-directory link (demo/alias.js -> demo/app.js)',
      name: 'demo/alias.js',
      expect: join(root, 'demo', 'app.js'),
    },
    {
      shape: 'a link out of the root (demo/escape.js -> ../secret.txt)',
      name: 'demo/escape.js',
      expect: null,
    },
    {
      shape: 'an exact allowlisted entry that is a link out of the root (library.js -> ../secret.txt)',
      name: 'library.js',
      expect: null,
    },
    {
      // The one genuine difference, kept deliberately. acceptanceAsset() requires the resolved target to
      // stay inside the MATCHED ALLOWED DIRECTORY as well as the root, because its allowlist is made of
      // directory prefixes (nothing in the worktree is named by default). confinedFile() has no
      // allowlist of its own - the caller's name regex is that allowlist - so it confines to the root.
      // Both answers land on an in-root file: neither helper escapes, they just answer for different
      // questions. Every other row must agree.
      shape: 'a link into a different allowed directory (demo/cross.js -> ../utils/options.js)',
      name: 'demo/cross.js',
      expect: { confinedFile: join(root, 'utils', 'options.js'), acceptanceAsset: null },
    },
    {
      shape: 'a dangling link out of the root, target absent (demo/dangling-escape.js -> ../outside.js)',
      name: 'demo/dangling-escape.js',
      expect: null,
    },
    {
      // The same link once its target exists - the state a read that follows the unresolved path lands
      // in (idb-vector-4c06). Refused either way, so creating the target between the check and the read
      // cannot turn the row above into a served file outside the root.
      shape: 'the same dangling link after its outside target exists',
      name: 'demo/dangling-escape.js',
      prepare: () => writeFile(outside, 'SECRET OUTSIDE THE ROOT'),
      expect: null,
    },
    {
      shape: 'a dangling link whose target would be inside the root (demo/dangling-in-root.js -> demo/later.js)',
      name: 'demo/dangling-in-root.js',
      expect: null,
    },
    {
      shape: 'a name under an allowed directory that does not exist at all (demo/missing.html)',
      name: 'demo/missing.html',
      expect: null,
    },
    {
      shape: "a '..' traversal out of an allowed directory (demo/../secret.txt)",
      name: 'demo/../secret.txt',
      expect: null,
    },
    {
      shape: "a nested '..' traversal out of the root (demo/../../secret.txt)",
      name: 'demo/../../secret.txt',
      expect: null,
    },
  ];

  for (const { shape, name, expect, prepare } of shapes) {
    if (prepare) await prepare();
    for (const [helper, confine] of helpers) {
      const want = expect !== null && typeof expect === 'object' ? expect[helper] : expect;
      const got = await confine(name, root);
      assert.equal(got, want, `${helper}: ${shape} must be ${want === null ? 'refused' : `served as ${want}`}`);
    }
  }
});

test('both helpers report a realpath fault as a fault, not a refusal (idb-vector-bc9t)', async (t) => {
  // The classification both helpers must share, added here for the reason this file exists: a helper
  // that answers null for a filesystem failure puts a server fault in "the path does not exist"
  // clothing, and the two helpers must not disagree about which failures are decisions. ELOOP is the
  // reproducible fault (a link that points at itself); ENOENT stays a refusal in both.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'confinement-parity-fault-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'demo'), { recursive: true });
  await symlink('loop.js', join(root, 'demo', 'loop.js'));

  for (const [helper, confine] of helpers) {
    await assert.rejects(() => confine('demo/loop.js', root), { code: 'ELOOP' },
      `${helper}: a realpath() fault is the filesystem failing, not a decision about the name`);
    assert.equal(await confine('demo/missing.js', root), null,
      `${helper}: ENOENT is still the refusal`);
  }
});

test('both helpers refuse to answer for a root that cannot be resolved', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'confinement-parity-root-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const absentRoot = join(scratch, 'absent-root');
  const allowlist = { assetFiles: new Map(), assetDirs: ['/demo/'] };

  for (const [helper, confine] of [
    ['confinedFile', (name, root) => confinedFile(name, root)],
    ['acceptanceAsset', (name, root) => acceptanceAsset('/' + name, root, allowlist)],
  ]) {
    assert.equal(await confine('demo/app.js', absentRoot), null,
      `${helper}: a root that does not resolve is a configuration error, refused rather than compared lexically`);
  }
});
