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
//  - withVerifiedAssets() guards fetches during asset setup. Same-origin
//    responses must match a pin, including loads outside ./vendor/ and
//    ./models/; overlapping callbacks share one guard until the last exits.
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

const activeGuards = new Set();
let originalFetch, guardedFetch;

export async function withVerifiedAssets(manifest, fn, { base = import.meta.url, scopes = [{ url: './vendor/', path: 'vendor/' }, { url: './models/', path: 'models/' }] } = {}) {
  const root = new URL('.', base).href;
  const guard = {
    manifest,
    origin: new URL(base).origin,
    root,
    prefixes: scopes.map(scope => ({ prefix: new URL(scope.url, base).href, path: scope.path })),
  };
  // Without a document, fetch() has no shared base for relative strings.
  // Two different roots cannot be interpreted unambiguously by one global wrapper.
  if (!globalThis.document && [...activeGuards].some(active => active.root !== root)) {
    throw new Error('Integrity: overlapping guards with different bases require a document');
  }
  if (!activeGuards.size) {
    originalFetch = globalThis.fetch;
    guardedFetch = async (input, init) => {
      // Resolve relative strings against the active demo root. URL and Request
      // inputs already carry absolute URLs; callers use the same root in practice.
      const url = new URL(typeof input === 'string' ? input : (input?.href ?? input.url), globalThis.document?.baseURI ?? root);
      // Bind the guards at request start: completion can outlive the callback.
      const guards = [...activeGuards], fetchImpl = originalFetch;
      const response = await fetchImpl(input, init);
      for (const { manifest, origin, root, prefixes } of guards) {
        // blob:/data: bytes are page-owned, not network responses from the demo
        // origin (blob: can nevertheless report that origin in Chromium).
        if (url.protocol === 'blob:' || url.protocol === 'data:') continue;
        // Pins identify asset paths, not cache-busting query strings or fragments.
        const assetUrl = url.origin + url.pathname;
        const scope = prefixes.find(scope => assetUrl.startsWith(scope.prefix));
        // A vendored module can fetch another same-origin path: do not let that
        // escape verification just because it is outside vendor/ or models/.
        if (!scope && url.origin !== origin) continue;
        const path = scope ? scope.path + decodeURI(assetUrl.slice(scope.prefix.length))
          : decodeURI(assetUrl.startsWith(root) ? assetUrl.slice(root.length) : assetUrl);
        await verifyBytes(manifest, path, new Uint8Array(await response.clone().arrayBuffer()));
      }
      return response;
    };
    globalThis.fetch = guardedFetch;
  }
  activeGuards.add(guard);
  try { return await fn(); }
  finally {
    activeGuards.delete(guard);
    if (!activeGuards.size) {
      if (globalThis.fetch === guardedFetch) globalThis.fetch = originalFetch;
      originalFetch = guardedFetch = undefined;
    }
  }
}
