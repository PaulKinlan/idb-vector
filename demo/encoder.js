// Both corpus preparation and live questions use this exact quantized encoder.
// The vendored runtime and every model file are integrity-checked against
// demo/assets.json (via demo/integrity.js) before their bytes execute or load.
import { loadManifest, verifyBytes, withVerifiedAssets } from './integrity.js';

export async function createEncoder(progress_callback) {
  const manifest = await loadManifest();
  return withVerifiedAssets(manifest, async () => {
    // Fetch the runtime through the guarded fetch, then execute exactly the
    // verified bytes via a blob URL — there is no second, unchecked network
    // load between verification and evaluation. The bundle has no relative
    // imports or import.meta URLs, so a blob module is faithful to it.
    const runtimeResponse = await fetch(new URL('./vendor/transformers.min.js', import.meta.url).href);
    if (!runtimeResponse.ok) throw new Error(`Runtime download failed (${runtimeResponse.status})`);
    const runtimeBytes = new Uint8Array(await runtimeResponse.arrayBuffer());
    await verifyBytes(manifest, 'vendor/transformers.min.js', runtimeBytes, 'the vendored runtime');
    const blobUrl = URL.createObjectURL(new Blob([runtimeBytes], { type: 'text/javascript' }));
    let runtimeModule;
    try { runtimeModule = await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
    const { pipeline, env } = runtimeModule;
    env.allowRemoteModels = false;
    env.localModelPath = new URL('./models/', import.meta.url).href;
    env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
    // Fetches for config, tokenizer, quantized model and the ONNX runtime WASM
    // all resolve under ./models/ or ./vendor/ and pass through the guard.
    const model = await pipeline('feature-extraction', 'all-MiniLM-L6-v2', { quantized: true, progress_callback });
    return async text => {
      const result = await model(text, { pooling: 'mean', normalize: true });
      return result.tolist();
    };
  });
}
