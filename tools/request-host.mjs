// A loopback bind stops a remote machine, not a web page. Any site the developer visits can point its
// own hostname at 127.0.0.1 (DNS rebinding) and then read these servers' answers as same-origin, and a
// plain cross-origin request reaches the port without any rebinding at all; the Host header is the one
// thing that still names the origin the requesting page was served from, so checking it is what turns
// "listens on 127.0.0.1" into a browser-origin boundary (idb-vector-2703). All four in-repo servers
// (tools/demo-server.mjs, tools/wiki-demo-server.mjs, tests/real-vectors.mjs, tests/research.mjs) ask
// this module before they touch the request, so the rule cannot drift between them the way the refusal
// status did before idb-vector-zs1u.
//
// ACCEPTED: the three spellings of loopback, each carrying the port this server is actually listening
// on - 127.0.0.1:<port>, localhost:<port>, [::1]:<port>. All three, not only the 127.0.0.1 literal the
// four binds hardcode today: allowing `localhost` and `[::1]` costs nothing, because a page reaches a
// server under the authority it was served from and a rebound page necessarily sends its OWN
// hostname - it cannot ask for "localhost" - while a reader who types http://localhost:<port>/ (or a
// bind widened to IPv6 loopback later) does need the name to work. Case is not significant: the URL
// parser lowercases the hostname before the comparison.
//
// REFUSED: a foreign hostname (the DNS-rebinding shape), a loopback name on a different port, a bare
// loopback name with no port (that addresses port 80, not this server), a missing Host, more than one
// Host field, and anything that is not a bare authority (a value carrying a path, credentials or a port
// that does not parse).
// Two Host fields are invalid however they are spelled (RFC 7230 5.4), and which of them a parser
// resolves to is not something this module may depend on: before idb-vector-eyvp a request sending
// `Host: 127.0.0.1:<port>` and then `Host: evil.example` resolved to the loopback value and was
// answered 200, while the reverse order was refused. So the duplicate check counts the raw fields that
// arrived, not the merged value.
// A missing Host answers the same refusal as any other bad Host here: this helper says no, and the
// caller answers through refuse(), 404 like every other refusal. A probe can still see a 400 for this
// shape on HTTP/1.1, because Node's own parser rejects a request with no Host before any handler runs;
// that 400 is the parser's answer, not this module's, and it is why this helper does not invent a
// second status for the case (idb-vector-eyvp). It refuses it on its own terms rather than trusting
// the parser to stay strict.
// The port compared against is the local port of the connection that carried the request - the port
// this server is listening on - rather than an argument: a caller cannot hand it the wrong number, and
// it is still there while a handler outlives the listen (server.address() is null after close).
//
// What a refusal answers: tools/refusal.mjs - 404, the same number "I will not serve this" already
// answers for a confined path (idb-vector-zs1u). 400 is defensible on the header's own terms (an
// invalid Host is a bad request), but a 400 confirms to the page that it found a live server and only
// got the Host wrong, which is the existence oracle 403 was rejected for on the path side. 404 leaves a
// rebound page unable to tell this server from an unused port, and keeps one number for one meaning
// instead of adding a second refusal status that can diverge from the first.
const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '[::1]']);

// request.rawHeaders is the flat [name, value, name, value, ...] list of the fields that arrived, while
// request.headers.host is only the merged winner - so the duplicate count has to read the raw list. A
// request object that carries no rawHeaders (a hand-built one) cannot show a duplicate and is not
// refused on this ground.
function hostFieldCount(request) {
  const raw = request.rawHeaders;
  if (!Array.isArray(raw)) return 0;
  let count = 0;
  for (let i = 0; i < raw.length; i += 2) {
    if (typeof raw[i] === 'string' && raw[i].toLowerCase() === 'host') count += 1;
  }
  return count;
}

export function hostAllowed(request) {
  if (hostFieldCount(request) > 1) return false;
  const header = request.headers?.host;
  if (typeof header !== 'string' || header === '') return false;
  const listeningPort = request.socket?.localPort;
  if (listeningPort === undefined) return false;
  let authority;
  try {
    // Parse as the authority of an http URL: that rejects a port out of range and an unbalanced IPv6
    // bracket, and normalises the IPv6 literal to the bracketed form compared below.
    authority = new URL(`http://${header}`);
  } catch {
    return false;
  }
  // Only an authority: a Host value never carries a path, query, fragment or credentials.
  if (authority.pathname !== '/' || authority.search || authority.hash || authority.username || authority.password) return false;
  // An http URL drops the default port, so an absent port is port 80 - which is not this server.
  if ((authority.port || '80') !== String(listeningPort)) return false;
  return loopbackHostnames.has(authority.hostname);
}
