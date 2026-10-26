// tests/unit/real-vectors-server.test.mjs — the real-vectors measurement server reuses the shared
// safe request parse (idb-vector-wqv). Its server cannot run in this tier (it needs the
// .cache/real-vectors dataset), so this pins the WIRING; the 400-on-malformed behaviour itself is
// driven live against both demo servers in tests/unit/demo-server.test.mjs through the same helper.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync('tests/real-vectors.mjs', 'utf8');

test('tests/real-vectors.mjs parses the request target through tools/request-pathname.mjs and answers 400', () => {
  assert.match(source, /import \{ requestPathname \} from '\.\.\/tools\/request-pathname\.mjs'/, 'uses the shared helper, not a third copy');
  assert.doesNotMatch(source, /new URL\(req\.url/, 'no unguarded parse of the request target');
  const handler = /createServer\(async \(req, res\) => \{([\s\S]*?)\n\}\)/.exec(source);
  assert.ok(handler, 'the request handler is found');
  assert.match(handler[1], /requestPathname\(req\)/, 'the handler parses through the helper');
  assert.match(handler[1], /=== null\) \{\s*res\.writeHead\(400\)/, 'a malformed target answers 400');
});
