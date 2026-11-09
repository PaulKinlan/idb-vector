// All loopback servers answer HTTP for the same refusal: tools/wiki-demo-server.mjs (the wiki demo
// server), tools/demo-server.mjs (the measurement harness demo server), tests/real-vectors.mjs (the
// real vectors measurement server), and the allowlist server inside tests/research.mjs (the research
// acceptance driver). Until idb-vector-zs1u they disagreed on the status code, and until idb-vector-sd71
// three of the four servers still wrote the refusal status as a literal 404 outside tools/refusal.mjs,
// leaving the invariant vulnerable to silent divergence whenever a status changes or a server is added.
//
// "I will not serve this path" is 404, for all refusal shapes - a path the allowlist never named,
// a name the allowlist admitted whose target a confinement helper refused, or a request with a foreign
// Host header. A 403 for confinement refusal would hand any process on the host an existence oracle for
// confined paths, and nothing reads the difference (no page, no test, no receipt field).
// tools/refusal.mjs holds the one status all handlers write via refuse().
//
// Pinned WITHOUT a socket, which is why this suite is in the fast tier: refuse() is driven against a
// fake response, server entry points calling createServer() are discovered dynamically from the tree
// and asserted to import and use the helper (unless in an explicitly justified allow-list), and no
// file under tools/ or tests/ may write a literal writeHead() for a refusal.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { REFUSAL_STATUS, refuse } from '../../tools/refusal.mjs';

const repoRoot = new URL('../../', import.meta.url);

// Server entry points legitimately allowed to call createServer() without importing the shared
// refusal helper. Any entry must carry a one-line reason explaining why it never refuses.
const ALLOWED_SERVERS_WITHOUT_REFUSAL = new Map([
  // No server is exempt: every in-repo loopback server must route refusals through tools/refusal.mjs.
]);

// Numeric statuses legitimately needed for non-refusal paths.
// Any numeric writeHead() under tools/ or tests/ must be in this narrow list with an explicit reason.
const ALLOWED_NON_REFUSAL_STATUSES = new Map([
  [400, 'malformed request target error (requestPathname returned null)'],
  [302, 'redirect bare root to test-harness/index.html in demo-server'],
  [500, 'server crash / filesystem read error'],
]);

// The response surface refuse() touches, recording the calls in order.
const fakeResponse = (calls) => ({
  writeHead(code) { calls.push(['writeHead', code]); return this; },
  end(body) { calls.push(['end', body]); return this; },
});

// Discover all server files in tools/*.mjs and tests/*.mjs that call createServer()
function discoverServers() {
  const servers = [];
  for (const dir of ['tools', 'tests']) {
    const dirUrl = new URL(dir, repoRoot);
    for (const name of readdirSync(dirUrl)) {
      if (!name.endsWith('.mjs')) continue;
      const relPath = `${dir}/${name}`;
      const body = readFileSync(new URL(name, dirUrl + '/'), 'utf8');
      if (/\bcreateServer\(/.test(body)) {
        servers.push({ relPath, body });
      }
    }
  }
  return servers;
}

// Walk all .mjs files under tools/ and tests/, excluding unit test suites (*.test.mjs)
function findSourceFiles(dirUrl, relPrefix = '') {
  const files = [];
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.cache' || entry.name === 'fixtures') {
        continue;
      }
      files.push(...findSourceFiles(new URL(entry.name + '/', dirUrl), `${relPrefix}${entry.name}/`));
    } else if (entry.name.endsWith('.mjs')) {
      const relPath = `${relPrefix}${entry.name}`;
      if (relPath.endsWith('.test.mjs')) continue;
      files.push(relPath);
    }
  }
  return files;
}

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

