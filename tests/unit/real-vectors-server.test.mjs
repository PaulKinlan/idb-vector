// tests/unit/real-vectors-server.test.mjs — the real-vectors measurement server reuses the shared
// safe request parse (idb-vector-wqv). Its server cannot run in this tier (it needs the
// .cache/real-vectors dataset), so this pins the WIRING; the 400-on-malformed behaviour itself is
// driven live against both demo servers in tests/unit/demo-server.test.mjs through the same helper.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

const source = readFileSync('tests/real-vectors.mjs', 'utf8');

test('tests/real-vectors.mjs parses the request target through tools/request-pathname.mjs and answers 400', () => {
  assert.match(source, /import \{ requestPathname \} from '\.\.\/tools\/request-pathname\.mjs'/, 'uses the shared helper, not a third copy');
  assert.doesNotMatch(source, /new URL\(req\.url/, 'no unguarded parse of the request target');
  const handler = /createServer\(async \(req, res\) => \{([\s\S]*?)\n\}\)/.exec(source);
  assert.ok(handler, 'the request handler is found');
  assert.match(handler[1], /requestPathname\(req\)/, 'the handler parses through the helper');
  assert.match(handler[1], /=== null\) \{\s*res\.writeHead\(400\)/, 'a malformed target answers 400');
});

test('every in-repo loopback server routes the request target through the shared helper (i9w/tb6/wqv/yom)', () => {
  // The defect class: an unguarded new URL(req.url) crashes or mis-answers on a malformed target.
  // Any new createServer() caller must route through tools/request-pathname.mjs instead.
  const servers = [];
  for (const dir of ['tools', 'tests']) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.mjs')) continue;
      const body = readFileSync(`${dir}/${name}`, 'utf8');
      if (/createServer\(/.test(body)) servers.push([`${dir}/${name}`, body]);
    }
  }
  assert.ok(servers.length >= 4, 'the known loopback servers are all seen');
  for (const [file, body] of servers) {
    assert.match(body, /requestPathname/, `${file} imports the shared helper`);
    assert.doesNotMatch(body, /new URL\(req\.url/, `${file} has no unguarded request-target parse`);
  }
});
