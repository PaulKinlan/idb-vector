// The loopback servers used to answer purely by pathname, so the 127.0.0.1 bind was not a
// browser-origin boundary: a page on any site can aim its own hostname at 127.0.0.1 (DNS rebinding)
// and read the answers as same-origin, and a plain cross-origin request reaches the port anyway. The
// Host header still names the origin the page was served from, so tools/request-host.mjs is the check
// that closes it (idb-vector-2703). This suite is the table over that helper's answers, and the pin
// that every in-repo server routes through it - one helper, or the four servers drift apart again the
// way the refusal status did (idb-vector-zs1u).
//
// Pure, no socket: this is a fast-tier suite. The HTTP shape (a real request carrying a foreign Host is
// refused on the wire) is asserted where a socket already exists, in
// tests/unit/loopback-host-refusal.test.mjs (middle tier).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { hostAllowed } from '../../tools/request-host.mjs';
import { REFUSAL_STATUS } from '../../tools/refusal.mjs';

const port = 49152;
// The connection a request arrived on carries the port the server listened on; an absent socket is a
// request this helper cannot place, so it refuses rather than guesses.
const requestWith = (host, listeningPort = port) => ({ headers: host === undefined ? {} : { host }, socket: { localPort: listeningPort } });

// [Host header, port listened on, allowed?, what the row pins]
const cases = [
  [`127.0.0.1:${port}`, port, true, 'the IPv4 literal every in-repo bind uses'],
  [`localhost:${port}`, port, true, 'the name a reader types, and what a renamed bind would report'],
  [`[::1]:${port}`, port, true, 'IPv6 loopback, for a bind widened later'],
  [`LOCALHOST:${port}`, port, true, 'a DNS name is case-insensitive'],
  ['127.0.0.1', 80, true, 'an absent port addresses 80, and this server is on 80'],
  ['evil.example:49152', port, false, 'the DNS-rebinding shape: a foreign name on our own port'],
  ['evil.example', port, false, 'a foreign name with no port'],
  [`127.0.0.1:${port + 1}`, port, false, 'a loopback name on the wrong port'],
  [`localhost:${port + 1}`, port, false, 'the same for the name form'],
  ['127.0.0.1', port, false, 'a bare loopback name addresses port 80, not this server'],
  [`[::2]:${port}`, port, false, 'a different IPv6 host'],
  [`0.0.0.0:${port}`, port, false, 'the all-interfaces literal is not loopback'],
  [`127.0.0.1:${port}/evil`, port, false, 'a Host value never carries a path'],
  [`user@127.0.0.1:${port}`, port, false, 'nor credentials'],
  ['127.0.0.1:99999', port, false, 'a port that cannot parse'],
  ['[::1:49152', port, false, 'an unbalanced IPv6 bracket'],
  ['', port, false, 'an empty Host'],
  [undefined, port, false, 'a request with no Host at all (HTTP/1.0 shape)'],
];

test('hostAllowed accepts the three loopback forms on the listening port and nothing else', () => {
  for (const [header, listening, allowed, why] of cases) {
    assert.equal(hostAllowed(requestWith(header, listening)), allowed,
      `Host ${JSON.stringify(header)} on port ${listening}: ${why}`);
  }
  // The port comes off the socket, so a request object without one is refused instead of compared
  // against a guess.
  assert.equal(hostAllowed({ headers: { host: `127.0.0.1:${port}` } }), false, 'no socket: no port to match');
});

test('every in-repo loopback server asks tools/request-host.mjs, before it parses the request', () => {
  // The defect class: a new createServer() handler (or an edited one) that serves by pathname alone,
  // which is exactly what all four did. Scanned rather than listed, so a fifth server is covered the
  // day it lands.
  const servers = [];
  for (const dir of ['tools', 'tests']) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.mjs')) continue;
      const body = readFileSync(`${dir}/${name}`, 'utf8');
      if (/createServer\(/.test(body)) servers.push([`${dir}/${name}`, body]);
    }
  }
  assert.equal(servers.length, 4, 'the four known loopback servers are all seen');
  for (const [file, body] of servers) {
    assert.match(body, /import \{ hostAllowed \} from '\.\.?\/?(?:tools\/)?request-host\.mjs'/,
      `${file} imports the shared Host check`);
    // The guard must sit above the request-target parse and above the body, and answer the shared
    // refusal: one status for "I will not serve this" (tools/refusal.mjs, idb-vector-zs1u).
    const guard = /if \(!hostAllowed\(req\)\) \{ refuse\(res/.exec(body);
    assert.ok(guard, `${file} refuses a foreign Host through refuse()`);
    const parse = body.search(/requestPathname\(req\)/);
    assert.ok(parse > -1 && guard.index < parse,
      `${file} checks the Host before it parses the request target`);
  }
  // The status a foreign Host answers with is the shared refusal, not a number of its own.
  assert.equal(REFUSAL_STATUS, 404,
    'a bad Host answers the same 404 as a confined path: a 400 would confirm a live server to the page');
});
