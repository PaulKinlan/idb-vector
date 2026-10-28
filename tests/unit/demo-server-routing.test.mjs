// The browser checks reach the demo through tools/wiki-demo-server.mjs, which mirrors the GitHub
// Pages subpath. Its routing is small but load-bearing: /demo/ and /demo/compute/ are real pages on
// Pages, and the lab's own "../" back-link points at the bare /demo/ root. Pure routing, no browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { serve } from '../../tools/wiki-demo-server.mjs';
import { realVectorAssets } from '../../tools/real-vector-assets.mjs';
import { moduleClosure } from '../../tools/stage-site.mjs';

test('the harness serves directory URLs as GitHub Pages does, and nothing outside the staged set', async (t) => {
  const { server, url } = await serve();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = new URL(url).origin + '/idb-vector';
  const served = async (path) => {
    const response = await fetch(base + path);
    return { status: response.status, type: response.headers.get('content-type'), body: await response.text() };
  };
  const index = await served('/demo/index.html');
  const nested = await served('/demo/compute/index.html');
  assert.equal(index.status, 200);
  assert.ok(index.body.length > 1000);
  for (const [path, expected] of [['/demo/', index], ['/demo/index.html', index], ['/demo/compute/', nested], ['/demo/compute/index.html', nested]]) {
    const found = await served(path);
    assert.equal(found.status, 200, `${path} must serve its index.html`);
    assert.equal(found.type, 'text/html', path);
    assert.equal(found.body, expected.body, `${path} must serve the same bytes as its index.html`);
  }
  assert.equal((await served('/utils/geometry.js')).type, 'text/javascript');
  assert.equal((await served('/index.js')).status, 200);
  // index.js imports this eagerly. Check both the local mirror and the Pages staging
  // list so a missing production module cannot pass the browser demo gate.
  const sideStore = await served('/utils/side-store.js');
  assert.equal(sideStore.status, 200);
  assert.equal(sideStore.type, 'text/javascript');
  assert.match(sideStore.body, /export function buildCodeRecord/);
  const pages = await readFile(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');
  const realAssets = realVectorAssets('/example/repo');
  // Every allow-list that can serve too little must see each eagerly imported local module of
  // index.js: the two in-repo browser servers, and the Pages staging step (which is what actually
  // serves the published demo, so a module missing there 404s the live site, not a test).
  const entry = await readFile(new URL('../../index.js', import.meta.url), 'utf8');
  const repoRoot = resolve(new URL('../../', import.meta.url).pathname);
  const stagedModules = new Set(moduleClosure('demo/app.js', repoRoot).map(f => relative(repoRoot, f).split(sep).join('/')));
  assert.match(pages, /node tools\/stage-site\.mjs site/, 'Pages must stage with stage-site.mjs');
  for (const [, module] of entry.matchAll(/(?:from\s+|import\s*)["'](\.\/utils\/[^"']+)["']/g)) {
    assert.ok(realAssets.has(module.slice(1)), `real-vectors server must serve ${module}`);
    assert.equal((await served(module.slice(1))).status, 200, `wiki demo must serve ${module}`);
    assert.ok(stagedModules.has(module.slice(2)), `Pages must stage ${module}`);
  }
  // Only the demo, the library entry point and the utils the Pages workflow stages are
  // reachable: a path outside that set must stay 404 rather than hide a missing staging step.
  for (const path of ['/README.md', '/package.json', '/index.html', '/demo/nope.html', '/utils/unlisted.js', '/demo/../package.json']) {
    assert.equal((await served(path)).status, 404, path);
  }
});
