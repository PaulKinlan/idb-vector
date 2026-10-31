// The two upstream JSON envelopes the paid Wikipedia embedding path reads, bounded and shape-checked
// before anything walks them (idb-vector-zdcv).
//
// tools/embed-wikipedia.mjs called response.json() and then walked body.query.pages and body.data
// with no shape or size check, so any 200 that was not the expected envelope — a MediaWiki format or
// parameter change, a proxy or captive-portal HTML page, a partial continuation reply, a provider
// error object — crashed as `TypeError: Cannot read properties of undefined (reading 'pages')` from
// a line that never says which request came back wrong, after response.json() had buffered whatever
// arrived. Row-level provider checks stay in ./embedding-rows.mjs (idb-vector-oaeb); this module is
// the envelope in front of them.

// A body above this many bytes is refused instead of parsed. The widest legitimate response here is
// a Wikipedia batch of ten whole plain-text article extracts: the longest English Wikipedia articles
// run to roughly a megabyte of extract each, so a ten-article batch is ~10 MB at its extreme, while a
// 64 x 256 float embedding batch is a few hundred kilobytes of JSON. 16 MiB is well above the largest
// real response and still fails loudly on an endpoint that streams something else at us.
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

// Request targets can carry credentials (?key=) and multi-kilobyte title batches; only the origin and
// path are ever reported.
const describeUrl = value => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value);
  }
};

const describeShape = value => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
};

const describeKeys = value => value && typeof value === 'object' && !Array.isArray(value)
  ? ` with keys ${Object.keys(value).slice(0, 6).map(key => JSON.stringify(key).slice(0, 40)).join(', ')}`
  : '';

async function readBoundedText(response, { label, requestUrl, maxBytes }) {
  const subject = `${label} ${describeUrl(requestUrl)} (HTTP ${response.status})`;
  const limit = `the ${maxBytes}-byte body limit`;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${subject} declares ${declared} bytes in content-length, past ${limit}; refused without parsing`);
  }
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Stop reading rather than drain a body we have already refused.
        try { await reader.cancel(); } catch {}
        throw new Error(`${subject} streams past ${limit} (read ${bytes} bytes so far); refused without parsing`);
      }
      chunks.push(Buffer.from(value));
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, subject, contentType: response.headers.get('content-type') ?? 'none' };
}

// Read a response body under MAX_RESPONSE_BYTES and parse it as JSON. A body that is not JSON is
// reported by content type and size — never dumped, since the bytes are untrusted and may be an
// upstream error page that echoes the request.
export async function readJsonEnvelope(response, { label, requestUrl, maxBytes = MAX_RESPONSE_BYTES }) {
  const { text, bytes, subject, contentType } = await readBoundedText(response, { label, requestUrl, maxBytes });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${subject} is not JSON (content-type ${contentType}, ${bytes} bytes); expected a JSON envelope, so the body was not parsed`);
  }
}

// MediaWiki action=query reply. Returns the page objects to walk plus the continuation token, so the
// caller never re-derives them from an unvalidated body.
export function wikipediaPagesEnvelope(body, { requestUrl, status }) {
  const subject = `Wikipedia ${describeUrl(requestUrl)} (HTTP ${status})`;
  const failure = body?.error;
  if (failure) {
    const code = failure.code ?? '(no code)';
    const info = typeof failure.info === 'string' ? `: ${failure.info}` : '';
    throw new Error(`${subject} returned a MediaWiki error body, code ${code}${info}; no paid request sent`);
  }
  // formatversion=2 returns pages as an array, formatversion=1 as a pageid-keyed object; both walk.
  const pages = body?.query?.pages;
  if (!pages || typeof pages !== 'object') {
    throw new Error(`${subject} has no query.pages map; expected { batchcomplete?, continue?, query: { pages: { <pageid>: { pageid, title, extract?, lastrevid? } } } }, received ${describeShape(body)}${describeKeys(body)}`);
  }
  const list = Object.values(pages);
  for (const page of list) {
    if (!page || typeof page !== 'object') {
      throw new Error(`${subject} has ${describeShape(page)} in query.pages; expected a page object per page key`);
    }
    if (page.extract !== undefined && typeof page.extract !== 'string') {
      throw new Error(`${subject} returned page ${page.pageid ?? '(no pageid)'} with ${describeShape(page.extract)} extract; expected extract text, so it was not split`);
    }
  }
  return { pages: list, continuation: body.continue };
}

// OpenAI /v1/embeddings reply: only the envelope fields the paid path writes into its cache. The
// rows themselves stay with orderedEmbeddingVectors (./embedding-rows.mjs).
export function embeddingEnvelope(body, { requestUrl, status }) {
  const subject = `OpenAI embeddings ${describeUrl(requestUrl)} (HTTP ${status})`;
  if (!Array.isArray(body?.data)) {
    throw new Error(`${subject} has no data array; expected { object, model, data: [{ index, embedding }], usage: { total_tokens } }, received ${describeShape(body)}${describeKeys(body)}`);
  }
  if (typeof body.model !== 'string' || body.model === '') {
    throw new Error(`${subject} is missing the model string; expected { model, data: [...], usage: { total_tokens } }, received model ${describeShape(body.model)}`);
  }
  const totalTokens = body.usage?.total_tokens;
  if (!Number.isSafeInteger(totalTokens)) {
    throw new Error(`${subject} is missing usage.total_tokens; expected a safe integer token count for the cost record, received ${describeShape(totalTokens)}`);
  }
  return body;
}
