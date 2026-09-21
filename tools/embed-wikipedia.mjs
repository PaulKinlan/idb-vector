// Opt-in paid preparation. Keys stay in environment and Authorization headers only.
import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dir = new URL('../.cache/real-vectors/wiki-api/', import.meta.url);
await mkdir(dir, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = async file => { try { return await readFile(new URL(file, dir)); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } };
const model = 'text-embedding-3-small', dimensions = 256;
const pricePerMillionTokens = 0.02; // Published list-price estimate, not billing verification.
const maxEstimatedUSD = 0.25;
const titles = `Mathematics|Physics|Chemistry|Biology|Computer science|Astronomy|Geology|Ecology|Psychology|Sociology|Economics|History|Philosophy|Linguistics|Anthropology|Archaeology|Medicine|Engineering|Architecture|Agriculture|Art|Music|Literature|Poetry|Cinema|Theatre|Dance|Photography|Painting|Sculpture|Democracy|Law|Education|Religion|Ethics|Logic|Statistics|Probability|Calculus|Algebra|Geometry|Number theory|Artificial intelligence|Machine learning|Neural network|Database|Internet|World Wide Web|Cryptography|Operating system|Programming language|Algorithm|Data structure|Information theory|Quantum mechanics|Relativity|Thermodynamics|Electromagnetism|Optics|Particle physics|Nuclear physics|Earth|Moon|Sun|Mars|Solar System|Galaxy|Universe|Black hole|Star|Evolution|Genetics|DNA|Cell (biology)|Protein|Virus|Bacteria|Plant|Animal|Fungus|Photosynthesis|Ecosystem|Biodiversity|Climate change|Ocean|Atmosphere of Earth|Volcano|Earthquake|Plate tectonics|Water|Carbon|Oxygen|Hydrogen|Periodic table|Organic chemistry|Chemical reaction|Energy|Electricity|Battery (electricity)|Solar power|Wind power|Nuclear power|Human brain|Heart|Immune system|Cancer|Diabetes|Vaccine|Nutrition|Sleep|Exercise|Mental health|Language|English language|Spanish language|Chinese language|Arabic|Writing|Printing|Book|Library|United Kingdom|France|Germany|Italy|Spain|United States|Canada|Mexico|Brazil|India|China|Japan|South Korea|Australia|New Zealand|Egypt|Nigeria|South Africa|Kenya|Indonesia|Ancient Egypt|Ancient Greece|Roman Empire|Middle Ages|Renaissance|Industrial Revolution|World War I|World War II|Space exploration|Transport|Rail transport|Aviation|Ship|Bicycle|Automobile|Food|Cooking|Bread|Rice|Coffee|Tea|Chocolate|Sport|Association football|Basketball|Tennis|Swimming|Olympic Games`.split('|');

let corpus = await exists('passages.json');
if (!corpus) {
  const articles = [];
  for (let start = 0; start < titles.length; start += 10) {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.search = new URLSearchParams({ action: 'query', format: 'json', prop: 'extracts|info',
      explaintext: '1', exlimit: '10', redirects: '1', titles: titles.slice(start, start + 10).join('|'), maxlag: '5' });
    // Whole-article extracts are limited to one/page even when exlimit requests more.
    // Follow MediaWiki continuation; silently dropping it would discard nine of ten articles.
    let continuation;
    const revisions = new Map(); // prop=info may appear only on the first continuation page.
    do {
    if (continuation) for (const [key, value] of Object.entries(continuation)) url.searchParams.set(key, value);
    const response = await fetch(url, { headers: { 'User-Agent': 'idb-vector-research/1.0 (https://github.com/PaulKinlan/idb-vector)' }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}; rerun preparation, no paid request sent`);
    const body = await response.json();
    if (body.error) throw new Error(`Wikipedia refused: ${body.error.code}; no paid request sent`);
    for (const page of Object.values(body.query.pages)) {
      if (page.lastrevid) revisions.set(page.pageid, page.lastrevid);
      if (!page.extract) continue;
      const revision = revisions.get(page.pageid);
      if (!revision) throw new Error(`Missing revision attribution for page ${page.pageid}; no paid request sent`);
      const chunks = [];
      for (const paragraph of page.extract.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 200)) {
        // Nonoverlapping bounded spans, no synthetic padding or duplicate vectors to hit a size.
        for (let i = 0; i < paragraph.length; i += 600) {
          const text = paragraph.slice(i, i + 600);
          if (text.length >= 200) chunks.push(text);
        }
      }
      articles.push({ title: page.title, pageid: page.pageid, revision,
        url: `https://en.wikipedia.org/?curid=${page.pageid}`, chunks });
    }
    continuation = body.continue;
    await new Promise(resolve => setTimeout(resolve, 250)); // Wikipedia is rate-limited, not unlimited.
    } while (continuation);
  }
  const passages = [], seen = new Set();
  // Round-robin articles rather than taking 10k adjacent excerpts from a few topics.
  for (let i = 0; passages.length < 10040 && articles.some(a => a.chunks[i]); i++) {
    for (const article of articles) {
      const text = article.chunks[i];
      if (!text || seen.has(text) || passages.length === 10040) continue;
      seen.add(text);
      passages.push({ title: article.title, pageid: article.pageid, revision: article.revision, url: article.url, text });
    }
  }
  if (passages.length < 5040) throw new Error(`Only ${passages.length} passages; need at least 5040, no paid request sent`);
  corpus = Buffer.from(JSON.stringify({ retrievedAt: new Date().toISOString(), passages }));
  await writeFile(new URL('passages.json', dir), corpus, { flag: 'wx' });
}
const { passages, retrievedAt } = JSON.parse(corpus);
const sourceHash = hash(corpus);
const sourceIdentity = { model, dimensions, sourceHash };
const previous = await exists('identity.json');
if (previous && JSON.stringify(JSON.parse(previous)) !== JSON.stringify(sourceIdentity)) throw new Error('Cache identity mismatch; use a new cache directory');
if (!previous) await writeFile(new URL('identity.json', dir), JSON.stringify(sourceIdentity), { flag: 'wx' });
const upperTokenBound = passages.reduce((n, p) => n + Buffer.byteLength(p.text), 0);
if (upperTokenBound / 1e6 * pricePerMillionTokens > maxEstimatedUSD) throw new Error('Estimated budget exceeded before API calls');
console.log(`Prepared ${passages.length} real passages; first 40 held out. Estimated cost <= $${(upperTokenBound / 1e6 * pricePerMillionTokens).toFixed(4)} at $${pricePerMillionTokens}/million tokens (UTF-8-byte upper bound).`);
if (!process.argv.includes('--embed')) {
  console.log('No API request sent. Rerun with --embed to authorize this bounded spend.');
  process.exit(0);
}
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing; no API request sent');
const vectors = [], usages = [];
for (let start = 0; start < passages.length; start += 64) {
  const file = `batch-${start}.json`, pending = `${file}.pending`;
  let cached = await exists(file);
  if (!cached) {
    // Ambiguous failures must not silently repeat a potentially billed request.
    if (await exists(pending)) throw new Error(`Unresolved paid request ${pending}; inspect provider usage before explicitly clearing the marker`);
    await writeFile(new URL(pending, dir), JSON.stringify({ start, at: new Date().toISOString() }), { flag: 'wx' });
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, dimensions, encoding_format: 'float', input: passages.slice(start, start + 64).map(p => p.text) }),
        signal: AbortSignal.timeout(90000),
      });
    } catch { throw new Error(`Embedding transport failure at batch ${start}; request NOT retried, pending marker retained`); }
    if (!response.ok) throw new Error(`Embedding HTTP ${response.status} at batch ${start}; body intentionally not logged; request NOT retried`);
    const body = await response.json();
    const embeddings = body.data?.sort((a, b) => a.index - b.index).map(row => row.embedding);
    if (!embeddings || embeddings.length !== passages.slice(start, start + 64).length || embeddings.some(v => v.length !== dimensions || v.some(x => !Number.isFinite(x)) || !v.some(x => x !== 0))) throw new Error('Invalid embedding response; pending marker retained');
    cached = Buffer.from(JSON.stringify({ model: body.model, embeddings, usage: body.usage }));
    const handle = await open(new URL(`${file}.tmp`, dir), 'w');
    try { await handle.writeFile(cached); await handle.sync(); } finally { await handle.close(); }
    await rename(new URL(`${file}.tmp`, dir), new URL(file, dir));
    console.log(`Cached ${Math.min(start + 64, passages.length)}/${passages.length}`);
  }
  const batch = JSON.parse(cached);
  if (batch.model !== model || !Number.isSafeInteger(batch.usage?.total_tokens)) throw new Error('Unexpected model/usage in cache');
  vectors.push(...batch.embeddings);
  usages.push(batch.usage.total_tokens);
}
const bytes = Buffer.from(new Float32Array(vectors.flat()).buffer);
await writeFile(new URL('embeddings.f32', dir), bytes);
const articles = [...new Map(passages.map(({ title, pageid, revision, url }) => [pageid, { title, pageid, revision, url }])).values()];
await writeFile(new URL('source.json', dir), JSON.stringify({
  realVectors: true, shipsGroundTruth: false, model, dimensions, rows: vectors.length,
  source: 'Wikipedia public article extracts, nonoverlapping 200–600 character spans, round-robin across articles',
  sourceHash, vectorSha256: hash(bytes), retrievedAt, articles,
  license: 'Wikipedia text CC BY-SA 4.0; attribution and revision IDs above; no text committed in report',
  licenseUrl: 'https://en.wikipedia.org/wiki/Wikipedia:Copyrights',
  groundTruth: 'First 40 passage embeddings held out as queries; exact cosine truth independently computed against remaining rows',
  tokenUsage: usages.reduce((a, b) => a + b, 0), pricePerMillionTokens,
  estimatedCostUSD: usages.reduce((a, b) => a + b, 0) / 1e6 * pricePerMillionTokens,
  maxEstimatedUSD, pricingSource: 'https://openai.com/api/pricing/',
  costCondition: 'Published-price estimate from API usage, not an invoice; no automatic retries',
}, null, 2));
console.log('Cached real embeddings and model/usage metadata; credential never persisted.');
