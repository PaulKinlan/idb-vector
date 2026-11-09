// Every in-repo loopback server answers the same way for a failure that is NOT a refusal: 500, with its
// own body. tools/wiki-demo-server.mjs ('Could not read demo file'), tools/demo-server.mjs (same body),
// tests/real-vectors.mjs ('Dataset unavailable') and the allowlist server inside tests/research.mjs
// ('Acceptance server error'). The split from the refusal is deliberate and old - "not an allowed asset"
// is the 404 tools/refusal.mjs writes, "this handler failed" is a 500 (idb-vector-7iu, idb-vector-7g2x)
// - but each server wrote its 500 inline, so the answer to a failure was written four times.
//
// The reason to write it once is not tidiness, it is that one of those four copies could take the
// process down. A failure that lands AFTER the response has begun - res.end() throwing once the headers
// are out, a client that aborted mid-response - reached a bare writeHead(500), which throws
// ERR_STREAM_WRITE_AFTER_END inside the handler's catch. An async handler's rejection is unhandled, so
// the server died and the client got nothing at all (idb-vector-bc9t). Once the headers are sent there
// is no status left to send, so the only honest answer is to drop the connection; before that, the 500.
export function answerFault(res, body) {
  if (res.headersSent || res.writableEnded) { res.destroy(); return; }
  res.writeHead(500).end(body);
}
