// tests/unit/response-envelope.test.mjs — the untrusted-body boundary in front of the paid run.
//
// idb-vector-zdcv: tools/embed-wikipedia.mjs walked body.query.pages and body.data straight from
// response.json(), so a 200 that was not the expected envelope (a MediaWiki error object, a proxy's
// HTML page, a format change, a partial reply) threw a raw TypeError from inside the walk and never
// said which request came back wrong — and no fetch bounded the bytes it buffered. No network here:
// a stub stands in for fetch and hands back the response bodies these guards must name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MAX_RESPONSE_BYTES, readJsonEnvelope, wikipediaPagesEnvelope, embeddingEnvelope } from '../../tools/response-envelope.mjs';
import { orderedEmbeddingVectors } from '../../tools/embedding-rows.mjs';

const wikipediaUrl = 'https://en.wikipedia.org/w/api.php';
const embeddingUrl = 'https://api.openai.com/v1/embeddings';
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

// A stubbed fetch: no request leaves the process, and the URL the caller built is still asserted so
// a rewritten endpoint cannot slip past these diagnostics.
function stubFetch(t, response, expectedUrl) {
  const original = globalThis.fetch;
  globalThis.fetch = async url => { assert.equal(String(url), expectedUrl); return response; };
  t.after(() => { globalThis.fetch = original; });
}

const readWikipedia = async (response, requestUrl = wikipediaUrl) => {
  const body = await readJsonEnvelope(response, { label: 'Wikipedia', requestUrl });
  return wikipediaPagesEnvelope(body, { requestUrl, status: response.status });
};

const readEmbeddings = async (response, requestUrl = embeddingUrl) => {
  const body = await readJsonEnvelope(response, { label: 'OpenAI embeddings', requestUrl });
  return embeddingEnvelope(body, { requestUrl, status: response.status });
};

const page = (pageid, title, extra = {}) => ({ pageid, title, extract: `${title} extract`, lastrevid: 1000 + pageid, ...extra });
const embeddingResponse = rows => ({ object: 'list', model: 'text-embedding-3-small', usage: { prompt_tokens: 7, total_tokens: 9 }, data: rows });

test('a valid MediaWiki envelope passes its pages and continuation on to the walker', async t => {
  stubFetch(t, json({
    batchcomplete: '', continue: { excontinue: '1', continue: '||' },
    query: { pages: { 12: page(12, 'Mathematics') } },
  }), wikipediaUrl);
  const { pages, continuation } = await readWikipedia(await fetch(wikipediaUrl));
  assert.deepEqual(pages.map(p => [p.pageid, p.title]), [[12, 'Mathematics']]);
  assert.deepEqual(continuation, { excontinue: '1', continue: '||' }, 'continuation survives so no article is silently dropped');
});

test('a formatversion=2 pages array is walked as well as the pageid-keyed map', async t => {
  stubFetch(t, json({ query: { pages: [page(1, 'Physics')] } }), wikipediaUrl);
  const { pages, continuation } = await readWikipedia(await fetch(wikipediaUrl));
  assert.deepEqual(pages.map(p => p.pageid), [1]);
  assert.equal(continuation, undefined);
});

test('a valid embeddings envelope reaches the row mapper unchanged', async t => {
  const rows = [{ object: 'embedding', index: 1, embedding: [2, 0, 1] }, { object: 'embedding', index: 0, embedding: [1, 0, 1] }];
  stubFetch(t, json(embeddingResponse(rows)), embeddingUrl);
  const body = await readEmbeddings(await fetch(embeddingUrl));
  assert.deepEqual(body.data, rows, 'the parsed rows are handed on untouched');
  assert.deepEqual(orderedEmbeddingVectors(body, 2, 3).map(vector => vector[0]), [1, 2]);
});

test('a MediaWiki error body throws with its code, the URL and the status', async t => {
  stubFetch(t, json({ error: { code: 'maxlag', info: 'Waiting for a database server: 5 seconds lagged.' } }), wikipediaUrl);
  await assert.rejects(readWikipedia(await fetch(wikipediaUrl)), error => {
    assert.match(error.message, /Wikipedia https:\/\/en\.wikipedia\.org\/w\/api\.php \(HTTP 200\) returned a MediaWiki error body, code maxlag: Waiting for a database server/);
    assert.match(error.message, /no paid request sent/);
    return true;
  });
});

