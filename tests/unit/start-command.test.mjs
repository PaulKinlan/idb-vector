// `npm start` used to be a bare `serve`: it bound 0.0.0.0:3000 and served the whole working
// tree, so package.json, tests/ and the dev-dependency chain were reachable from any host on
// the network — the only unbounded listener in a repo whose other servers all pin 127.0.0.1.
// It now runs the same loopback-only allowlist server as `npm run demo:wikipedia`, and the
// `serve` dependency (the source of the deferred compression advisory) is gone.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { serve } from '../../tools/wiki-demo-server.mjs';

const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));

test('npm start runs the in-repo loopback demo server rather than the unbounded serve CLI', () => {
  assert.equal(pkg.scripts.start, 'node tools/wiki-demo-server.mjs');
  assert.equal(pkg.dependencies?.serve, undefined);
  assert.equal(pkg.devDependencies?.serve, undefined, 'serve would reintroduce an all-interface listener');
});

test('the server npm start runs binds loopback and serves no file outside the demo allowlist', async (t) => {
  const { server, url } = await serve();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { address, family } = server.address();
  assert.equal(address, '127.0.0.1', 'must not listen on an all-interface address');
  assert.equal(family, 'IPv4');

  assert.equal((await fetch(url)).status, 200);
  // The exact paths the old `serve .` exposed: project metadata, tests, and the dependency tree.
  for (const path of ['/package.json', '/package-lock.json', '/tests/browser.mjs', '/README.md', '/node_modules/serve/package.json']) {
    assert.equal((await fetch(new URL(path, url))).status, 404, path);
  }
});
