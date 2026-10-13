// Explicit publishers of citations in research/architecture.md. This opt-in
// checker must not contact new hosts merely because a Markdown link was added.
const citationHosts = new Set([
  'arxiv.org', 'caniuse.com', 'dev.to', 'emscripten.org', 'github.com',
  'jmlr.org', 'nolanlawson.com', 'patrickbrosset.com', 'pglite.dev',
  'raw.githubusercontent.com', 'stevenic.github.io', 'suhasjs.github.io',
  'vldb.org', 'web.dev', 'www.npmjs.com', 'www.vldb.org',
]);

export function permittedCitation(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
      !parsed.port && citationHosts.has(parsed.hostname);
  } catch { return false; }
}