test('every server entry point discovered from the tree routes refusals through the shared helper', () => {
  const servers = discoverServers();
  assert.ok(servers.length >= 4, 'all known loopback servers are discovered');

  for (const { relPath, body } of servers) {
    if (ALLOWED_SERVERS_WITHOUT_REFUSAL.has(relPath)) {
      const reason = ALLOWED_SERVERS_WITHOUT_REFUSAL.get(relPath);
      assert.ok(
        typeof reason === 'string' && reason.trim().length > 0,
        `${relPath} is in allow-list but lacks a one-line justification reason`,
      );
      continue;
    }

    assert.match(
      body,
      /import\s*\{[^}]*\brefuse\b[^}]*\}\s*from\s*['"](?:\.\.?\/)*(?:tools\/)?refusal\.mjs['"]/,
      `${relPath} creates a server but does not import the shared refusal helper (and is not allow-listed)`,
    );

    // Every server must refuse foreign Hosts via refuse()
    assert.match(
      body,
      /if \(!hostAllowed\(req\)\) \{\s*refuse\(res/,
      `${relPath} must refuse foreign Host through refuse()`,
    );
  }

  // Check specific refusal branches in the four known servers:
  const serverMap = new Map(servers.map(s => [s.relPath, s.body]));

  const wikiDemo = serverMap.get('tools/wiki-demo-server.mjs');
  assert.ok(wikiDemo, 'tools/wiki-demo-server.mjs is discovered');
  assert.match(wikiDemo, /target === null\) \{\s*refuse\(res\);/,
    "tools/wiki-demo-server.mjs confinedFile() refusal must answer through refuse()");
  assert.match(wikiDemo, /refuse\(res\);\s*return;\s*\}\s*const target = await confinedFile/,
    "tools/wiki-demo-server.mjs allowlist miss must answer through refuse()");

  const demoServer = serverMap.get('tools/demo-server.mjs');
  assert.ok(demoServer, 'tools/demo-server.mjs is discovered');
  assert.match(demoServer, /!files\.has\(name\)\) \{\s*refuse\(res,\s*'Not found'\);/,
    "tools/demo-server.mjs missing file refusal must answer through refuse()");

  const realVectors = serverMap.get('tests/real-vectors.mjs');
  assert.ok(realVectors, 'tests/real-vectors.mjs is discovered');
  assert.match(realVectors, /!file\) \{\s*refuse\(res\);/,
    "tests/real-vectors.mjs unallowed file refusal must answer through refuse()");

  const research = serverMap.get('tests/research.mjs');
  assert.ok(research, 'tests/research.mjs is discovered');
  assert.match(research, /'not an acceptance asset'\) \{\s*refuse\(res,\s*'Not found'\);/,
    "tests/research.mjs acceptanceAsset() refusal must answer through refuse()");
});

test('no file under tools/ or tests/ contains a literal writeHead for a refusal', () => {
  const toolsFiles = findSourceFiles(new URL('tools/', repoRoot), 'tools/');
  const testsFiles = findSourceFiles(new URL('tests/', repoRoot), 'tests/');
  const allFiles = [...toolsFiles, ...testsFiles];
  assert.ok(allFiles.length >= 20, 'source files under tools/ and tests/ are scanned');

  for (const relPath of allFiles) {
    const content = readFileSync(new URL(relPath, repoRoot), 'utf8');
    for (const match of content.matchAll(/\bwriteHead\s*\(\s*(\d+)/g)) {
      const code = Number(match[1]);
      assert.notEqual(code, 404,
        `${relPath} contains literal writeHead(404) for a refusal: refusal statuses must route through refuse() (tools/refusal.mjs)`);
      assert.notEqual(code, 403,
        `${relPath} contains literal writeHead(403) for a refusal: refusal statuses must route through refuse() (tools/refusal.mjs)`);
      assert.ok(
        ALLOWED_NON_REFUSAL_STATUSES.has(code),
        `${relPath} contains unjustified literal writeHead(${code}): only explicit non-refusal statuses are permitted (${[...ALLOWED_NON_REFUSAL_STATUSES.keys()].join(', ')})`,
      );
    }
  }
});
