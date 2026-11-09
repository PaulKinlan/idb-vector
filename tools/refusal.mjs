// All in-repo loopback servers answer for the same refusal: tools/wiki-demo-server.mjs (the wiki demo
// server), tools/demo-server.mjs (the measurement harness demo server), tests/real-vectors.mjs (the real
// vectors measurement server), and the allowlist server inside tests/research.mjs (the research
// acceptance driver). "I will not serve this path" is one status, written once here, because the two
// confinement helpers have drifted twice while each server kept its own answer
// (tests/unit/asset-confinement-parity.test.mjs records that history) - until idb-vector-zs1u settled on
// 404 and idb-vector-sd71 routed all four servers through this single writer. One source, so the number
// cannot diverge again.
//
// 404 is the status, not 403, and it covers both shapes of the same meaning:
//   - the path is not an allowed asset at all (the demo server's name regex, or the driver's
//     assetFiles/assetDirs allowlist), and
//   - the allowlist admitted the name but a confinement helper refused what it resolved to (a link out
//     of the root, an unresolvable name - idb-vector-4c06, idb-vector-jz65).
// A 403 for the second shape would tell any process on the host that a confined path exists, and no
// consumer reads the difference - not a test, not the demo page, not the driver's receipt. The demo
// server's own admission helper is the confiner as well, so the two shapes are one event there and
// "allowed but genuinely missing" is refused before any read; both servers read after admission, and
// both answer 500 for a read that fails there (the driver's since idb-vector-7iu, the demo server's
// since idb-vector-7g2x), so this status never covers a broken read.
//
// Pinned by tests/unit/refusal-status-parity.test.mjs without a socket (the fast tier): it asserts this
// value, drives refuse() against a fake response, and checks both callers route through it. The
// HTTP-level shapes are pinned where a socket already exists: tests/unit/demo-server-routing.test.mjs
// for the demo server, and tests/research.mjs's own run for the driver.
export const REFUSAL_STATUS = 404;

// Answer a refusal. Taking the response object is what lets both handlers share the status while each
// keeps its own body: the driver sends 'Not found', the demo server sends none.
export function refuse(res, body = '') {
  res.writeHead(REFUSAL_STATUS).end(body);
}
