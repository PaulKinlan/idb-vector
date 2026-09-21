// Both corpus preparation and live questions use this exact quantized encoder.
export async function createEncoder(progress_callback) {
  const { pipeline, env } = await import('./vendor/transformers.min.js');
  env.allowRemoteModels = false;
  env.localModelPath = new URL('./models/', import.meta.url).href;
  env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  const model = await pipeline('feature-extraction', 'all-MiniLM-L6-v2', { quantized: true, progress_callback });
  return async text => {
    const result = await model(text, { pooling: 'mean', normalize: true });
    return result.tolist();
  };
}
