// The wire shape of the Host check (idb-vector-2703): a real request that carries a foreign authority
// must be refused by the server itself, and a request carrying the authority the page was served from
// must still be served. The answer table over tools/request-host.mjs lives in the fast tier
// (tests/unit/request-host.test.mjs); what only a socket can show is that the check is wired ahead of
// every other branch in a handler that is really listening, so a rebound page (Host: evil.example on
// our own port) gets nothing back.
//
// Two of the four servers can be started here: tools/demo-server.mjs and tools/wiki-demo-server.mjs
// both print their URL and need no dataset or browser. tests/real-vectors.mjs needs .cache corpora and
// Chromium, tests/research.mjs launches a browser - their wiring is pinned from source by
// tests/unit/request-host.test.mjs instead. This suite spawns processes and binds sockets, which is why
// it is in the middle tier (tools/unit-tier-suites.sh).
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { REFUSAL_STATUS } from '../../tools/refusal.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

// Start a server as its own process group so it can be killed with the equivalent of the shell's
// `trap 'kill 0' EXIT`: a child that leaks here would hold an ephemeral port for the rest of the gate.
const start = (entry) => new Promise((resolveStart, rejectStart) => {
  const child = spawn(process.execPath, [resolve(repoRoot, entry)], { cwd: repoRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => rejectStart(new Error(`${entry} printed no URL in 20s: ${out}`)), 20_000);
  const settle = (error) => { clearTimeout(timer); if (error) rejectStart(error); };
  child.stdout.on('data', (chunk) => {
    out += chunk;
    const url = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
    if (url && child.exitCode === null) { clearTimeout(timer); resolveStart({ child, port: Number(url[1]) }); }
  });
  child.stderr.on('data', (chunk) => { out += chunk; });
  child.on('exit', (code) => settle(new Error(`${entry} exited ${code} before it served: ${out}`)));
  child.on('error', settle);
});

const stop = (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
};

// One request on a fresh socket, answering the status code. `host` is written verbatim, so a test can
// send an authority no browser of ours would send.
const statusFor = (port, target, host) => new Promise((resolveStatus, rejectStatus) => {
  const socket = connect(port, '127.0.0.1', () => {
    const hostHeader = host === undefined ? '' : `Host: ${host}\r\n`;
    socket.write(`GET ${target} HTTP/1.1\r\n${hostHeader}Connection: close\r\n\r\n`);
  });
  let buffer = '';
  socket.on('data', (chunk) => { buffer += chunk; });
  socket.on('end', () => resolveStatus(Number(buffer.split(' ')[1])));
  socket.on('error', rejectStatus);
});

const servers = [
  ['tools/demo-server.mjs', '/test-harness/index.html'],
  ['tools/wiki-demo-server.mjs', '/idb-vector/demo/index.html'],
];

for (const [entry, target] of servers) {
  test(`${entry} refuses a foreign Host on its own port and serves the loopback ones`, { timeout: 120_000 }, async (t) => {
    const { child, port } = await start(entry);
    t.after(() => stop(child));

    // The DNS-rebinding shape, spelled out: the foreign name arrives WITH our port, so only the
    // hostname distinguishes it from a request this server should have answered.
    assert.equal(await statusFor(port, target, `evil.example:${port}`), REFUSAL_STATUS,
      'a rebound page must get the shared refusal, not the asset');
    assert.equal(await statusFor(port, target, 'evil.example'), REFUSAL_STATUS,
      'a foreign authority with no port is refused too');
    assert.equal(await statusFor(port, target, `127.0.0.1:${port + 1}`), REFUSAL_STATUS,
      'a loopback name on the wrong port is refused');

    // The refusal is the Host check and not a dead server: the same socket path with an authority the
    // page was actually served from still answers the asset.
    assert.equal(await statusFor(port, target, `127.0.0.1:${port}`), 200, 'the served authority still answers');
    assert.equal(await statusFor(port, target, `localhost:${port}`), 200, 'so does the loopback name');
    // And the handler is still alive after three refusals.
    assert.equal(await statusFor(port, target, `127.0.0.1:${port}`), 200, 'a refusal does not take the server down');
  });
}
