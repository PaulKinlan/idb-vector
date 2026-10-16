// The browser checks reach the demo through tools/wiki-demo-server.mjs, which mirrors the GitHub
// Pages subpath. Its routing is small but load-bearing: /demo/ and /demo/compute/ are real pages on
// Pages, and the lab's own "../" back-link points at the bare /demo/ root. Pure routing, no browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { serve } from '../../tools/wiki-demo-server.mjs';

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
  assert.match(pages, /cp [^\n]*utils\/side-store\.js site\/utils\//);
  // Only the demo, the library entry point and the utils the Pages workflow stages are
  // reachable: a path outside that set must stay 404 rather than hide a missing staging step.
  for (const path of ['/README.md', '/package.json', '/index.html', '/demo/nope.html', '/utils/unlisted.js', '/demo/../package.json']) {
    assert.equal((await served(path)).status, 404, path);
  }
});
