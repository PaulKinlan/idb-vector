// SRI-style runtime enforcement for the demo's self-hosted assets.
//
// demo/assets.json pins a byte count and a SHA-256 for every vendored file
// (runtime JS, ONNX runtime WASM, quantized model, corpus). This module makes
// the browser actually check those pins before the bytes are used:
//
//  - loadManifest() fetches assets.json and verifies it against
//    MANIFEST_SHA256, a constant in this file, so the trust root is the
//    repository commit that ships this code — the same anchoring as the
//    compute lab's cosine.wasm pin in compute/engines.js.
//  - verifyBytes() checks one fetched payload against its manifest entry.
//  - withVerifiedAssets() installs a scoped fetch guard for a callback: every
//    response served under ./vendor/ or ./models/ during that callback must
//    match its pin, or the request fails closed. Not reentrant — one scope at
//    a time, which is all the demo's sequential Load path needs.
//
// Repeat loads that Transformers.js serves from its Cache API reuse bytes that
// were verified on their first guarded download. Not covered: the page's own
// HTML/CSS/JS, this constant, and anything same-origin script writes into the
// cache — those stay pinned by repository commit and transport TLS only. See
// demo/README.md, "Integrity boundary".

const MANIFEST_SHA256 = '511d406ca8735897dab0fd166c60a3a3c260bb62a75d5e229c475bf39a69f32b';

const sha256Hex = async bytes =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');

// Structure validation that only a manifest which already passed the digest
// check can reach — defense in depth for the constant being repinned badly.
export function parsePins(bytes) {
  const entries = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(entries) || entries.some(entry => typeof entry.file !== 'string' || typeof entry.sha256 !== 'string' || !Number.isInteger(entry.bytes))) {
    throw new Error('Integrity: assets.json is not a valid pin list');
  }
  const manifest = new Map(entries.map(entry => [entry.file, entry]));
  if (manifest.size !== entries.length) throw new Error('Integrity: assets.json contains duplicate paths');
  return manifest;
}

export async function loadManifest(fetchImpl = fetch, url = new URL('./assets.json', import.meta.url).href) {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Integrity: assets.json could not be fetched (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = await sha256Hex(bytes);
  if (digest !== MANIFEST_SHA256) throw new Error(`Integrity: assets.json digest ${digest} does not match the pinned manifest`);
  return parsePins(bytes);
}

export async function verifyBytes(manifest, path, bytes, label = path) {
  const entry = manifest.get(path);
  if (!entry) throw new Error(`Integrity: ${label} is not pinned in assets.json; refusing to use it`);
  if (bytes.byteLength !== entry.bytes) throw new Error(`Integrity: ${label} is ${bytes.byteLength} bytes, expected ${entry.bytes}`);
  const digest = await sha256Hex(bytes);
  if (digest !== entry.sha256) throw new Error(`Integrity: ${label} digest ${digest} does not match its assets.json pin`);
  return entry;
}

export async function withVerifiedAssets(manifest, fn, { base = import.meta.url, scopes = [{ url: './vendor/', path: 'vendor/' }, { url: './models/', path: 'models/' }] } = {}) {
  const prefixes = scopes.map(scope => ({ prefix: new URL(scope.url, base).href, path: scope.path }));
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    const url = typeof input === 'string' ? new URL(input, base).href : input.url;
    const scope = prefixes.find(scope => url.startsWith(scope.prefix));
    if (!scope) return response; // Outside the vendored prefixes: not ours to judge.
    const path = scope.path + decodeURI(url.slice(scope.prefix.length));
    await verifyBytes(manifest, path, new Uint8Array(await response.clone().arrayBuffer()));
    return response;
  };
  try { return await fn(); } finally { globalThis.fetch = original; }
}
