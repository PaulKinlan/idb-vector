export function corpus(count, dim, seed = 42) {
  const values = new Float32Array(count * dim);
  for (let i = 0; i < values.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    values[i] = seed / 2147483648 - 1;
  }
  return values;
}

export function cpuScores(values, query) {
  const out = new Float64Array(values.length / query.length);
  let qq = 0;
  for (const q of query) qq += q * q;
  for (let row = 0; row < out.length; row++) {
    let dot = 0, norm = 0;
    for (let j = 0; j < query.length; j++) {
      const a = values[row * query.length + j];
      dot += a * query[j]; norm += a * a;
    }
    out[row] = dot / Math.sqrt(norm * qq);
  }
  return out;
}

export function topK(scores, k = 10) {
  const best = [];
  // ponytail: O(n*k), k=10 in this experiment; use a heap for large k.
  for (let id = 0; id < scores.length; id++) {
    if (!Number.isFinite(scores[id])) throw new Error(`Non-finite score at ${id}`);
    if (best.length === k && scores[id] < best[k - 1].score) continue;
    best.push({ id, score: scores[id] });
    best.sort((a, b) => b.score - a.score || a.id - b.id);
    if (best.length > k) best.pop();
  }
  return best;
}

export function compare(reference, candidate, referenceScores, candidateScores) {
  const ids = new Set(reference.map(x => x.id));
  let maxAbsoluteScoreError = 0;
  if (referenceScores && candidateScores) {
    if (referenceScores.length !== candidateScores.length) throw new Error('Score count mismatch');
    for (let i = 0; i < referenceScores.length; i++) {
      if (!Number.isFinite(candidateScores[i])) throw new Error('Non-finite candidate score');
      maxAbsoluteScoreError = Math.max(maxAbsoluteScoreError, Math.abs(referenceScores[i] - candidateScores[i]));
    }
  } else {
    for (const item of candidate) {
      const ref = reference.find(x => x.id === item.id);
      if (ref) maxAbsoluteScoreError = Math.max(maxAbsoluteScoreError, Math.abs(ref.score - item.score));
    }
  }
  return {
    orderedTopKMatch: reference.length === candidate.length && reference.every((x, i) => x.id === candidate[i].id),
    overlap: candidate.filter(x => ids.has(x.id)).length / reference.length,
    maxAbsoluteScoreError,
    scoreErrorScope: referenceScores ? 'all corpus scores' : 'shared top-k only',
  };
}

export async function wasmEngine(values, dim) {
  const started = performance.now();
  const response = await fetch(new URL('./cosine.wasm', import.meta.url));
  if (!response.ok) throw new Error(`WASM fetch: ${response.status}`);
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  const { memory, score, __heap_base } = instance.exports;
  const base = (__heap_base.value + 15) & ~15;
  const q = base + values.byteLength, out = q + dim * 4, count = values.length / dim;
  const bytes = out + count * 4;
  if (bytes > memory.buffer.byteLength) memory.grow(Math.ceil((bytes - memory.buffer.byteLength) / 65536));
  const copyStart = performance.now();
  new Float32Array(memory.buffer, base, values.length).set(values);
  const uploadMs = performance.now() - copyStart;
  return {
    setupMs: performance.now() - started, uploadMs,
    run(query) {
      new Float32Array(memory.buffer, q, dim).set(query);
      score(base, q, out, count, dim);
      return new Float32Array(memory.buffer, out, count);
    },
  };
}

export async function gpuEngine(values, dim) {
  if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
  const started = performance.now();
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('requestAdapter returned null');
  const info = adapter.info;
  const adapterInfo = Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter'].map(k => [k, info[k]]));
  const device = await adapter.requestDevice();
  const count = values.length / dim;
  const buffers = [];
  let lost = null;
  device.lost.then(x => { lost = x.message || x.reason; });
  device.addEventListener('uncapturederror', event => { lost = event.error.message; });
  const buffer = (size, usage) => {
    if (size > device.limits.maxBufferSize || ((usage & GPUBufferUsage.STORAGE) && size > device.limits.maxStorageBufferBindingSize)) {
      throw new Error(`Buffer ${size} exceeds adapter limits; this demo does not chunk GPU buffers`);
    }
    const b = device.createBuffer({ size, usage }); buffers.push(b); return b;
  };
  try {
    const matrix = buffer(values.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const queryBuffer = buffer(dim * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    const scores = buffer(count * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const readback = buffer(count * 4, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var<storage, read> matrix: array<f32>;
      @group(0) @binding(1) var<storage, read> query: array<f32>;
      @group(0) @binding(2) var<storage, read_write> scores: array<f32>;
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
        let row = id.x; if (row >= ${count}u) { return; }
        var dot = vec4f(0); var aa = vec4f(0); var bb = vec4f(0);
        for (var j = 0u; j < ${dim}u; j += 4u) {
          let a = vec4f(matrix[row * ${dim}u+j],matrix[row * ${dim}u+j+1u],matrix[row * ${dim}u+j+2u],matrix[row * ${dim}u+j+3u]);
          let b = vec4f(query[j],query[j+1u],query[j+2u],query[j+3u]);
          dot += a*b; aa += a*a; bb += b*b;
        }
        scores[row] = (dot.x+dot.y+dot.z+dot.w) / (sqrt(aa.x+aa.y+aa.z+aa.w)*sqrt(bb.x+bb.y+bb.z+bb.w));
      }` });
    const messages = (await module.getCompilationInfo()).messages.filter(x => x.type === 'error');
    if (messages.length) throw new Error(messages.map(x => x.message).join('; '));
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [matrix, queryBuffer, scores].map((b, binding) => ({ binding, resource: { buffer: b } })) });
    const uploadStart = performance.now();
    device.queue.writeBuffer(matrix, 0, values);
    await device.queue.onSubmittedWorkDone();
    const uploadMs = performance.now() - uploadStart;
    if (lost) throw new Error(lost);
    return {
      adapterInfo, uploadMs, setupMs: performance.now() - started,
      async run(query) {
        if (lost) throw new Error(`WebGPU device unavailable: ${lost}`);
        device.queue.writeBuffer(queryBuffer, 0, query);
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline); pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(Math.ceil(count / 64)); pass.end();
        encoder.copyBufferToBuffer(scores, 0, readback, 0, count * 4);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(readback.getMappedRange()).slice();
        readback.unmap();
        if (lost) throw new Error(lost);
        return result;
      },
      close() { buffers.forEach(b => b.destroy()); device.destroy(); },
    };
  } catch (error) { buffers.forEach(b => b.destroy()); device.destroy(); throw error; }
}
