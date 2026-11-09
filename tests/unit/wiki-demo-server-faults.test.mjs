// The two faults of idb-vector-bc9t, driven through a real socket on the server a human actually runs
// (tools/wiki-demo-server.mjs). Both used to be answered wrongly in opposite directions:
//
//   1. A realpath() fault inside confinedFile() was caught and returned as null, so a server-side
//      filesystem failure went out as the shared 404 refusal - "the path does not exist" - which is the
//      masking idb-vector-7g2x removed one layer down for a failed readFile(). It answers 500 now, and a
//      genuine refusal (a link out of the root, a name that is not there, a path the allow-list never
//      named) keeps its 404. idb-vector-xi96: the classification is a SET - ENOENT and ENOTDIR refuse,
//      every other realpath() error is a fault - so the pin below is that set rather than the one member
//      the tree could produce: while this test drove ELOOP alone, "treat EACCES as a refusal" was a
//      mutation the suite answered 500 for the wrong row and stayed GREEN.
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
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerResponse } from 'node:http';
import { serve } from '../../tools/wiki-demo-server.mjs';
import { REFUSAL_STATUS } from '../../tools/refusal.mjs';
import { simulateRealpathFaults } from '../support/realpath-faults.mjs';

// A server root holding one servable page, one self-referential symlink (realpath() fails with ELOOP),
// one page behind a directory with no traverse bit (realpath() fails with EACCES), one page the
// realpath() stub fails for (EIO), and one link out of the root (realpath() answers, and the answer is
// outside - a genuine refusal).
async function faultedRoot(t) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wiki-demo-fault-')));
  const root = join(scratch, 'root');
  await mkdir(join(root, 'demo', 'locked'), { recursive: true });
  await writeFile(join(root, 'demo', 'index.html'), '<html><body>served</body></html>');
  await writeFile(join(root, 'demo', 'locked', 'index.html'), '<html><body>locked</body></html>');
  await writeFile(join(root, 'demo', 'io-fault.html'), '<html><body>io</body></html>');
  await symlink('loop.html', join(root, 'demo', 'loop.html'));
  await writeFile(join(scratch, 'secret.txt'), 'SECRET OUTSIDE THE ROOT');
  await symlink(join(scratch, 'secret.txt'), join(root, 'demo', 'escape.html'));
  // demo/locked holds a real page and denies traversal, which is the one way a tree in /tmp makes
  // realpath() answer EACCES. The mode is restored before the tree is removed, in this one hook rather
  // than a second one, because rm cannot recurse into a directory it may not traverse.
  await chmod(join(root, 'demo', 'locked'), 0o000);
  t.after(async () => {
    await chmod(join(root, 'demo', 'locked'), 0o755);
    await rm(scratch, { recursive: true, force: true });
  });
  return root;
}

// The classification one row at a time (idb-vector-xi96). ENOENT and ENOTDIR are decisions about the
// name and keep the shared refusal; every other realpath() error is the filesystem failing to answer
// and must reach the fault answer. `induced` says how the errno was produced, because only three of
// these five rows come out of the filesystem itself: EIO has no tree shape (no permission bit makes
// readlink() fail with it), so it is thrown by a stub over the syscall (tests/support/realpath-faults.mjs)
// while every other row is a real realpath() on a real tree - including a real EACCES, which is what
// shows the stub's error shape is the one the kernel produces.
const classification = [
  { errno: 'EACCES', path: '/demo/locked/index.html', induced: 'a directory with no traverse bit', status: 500 },
  { errno: 'EIO', path: '/demo/io-fault.html', induced: 'realpath() stubbed to throw EIO for this one path', status: 500 },
  { errno: 'ELOOP', path: '/demo/loop.html', induced: 'a symlink that points at itself', status: 500 },
  { errno: 'ENOENT', path: '/demo/missing.html', induced: 'a name that was never created', status: REFUSAL_STATUS },
  { errno: 'ENOTDIR', path: '/demo/index.html/nested.html', induced: 'a path whose component is a file', status: REFUSAL_STATUS },
];

test('a realpath fault answers 500; a genuine refusal keeps the shared 404 (idb-vector-bc9t)', async (t) => {
  const root = await faultedRoot(t);
  // EIO is the one errno no tree in /tmp can produce, so it is stubbed over the syscall; every other
  // row below is a real realpath() on the real tree.
  const stub = simulateRealpathFaults([[join(root, 'demo', 'io-fault.html'), 'EIO']]);
  t.after(() => stub.restore());
  // EACCES is induced by a permission bit, so it only exists for a process the bit can deny: running the
  // suite as root would make the row below pass for the wrong reason (a resolvable path), so say so here.
  await assert.rejects(() => realpath(join(root, 'demo', 'locked', 'index.html')), { code: 'EACCES' },
    'the EACCES row needs a process the traverse bit can deny; as root the tree cannot induce it');
  const { server, url } = await serve(root);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = new URL(url).origin + '/idb-vector';
  const get = async (path) => {
    const response = await fetch(base + path);
    return { status: response.status, body: await response.text() };
  };

  for (const { errno, path, induced, status } of classification) {
    await t.test(`${errno} (${induced})`, async () => {
      const answer = await get(path);
      if (status === REFUSAL_STATUS) {
        assert.equal(answer.status, REFUSAL_STATUS,
          `${errno} is "no such name under the root", so it stays the shared refusal: 404 (idb-vector-xi96)`);
        return;
      }
      assert.equal(answer.status, 500,
        `${errno} is the filesystem failing to answer, not a decision about the name: 500, not the refusal (idb-vector-xi96)`);
      assert.notEqual(answer.status, REFUSAL_STATUS,
        'a server fault must not wear the refusal status, or a broken handler looks like a correct refusal (idb-vector-7iu)');
      assert.equal(answer.body, 'Could not read demo file', `the ${errno} fault answers with this server's own body`);
    });
  }

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
