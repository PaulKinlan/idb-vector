// tools/demo-server.mjs serves the measurement harness to the browser checks. A malformed
// request target (e.g. absolute-form with a broken authority) used to make `new URL(req.url, ...)`
// throw before any try block, and Node treated the unhandled rejection as fatal — one bad request
// aborted a whole measurement run. Now it must answer 400 and keep serving.
import assert from 'node:assert/strict';
import test from 'node:test';
import { connect } from 'node:net';
import { serve } from '../../tools/demo-server.mjs';

const rawGet = (port, target) => new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1', () => {
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });
  let buffer = '';
  socket.on('data', (chunk) => { buffer += chunk; });
  socket.on('end', () => resolve(Number(buffer.split(' ')[1])));
  socket.on('error', reject);
});

test('the demo server answers a malformed request target with 400 and stays alive', async (t) => {
  const { server, url } = await serve();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  // Absolute-form targets with a broken authority make `new URL` throw.
  for (const target of ['http://[::1/x', 'http://h:99999/', 'http://']) {
    assert.equal(await rawGet(port, target), 400, `expected 400 for ${target}`);
  }

  // The server survived every bad request: valid routing still works afterwards.
  const good = await fetch(url);
  assert.equal(good.status, 200);
  assert.match(await good.text(), /<html/i);

  const missing = await fetch(new URL('/nope.js', url));
  assert.equal(missing.status, 404);
});
