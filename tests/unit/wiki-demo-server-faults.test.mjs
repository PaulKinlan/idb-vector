// The two faults of idb-vector-bc9t, driven through a real socket on the server a human actually runs
// (tools/wiki-demo-server.mjs). Both used to be answered wrongly in opposite directions:
//
//   1. A realpath() fault inside confinedFile() (ELOOP here) was caught and returned as null, so a
//      server-side filesystem failure went out as the shared 404 refusal - "the path does not exist" -
//      which is the masking idb-vector-7g2x removed one layer down for a failed readFile(). It answers
//      500 now, and a genuine refusal (a link out of the root, a name that is not there, a path the
//      allow-list never named) keeps its 404.
//   2. A failure AFTER the response began (res.end() throwing once the headers were out) fell into the
//      same catch, whose writeHead(500) then threw ERR_STREAM_WRITE_AFTER_END. The async handler's
//      rejection is unhandled, so Node killed the process and the client got nothing. The catch drops
//      the connection instead.
//
// The server tree is a scratch directory the test owns, which is why serve() takes a root at all: a
// fault in the confinement layer can only be driven against a tree whose links the test placed. This
// suite binds loopback, so it lives in the middle tier (tools/unit-tier-suites.sh).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
import { serve } from '../../tools/wiki-demo-server.mjs';
import { REFUSAL_STATUS } from '../../tools/refusal.mjs';

// A server root holding one servable page, one self-referential symlink (realpath() fails with ELOOP),
// and one link out of the root (realpath() answers, and the answer is outside - a genuine refusal).
async function faultedRoot(t) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wiki-demo-fault-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'demo'), { recursive: true });
  await writeFile(join(root, 'demo', 'index.html'), '<html><body>served</body></html>');
  await symlink('loop.html', join(root, 'demo', 'loop.html'));
  await writeFile(join(scratch, 'secret.txt'), 'SECRET OUTSIDE THE ROOT');
  await symlink(join(scratch, 'secret.txt'), join(root, 'demo', 'escape.html'));
  return root;
}

test('a realpath fault answers 500; a genuine refusal keeps the shared 404 (idb-vector-bc9t)', async (t) => {
  const root = await faultedRoot(t);
  const { server, url } = await serve(root);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = new URL(url).origin + '/idb-vector';
  const get = async (path) => {
    const response = await fetch(base + path);
    return { status: response.status, body: await response.text() };
  };

  const faulted = await get('/demo/loop.html');
  assert.equal(faulted.status, 500,
    'a realpath() that fails is the filesystem failing to answer, not a decision about the name: 500 (idb-vector-bc9t)');
  assert.notEqual(faulted.status, REFUSAL_STATUS,
    'a server fault must not wear the refusal status, or a broken handler looks like a correct refusal (idb-vector-7iu)');
  assert.equal(faulted.body, 'Could not read demo file', 'the fault answers with this server\'s own body');

  // The refusal half of the split, over the same socket and the same scratch root. A link that
  // realpath()s OUT of the root is a decision, not a fault, and stays the one shared 404.
  assert.equal((await get('/demo/escape.html')).status, REFUSAL_STATUS,
    'a link out of the root is still refused with the shared status (tools/refusal.mjs)');
  assert.equal((await get('/demo/missing.html')).status, REFUSAL_STATUS,
    'a name under the root that does not exist is ENOENT, which is still a refusal, not a fault');
  assert.equal((await get('/README.md')).status, REFUSAL_STATUS,
    'a path the allow-list never names is still refused');

  // The process is alive and still routing: the fault answered one request, it did not take the server.
  assert.equal((await get('/demo/index.html')).status, 200, 'the server keeps serving after a fault');
});

test('a failure after the response began drops the connection instead of crashing the process', async (t) => {
  const root = await faultedRoot(t);
  const { server, url } = await serve(root);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = new URL(url).origin + '/idb-vector';

  // The fault is induced honestly from the response side: the read succeeds and res.end() flushes the
  // response, then throws - the state a torn-down socket leaves the write in, and the state in which
  // the old catch called writeHead(500) and threw ERR_STREAM_WRITE_AFTER_END. A plain client abort does
  // not make res.end() throw on this Node version (it reports the failure asynchronously), so the
  // one-shot wrapper produces the throw the guard branches on rather than a different fault.
  const unhandled = [];
  const recordUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', recordUnhandled);
  const realEnd = ServerResponse.prototype.end;
  let induced = false;
  ServerResponse.prototype.end = function end(...args) {
    const result = realEnd.apply(this, args);
    if (!induced) {
      induced = true;
      throw Object.assign(new Error('simulated post-response failure (idb-vector-bc9t)'), { code: 'EPIPE' });
    }
    return result;
  };
  t.after(() => {
    ServerResponse.prototype.end = realEnd;
    process.off('unhandledRejection', recordUnhandled);
  });

  // The client may see the flushed response or a connection the guard dropped; either is a complete,
  // answered exchange. What it must never see is a 500 written after the body.
  const outcome = await fetch(`${base}/demo/index.html`).then(
    (response) => ({ status: response.status }),
    (error) => ({ error }));
  assert.ok(induced, 'the induced failure must actually reach res.end(), or this test proves nothing');
  assert.ok(outcome.status === 200 || outcome.error !== undefined,
    'the flushed response stands or the guard drops the connection: never a 500 written after the body');
  // An unhandled rejection is observed a microtask after the handler settles.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(unhandled.map((error) => error.code ?? error.message), [],
    'the guard must answer the late failure without throwing out of the handler: an unhandled rejection kills the process (idb-vector-bc9t)');

  // Restored, and the process is still alive and serving: the fault cost one response, not the server.
  ServerResponse.prototype.end = realEnd;
  assert.equal((await fetch(`${base}/demo/index.html`)).status, 200, 'the server survives a post-response failure');
});
