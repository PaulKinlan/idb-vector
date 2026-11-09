// A failure that is not a refusal - a realpath() fault inside a confinement helper, a readFile() that
// fails, a res.end() that throws after the headers are out - answers 500 before the response has begun,
// and must NOT try to write a status once it has: writeHead() there throws ERR_STREAM_WRITE_AFTER_END
// inside the handler's catch, the async handler's rejection is unhandled, and the process dies with
// nothing sent to the client (idb-vector-bc9t). tools/server-fault.mjs is the one writer for both
// branches, so the four in-repo loopback servers cannot drift from it the way they drifted on the
// refusal status before idb-vector-sd71.
//
// No socket here, which is why this suite is in the fast tier: the writer is driven against fake
// responses and the four servers' wiring is asserted from their own source. The two branches are also
// driven through a real socket in tests/unit/wiki-demo-server-faults.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { answerFault } from '../../tools/server-fault.mjs';
import { REFUSAL_STATUS } from '../../tools/refusal.mjs';

const repoRoot = new URL('../../', import.meta.url);

// The response surface answerFault() touches, recording the calls in order.
const fakeResponse = ({ headersSent = false, writableEnded = false } = {}) => {
  const calls = [];
  return {
    headersSent,
    writableEnded,
    calls,
    writeHead(code) { calls.push(['writeHead', code]); return this; },
    end(body) { calls.push(['end', body]); return this; },
    destroy() { calls.push(['destroy']); },
  };
};

test('a failure before the response begins is answered 500, never the refusal status', () => {
  assert.notEqual(REFUSAL_STATUS, 500,
    'the refusal status and the fault status are different answers (idb-vector-7iu)');
  // Each server keeps its own body; the status is the shared answer.
  for (const body of ['Could not read demo file', 'Dataset unavailable', 'Acceptance server error']) {
    const res = fakeResponse();
    answerFault(res, body);
    assert.deepEqual(res.calls, [['writeHead', 500], ['end', body]],
      'a server fault answers 500 and the server\'s own body, and does not touch the socket');
  }
});

test('a failure after the response began drops the connection instead of writing a late status', () => {
  // Two shapes of "already answered": headers out and the response still open (a client that aborted
  // mid-response), and headers out with the response ended (the res.end() that flushed and then threw).
  // A writeHead() in either shape throws ERR_STREAM_WRITE_AFTER_END, so neither may reach one.
  for (const state of [{ headersSent: true }, { headersSent: true, writableEnded: true }, { writableEnded: true }]) {
    const res = fakeResponse(state);
    answerFault(res, 'Could not read demo file');
    assert.deepEqual(res.calls, [['destroy']],
      `${JSON.stringify(state)} must destroy the socket, not write a status after the response began`);
  }
});

test('every in-repo loopback server answers a post-admission failure through answerFault()', () => {
  const servers = [];
  for (const dir of ['tools', 'tests']) {
    const dirUrl = new URL(dir, repoRoot);
    for (const name of readdirSync(dirUrl)) {
      if (!name.endsWith('.mjs')) continue;
      const body = readFileSync(new URL(name, dirUrl + '/'), 'utf8');
      if (/\bcreateServer\(/.test(body)) servers.push([`${dir}/${name}`, body]);
    }
  }
  assert.ok(servers.length >= 4, 'the known loopback servers are all seen');
  for (const [relPath, body] of servers) {
    assert.match(body,
      /import\s*\{[^}]*\banswerFault\b[^}]*\}\s*from\s*['"](?:\.\.?\/)*(?:tools\/)?server-fault\.mjs['"]/,
      `${relPath} must answer its post-admission failure through tools/server-fault.mjs`);
    assert.doesNotMatch(body, /writeHead\s*\(\s*500/,
      `${relPath} writes its own 500: the guard that keeps a late writeHead() from killing the process lives in tools/server-fault.mjs (idb-vector-bc9t)`);
  }
});
