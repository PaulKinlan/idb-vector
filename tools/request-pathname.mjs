// Both loopback demo servers parse req.url against a base; a malformed absolute-form request
// target (e.g. http://[::1/x) makes new URL throw, and the async request handler has no catch
// above it, so Node treats the rejection as fatal — one bad request aborted a whole measurement
// run (idb-vector-i9w, idb-vector-tb6). One safe parse, shared by both servers: null means the
// request target could not be parsed and the caller must answer 400.
export function requestPathname(request) {
  try {
    return new URL(request.url, 'http://localhost').pathname;
  } catch {
    return null;
  }
}