test('an HTML body throws naming the content type, and never echoes the body', async t => {
  stubFetch(t, new Response('<!doctype html><title>502 Proxy Error</title>', { headers: { 'content-type': 'text/html; charset=utf-8' } }), wikipediaUrl);
  await assert.rejects(readWikipedia(await fetch(wikipediaUrl)), error => {
    assert.match(error.message, /is not JSON \(content-type text\/html; charset=utf-8, \d+ bytes\)/);
    assert.match(error.message, /Wikipedia https:\/\/en\.wikipedia\.org\/w\/api\.php \(HTTP 200\)/);
    assert.doesNotMatch(error.message, /Proxy Error/, 'untrusted bytes are described, not dumped');
    return true;
  });
});

test('a JSON body without query.pages throws naming the missing field and what arrived', async t => {
  stubFetch(t, json({ batchcomplete: '' }), wikipediaUrl);
  await assert.rejects(readWikipedia(await fetch(wikipediaUrl)),
    /has no query\.pages map; expected \{ batchcomplete\?, continue\?, query: \{ pages: .*received an object with keys "batchcomplete"/);
});

test('a page whose extract is not text throws instead of being split', async t => {
  stubFetch(t, json({ query: { pages: { 7: page(7, 'Biology', { extract: { html: 'nested' } }) } } }), wikipediaUrl);
  await assert.rejects(readWikipedia(await fetch(wikipediaUrl)), /returned page 7 with an object extract; expected extract text, so it was not split/);
});

test('an embeddings body without a data array throws naming the missing field', async t => {
  stubFetch(t, json({ object: 'list', model: 'text-embedding-3-small', usage: { total_tokens: 9 } }), embeddingUrl);
  await assert.rejects(readEmbeddings(await fetch(embeddingUrl)),
    /OpenAI embeddings https:\/\/api\.openai\.com\/v1\/embeddings \(HTTP 200\) has no data array; .*received an object with keys "object", "model", "usage"/);
});

test('an embeddings body without usage.total_tokens throws before the cost record is written', async t => {
  stubFetch(t, json({ object: 'list', model: 'text-embedding-3-small', data: [] }), embeddingUrl);
  await assert.rejects(readEmbeddings(await fetch(embeddingUrl)), /is missing usage\.total_tokens; .*received undefined/);
});

test('the body limit is the documented 16 MiB, well above the largest legitimate batch', () => {
  assert.equal(MAX_RESPONSE_BYTES, 16 * 1024 * 1024);
});

test('a response declaring more than the body limit is refused before it is parsed', async t => {
  stubFetch(t, new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(MAX_RESPONSE_BYTES + 1) } }), wikipediaUrl);
  await assert.rejects(readWikipedia(await fetch(wikipediaUrl)), /declares 16777217 bytes in content-length, past the 16777216-byte body limit; refused without parsing/);
});

test('a body that streams past the limit is refused mid-read', async t => {
  stubFetch(t, new Response('x'.repeat(5000), { headers: { 'content-type': 'application/json' } }), wikipediaUrl);
  const response = await fetch(wikipediaUrl);
  await assert.rejects(readJsonEnvelope(response, { label: 'Wikipedia', requestUrl: wikipediaUrl, maxBytes: 4096 }),
    /streams past the 4096-byte body limit \(read \d+ bytes so far\); refused without parsing/);
});

test('a diagnostic reports the URL without its query string', async t => {
  const requestUrl = 'https://en.wikipedia.org/w/api.php?titles=Secret%7CTitles&maxlag=5';
  stubFetch(t, json({ batchcomplete: '' }), requestUrl);
  await assert.rejects(readWikipedia(await fetch(requestUrl), requestUrl), error => {
    assert.match(error.message, /https:\/\/en\.wikipedia\.org\/w\/api\.php \(HTTP 200\)/);
    assert.doesNotMatch(error.message, /titles=|maxlag=5|Secret/, 'query secrets and the title batch are never reported');
    return true;
  });
});

// The paid path must keep routing both fetches through these guards: a future edit that reads
// response.json() again would reintroduce the raw TypeError these tests exist to prevent.
test('the embedding tool reads both upstream bodies through the envelope guards', async () => {
  const source = await readFile(new URL('../../tools/embed-wikipedia.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /response\.json\(\)/, 'no upstream body is parsed without the bounded reader');
  assert.match(source, /readJsonEnvelope\(response, \{ label: 'Wikipedia', requestUrl: url \}\)/);
  assert.match(source, /wikipediaPagesEnvelope\(body, \{ requestUrl: url, status: response\.status \}\)/);
  assert.match(source, /embeddingEnvelope\(await readJsonEnvelope\(response, \{ label: 'OpenAI embeddings', requestUrl: embeddingUrl \}\)/);
  assert.match(source, /orderedEmbeddingVectors\(body, requested\.length, dimensions\)/, 'row validation still runs on the validated envelope');
});
