// Two loopback servers answer HTTP for the same refusal: tools/wiki-demo-server.mjs (the demo server)
// and the allowlist server inside tests/research.mjs (the research acceptance driver). Until
// idb-vector-zs1u they disagreed - 403 for a confinedFile() refusal in the demo server, 404 for the
// identical acceptanceAsset() refusal in the driver - and no test asserted either status, because the
// only suite that reached the demo server over HTTP pinned directory routing and the only suite that
// reached the driver over HTTP needed a browser.
//
// The mapping both servers now answer, and what this file pins: "I will not serve this path" is 404,
// for both shapes - a path the allowlist never named, and a name the allowlist admitted whose target a
// confinement helper refused. A 403 for the second shape would hand any process on the host an
// existence oracle for confined paths, and nothing reads the difference (no page, no test, no receipt
// field). tools/refusal.mjs holds the one status both handlers write.
//
// Pinned WITHOUT a socket, which is why this suite is in the fast tier: refuse() is driven against a
// fake response, and both callers are checked in source. The HTTP-level shapes live where a socket is
// already bound - tests/unit/demo-server-routing.test.mjs (middle tier) asserts the demo server's two
// shapes, and the driver asserts its own two in the run that binds it (tests/research.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { REFUSAL_STATUS, refuse } from '../../tools/refusal.mjs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The response surface refuse() touches, recording the calls in order.
const fakeResponse = (calls) => ({
  writeHead(code) { calls.push(['writeHead', code]); return this; },
  end(body) { calls.push(['end', body]); return this; },
});

test('the shared refusal status is 404, and refuse() answers it with either body', () => {
  assert.equal(REFUSAL_STATUS, 404,
    'a refusal is 404 in both loopback servers: 403 would tell a caller that a confined path exists (idb-vector-zs1u)');

  const withBody = [];
  refuse(fakeResponse(withBody), 'Not found');
  assert.deepEqual(withBody, [['writeHead', 404], ['end', 'Not found']],
    'the research driver sends a body with its refusal, and it must not change the status');

  const bare = [];
  refuse(fakeResponse(bare));
  assert.deepEqual(bare, [['writeHead', 404], ['end', '']],
    'the demo server sends no body, and must answer the same status');
});

test('both loopback servers route their refusal through the one shared writer', () => {
  // A status written twice is a status that can diverge again: each server must reach this module at
  // the branch its confinement helper's null answer lands in, not write its own number.
  const demo = read('../../tools/wiki-demo-server.mjs');
  const driver = read('../../tests/research.mjs');
  assert.match(demo, /import \{ refuse \} from '\.\/refusal\.mjs'/,
    'tools/wiki-demo-server.mjs must import the shared refusal writer');
  assert.match(driver, /import \{ refuse \} from '\.\.\/tools\/refusal\.mjs'/,
    'tests/research.mjs must import the shared refusal writer');
  assert.match(demo, /target === null\) \{ refuse\(res/,
    "the demo server's confinedFile() refusal must answer through refuse()");
  assert.match(driver, /'not an acceptance asset'\) \{ refuse\(res, 'Not found'\)/,
    "the research driver's acceptanceAsset() refusal must answer through refuse()");

  // Neither server may answer 403 anywhere: that was the divergence, and the research driver's 500 for
  // a read that fails AFTER admission is a different event, so it stays.
  for (const [file, source] of [['tools/wiki-demo-server.mjs', demo], ['tests/research.mjs', driver]]) {
    assert.doesNotMatch(source, /writeHead\(403/,
      `${file} must answer the shared refusal status, not 403 (idb-vector-zs1u)`);
  }
});
