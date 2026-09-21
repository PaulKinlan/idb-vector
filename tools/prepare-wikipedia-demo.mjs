// Reuses the public-text snapshot from embed-wikipedia.mjs, without its paid embedding step.
// Usage: node tools/prepare-wikipedia-demo.mjs path/to/passages.json
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { serve } from './wiki-demo-server.mjs';
import { launch } from '../tests/lib/cdp.mjs';
const inputArg = process.argv[2];
if (!inputArg) throw new Error('Usage: node tools/prepare-wikipedia-demo.mjs path/to/passages.json');
const inputPath = resolve(process.cwd(), inputArg);
if (!inputPath.startsWith(resolve(process.cwd()) + '/')) throw new Error('Refusing to read outside the current working directory');
const input = await readFile(inputPath);
const source = JSON.parse(input);
const passages = (Array.isArray(source) ? source : source.passages).filter(p => p.revision && p.pageid).slice(0, 2000);
if (passages.length !== 2000 || passages.some(p => !p.text || !p.title || !p.revision || !p.pageid)) throw new Error('Need 2000 attributed passages with revision IDs');
const { server, url } = await serve();
let page;
try {
  page = await launch();
  await page.goto(url);
  await page.evaluate(async () => { window.encode = await (await import('./encoder.js')).createEncoder(); });
  const vectors = [];
  for (let i = 0; i < passages.length; i += 16) {
    const batch = await page.evaluate(async texts => window.encode(texts), passages.slice(i, i + 16).map(p => p.text));
    if (batch.some(v => v.length !== 384 || v.some(x => !Number.isFinite(x)))) throw new Error('Invalid embeddings');
    vectors.push(...batch);
    console.log(`Encoded ${vectors.length}/2000`);
  }
  const artifacts = {};
  for (const count of [250, 2000]) {
    const text = JSON.stringify(passages.slice(0, count));
    const binary = Buffer.from(new Float32Array(vectors.slice(0, count).flat()).buffer);
    await writeFile(new URL(`../demo/data/passages-${count}.json`, import.meta.url), text);
    await writeFile(new URL(`../demo/data/vectors-${count}.f32`, import.meta.url), binary);
    artifacts[count] = { passageBytes: Buffer.byteLength(text), vectorBytes: binary.length,
      vectorSha256: createHash('sha256').update(binary).digest('hex') };
  }
  await writeFile(new URL('../demo/data/source.json', import.meta.url), JSON.stringify({
    model: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    runtime: '@xenova/transformers 2.17.2 / onnxruntime-web 1.14.0', dimensions: 384,
    pooling: 'mean, L2 normalized, quantized ONNX, single-thread WASM',
    retrievedAt: source.retrievedAt ?? null, sourceSha256: createHash('sha256').update(input).digest('hex'),
    selection: 'First 2000 round-robin passages with recorded revision IDs from the embed-wikipedia.mjs public Wikipedia snapshot; entries missing revision attribution excluded. 250 is a prefix. Not all Wikipedia.',
    license: 'Wikipedia text CC BY-SA 4.0; per-passage page IDs and revision IDs retained. Text is excerpted into 200–600-character spans.',
    preparedAt: new Date().toISOString(), artifacts,
  }, null, 2));
} finally { if (page) await page.close(); server.close(); }
