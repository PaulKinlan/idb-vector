// The published Pages site must contain every module demo/app.js imports, and only those. The
// workflow used to list the utils/ files one at a time, so a new utils/ module was missing from the
// site while every local test stayed green (idb-vector-crk1). These tests stage the real repo once
// through the CLI, then drive the two properties the derivation exists for: a new module is picked
// up, and a module nothing imports is not published.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { DEMO_ENTRY, moduleClosure, stageSite } from '../../tools/stage-site.mjs';

const repoRoot = resolve('.');
const tempDir = () => mkdtempSync(join(tmpdir(), 'site-stage-'));
const filesUnder = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));

test('the published site carries every module the demo imports, and the workflow asks for it', () => {
  const out = tempDir();
  try {
    const stdout = execFileSync(process.execPath, [join(repoRoot, 'tools/stage-site.mjs'), out], { encoding: 'utf8' });
    const modules = moduleClosure(DEMO_ENTRY, repoRoot).map(file => relative(repoRoot, file).split(sep).join('/'));
    const outsideDemo = modules.filter(file => !file.startsWith('demo/')).sort();
    assert.deepEqual(filesUnder(out).filter(file => !file.startsWith('demo/')), outsideDemo,
      'the modules outside demo/ that land on the site are exactly the imported ones');
    assert.match(stdout, new RegExp(`staged demo/ plus ${outsideDemo.length} imported modules: ${outsideDemo.join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    for (const file of modules) assert.ok(existsSync(join(out, file)), `${file} is on the site`);
    // index.html's stylesheet and corpus manifest are fetched, not imported, so they ship with the
    // recursive copy of demo/ rather than through the import graph.
    for (const file of ['demo/index.html', 'demo/app.js', 'demo/style.css', 'demo/assets.json']) {
      assert.ok(existsSync(join(out, file)), `${file} is on the site`);
    }
    // Nothing may be left behind: resolve the graph again inside the staged copy, where a module the
    // workflow forgot is a real missing file.
    assert.doesNotThrow(() => moduleClosure(DEMO_ENTRY, out));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the workflow stages with the script instead of listing utils/ files by hand', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/pages.yml'), 'utf8');
  assert.match(workflow, /node tools\/stage-site\.mjs site/, 'the Pages step runs the staging script');
  assert.doesNotMatch(workflow, /cp utils\/\S+\.js/, 'no hand-maintained utils/ copy list can drift again');
});

test('a new module under utils/ reaches the site through the module that imports it', () => {
  const fixture = tempDir(), out = tempDir();
  try {
    const write = (path, body) => {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), body);
    };
    write('demo/app.js', "import { VectorDB } from '../index.js';\nimport { local } from './helper.js';\n");
    write('demo/helper.js', 'export const local = 1;\n');
    write('utils/used.js', "import { nested } from './nested.js';\nexport const used = nested;\n");
    write('utils/nested.js', 'export const nested = 1;\n');
    write('utils/unused.js', 'export const unused = 1;\n');
    // A bare specifier is the browser's problem, not the stager's: the module itself still ships and
    // resolution simply does not follow a name the site could not resolve either.
    write('utils/bare.js', "import x from 'some-package';\nexport const bare = x;\n");
    write('index.js', "import { used } from './utils/used.js';\nimport { bare } from './utils/bare.js';\nexport { used, bare };\nexport class VectorDB {}\n");
    assert.deepEqual(stageSite(out, { root: fixture }), ['index.js', 'utils/bare.js', 'utils/nested.js', 'utils/used.js']);
    assert.ok(existsSync(join(out, 'demo/helper.js')), 'demo/ still ships whole');
    assert.equal(existsSync(join(out, 'utils/unused.js')), false, 'a module nothing imports is not published');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
