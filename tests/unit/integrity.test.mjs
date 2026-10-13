import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadManifest, parsePins, verifyBytes, withVerifiedAssets } from '../../demo/integrity.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const response = (bytes, ok = true, status = 200) => new Response(bytes, { ok, status });
const BASE = 'https://demo.example/demo/encoder.js';

// The real manifest and a real pinned sample asset: the happy path is tested
// against the shipped files, not invented fixtures. loadManifest succeeding at
// all is itself the assertion that the pin constant matches assets.json.
const manifestBytes = new Uint8Array(await readFile(new URL('../../demo/assets.json', import.meta.url)));
const licenseBytes = new Uint8Array(await readFile(new URL('../../demo/vendor/ONNXRUNTIME-LICENSE', import.meta.url)));

test('loadManifest accepts the shipped manifest and builds the pin map', async () => {
  const manifest = await loadManifest(() => Promise.resolve(response(manifestBytes)), 'https://demo.example/assets.json');
  assert.equal(manifest.get('vendor/transformers.min.js').sha256, 'bcf7cf304e51f470ed59409622b9d6ffbad80dfcf5baf6a40c919e4b9c4ff812');
  assert.ok(manifest.size >= 10);
});

test('loadManifest rejects a manifest whose bytes do not match the pinned constant', async () => {
  const tampered = new Uint8Array(manifestBytes);
  tampered[0] ^= 0xff;
  await assert.rejects(
    () => loadManifest(() => Promise.resolve(response(tampered)), 'https://demo.example/assets.json'),
    /assets\.json digest .* does not match the pinned manifest/,
  );
});

test('loadManifest rejects fetch failures', async () => {
  await assert.rejects(() => loadManifest(() => Promise.resolve(response(new Uint8Array(), false, 404)), 'x'), /could not be fetched/);
});

test('parsePins rejects malformed and duplicate pin lists behind the digest gate', async () => {
  assert.throws(() => parsePins(new TextEncoder().encode('[{"file":"a"}]')), /not a valid pin list/);
  assert.throws(
    () => parsePins(new TextEncoder().encode(JSON.stringify([{ file: 'a', bytes: 1, sha256: 'x' }, { file: 'a', bytes: 2, sha256: 'y' }]))),
    /duplicate paths/,
  );
  const pins = parsePins(manifestBytes);
  assert.equal(pins.get('data/vectors-250.f32').bytes, 384000);
});

test('verifyBytes accepts a pinned file and rejects wrong bytes, lengths and unpinned paths', async () => {
  const manifest = await loadManifest(() => Promise.resolve(response(manifestBytes)), 'x');
  const entry = manifest.get('vendor/ONNXRUNTIME-LICENSE');
  assert.equal(entry.bytes, licenseBytes.byteLength);
  await verifyBytes(manifest, 'vendor/ONNXRUNTIME-LICENSE', licenseBytes);

  const flipped = new Uint8Array(licenseBytes); flipped[flipped.length - 1] ^= 0xff;
  await assert.rejects(() => verifyBytes(manifest, 'vendor/ONNXRUNTIME-LICENSE', flipped), /digest .* does not match/);
  await assert.rejects(() => verifyBytes(manifest, 'vendor/ONNXRUNTIME-LICENSE', licenseBytes.subarray(0, 10)), /is 10 bytes, expected/);
  await assert.rejects(() => verifyBytes(manifest, 'vendor/not-pinned.js', licenseBytes), /not pinned/);
});

test('withVerifiedAssets verifies in-scope responses and passes through everything else', async () => {
  const manifest = await loadManifest(() => Promise.resolve(response(manifestBytes)), 'x');
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = input => { seen.push(String(input)); return Promise.resolve(response(licenseBytes)); };
  try {
    const result = await withVerifiedAssets(manifest, async () => {
      const inScope = await fetch('https://demo.example/demo/vendor/ONNXRUNTIME-LICENSE');
      assert.equal(inScope.status, 200);
      await fetch('https://other.example/data/passages-250.json');
      return 'done';
    }, { base: BASE, scopes: [{ url: './vendor/', path: 'vendor/' }] });
    assert.equal(result, 'done');
    assert.deepEqual(seen, ['https://demo.example/demo/vendor/ONNXRUNTIME-LICENSE', 'https://other.example/data/passages-250.json']);
    assert.equal(globalThis.fetch.toString().includes('native'), false); // guard still installed during the scope
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('withVerifiedAssets fails closed on tampered and unpinned vendored files', async () => {
  const manifest = await loadManifest(() => Promise.resolve(response(manifestBytes)), 'x');
  const realFetch = globalThis.fetch;
  try {
    for (const [path, pattern] of [['demo/vendor/ONNXRUNTIME-LICENSE', /is 3 bytes, expected 1073/], ['demo/vendor/never-listed.wasm', /not pinned/]]) {
      const seen = [];
      globalThis.fetch = input => { seen.push(String(input)); return Promise.resolve(response(new Uint8Array(3))); };
      await assert.rejects(
        () => withVerifiedAssets(manifest, () => fetch(`https://demo.example/${path}`), { base: BASE, scopes: [{ url: './vendor/', path: 'vendor/' }] }),
        pattern,
      );
      assert.equal(seen.length, 1);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('withVerifiedAssets restores fetch even when the callback throws', async () => {
  const manifest = await loadManifest(() => Promise.resolve(response(manifestBytes)), 'x');
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(response(licenseBytes));
  try {
    await assert.rejects(
      () => withVerifiedAssets(manifest, () => Promise.reject(new Error('callback failed')), { base: BASE, scopes: [{ url: './vendor/', path: 'vendor/' }] }),
      /callback failed/,
    );
    assert.equal(globalThis.fetch.toString().includes('native'), false); // restored to the pre-scope mock, not left wrapping it
  } finally {
    globalThis.fetch = realFetch;
  }
});
