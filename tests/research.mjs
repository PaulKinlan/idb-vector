// Real Chromium/CDP acceptance. RESEARCH_URL can target the published /research/ after deployment.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { Marked } from 'marked';
import { launch } from './lib/cdp.mjs';
import { permittedCitation } from './lib/research-link-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const source = await readFile(resolve(root, 'research/architecture.md'), 'utf8');
const links = [], headings = [];
let tables = 0;
const markdown = new Marked({ walkTokens(token) {
  if (token.type === 'link') links.push(token.href);
  if (token.type === 'heading') headings.push(token.depth);
  if (token.type === 'table') tables++;
} });
markdown.parse(source);
// The report links to its Markdown source and to the demo landing page. A page is only a page if the
// stylesheet and modules it loads are served with it, so the demo's own directory and the library
// modules it imports are allowed too; with only /demo/index.html allowed, `/demo/` returned 200 while
// rendering unstyled and with no script, and the receipt still advertised it as a healthy link
// (idb-vector-zyd). Everything else in the worktree stays unreachable: exact files for the report,
// directory prefixes for the demo's module closure, and nothing for the repo root, node_modules,
// .git, .cache, tests or tools.
const assetFiles = new Map([
  ['/research/index.html', resolve(root, 'research/index.html')],
  ['/research/architecture.md', resolve(root, 'research/architecture.md')],
  ['/index.js', resolve(root, 'index.js')],
]);
const assetDirs = ['/demo/', '/utils/'];
// Resolve first, then compare against the allowed directory: the handler decodes no escapes, but a
// resolved path that climbed out of its allowed directory with `..` must still be refused here.
const insideAssetDir = (file) => assetDirs.some((prefix) => file.startsWith(resolve(root, prefix.slice(1)) + sep));
const server = createServer(async (req, res) => {
  try {
    const requested = new URL(req.url, 'http://localhost').pathname;
    const path = requested.endsWith('/') ? requested + 'index.html' : requested;
    let file = assetFiles.get(path);
    if (!file) {
      const candidate = resolve(root, '.' + path);
      if (insideAssetDir(candidate) && candidate.startsWith(root + sep)) file = candidate;
    }
    if (!file) throw new Error('not an acceptance asset');
    const content = await readFile(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.md': 'text/plain', '.js': 'text/javascript', '.json': 'application/json' })[extname(file)] || 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404).end('Not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const localUrl = `http://127.0.0.1:${server.address().port}`;
const url = process.env.RESEARCH_URL || `${localUrl}/research/`;
const evidence = process.env.RESEARCH_EVIDENCE || resolve(root, '.cache/research-evidence');
await mkdir(evidence, { recursive: true });
const page = await launch();
const receipt = { url, browser: (await page.send('Browser.getVersion')).product, checks: [] };
try {
  // Exercise the actual loopback server even when RESEARCH_URL points at a deployment. The allowed
  // set is asserted down to the demo's stylesheet and module entry point, so "the demo link works"
  // is a claim the server can back (idb-vector-zyd).
  for (const path of [
    '/research/',
    '/research/architecture.md',
    '/demo/',
    '/demo/style.css',
    '/demo/app.js',
    '/demo/ua.js',
    '/demo/integrity.js',
    '/index.js',
    '/utils/side-store.js',
  ]) {
    const response = await fetch(localUrl + path);
    assert.equal(response.status, 200, `allowed acceptance asset: ${path}`);
    await response.body?.cancel();
  }
  // Every deny path must name a file that EXISTS in this checkout and is outside the allowlist. A
  // path that cannot resolve even without the allowlist returns 404 either way, so it proves nothing
  // (idb-vector-7iu). Assert the fixture first, so a missing file fails loudly instead of quietly
  // turning the deny list back into a no-op.
  const denyFiles = [
    '/package.json',
    '/package-lock.json',
    '/README.md',
    '/tests/research.mjs',
    '/tools/build-research.mjs',
  ];
  // `/.git/config` only resolves where `.git` is a real directory; in a lane worktree it is a
  // pointer file, so probing it unconditionally is exactly the vacuous assertion this replaces.
  if ((await stat(resolve(root, '.git'))).isDirectory()) denyFiles.push('/.git/config');
  for (const path of denyFiles) {
    const exists = await stat(resolve(root, '.' + path)).then(() => true, () => false);
    assert.ok(exists, `deny-path fixture must exist in this checkout, or the 404 below proves nothing: ${path}`);
    const response = await fetch(localUrl + path);
    assert.equal(response.status, 404, `private worktree path: ${path}`);
    await response.body?.cancel();
  }
  // Encoded traversal is refused by resolving before the allowlist check, not by a string prefix
  // test, so probe it rather than assuming it. Both of these escape an allowed directory into a file
  // that EXISTS, which is what makes the 404 meaningful: the pre-fix handler answered 200 for both.
  for (const path of ['/research/%2e%2e/package.json', '/demo/%2e%2e/package.json']) {
    const response = await fetch(localUrl + path);
    assert.equal(response.status, 404, `encoded traversal out of an allowed directory: ${path}`);
    await response.body?.cancel();
  }
  // Root confinement is NOT a discriminator for the allowlist change (both handlers refuse a path
  // outside the worktree), so it is asserted as the invariant it is, not counted as coverage of the
  // fix: this fails only if a future handler drops the root check.
  for (const path of ['/%2e%2e/%2e%2e/etc/passwd', '/../etc/passwd']) {
    const response = await fetch(localUrl + path);
    assert.equal(response.status, 404, `path outside the worktree root: ${path}`);
    await response.body?.cancel();
  }
  receipt.checks.push({ localAssetAllowlist: true, deniedPaths: denyFiles.length, traversalRefused: 2, rootConfinement: 2 });
  await page.goto(url);
  const content = await page.evaluate(() => {
    const article = document.querySelector('article');
    return {
      title: document.title,
      links: [...article.querySelectorAll('a')].map(a => a.getAttribute('href')),
      headings: [...article.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => Number(h.tagName.slice(1))),
      tables: article.querySelectorAll('table').length,
      labels: [...article.querySelectorAll('code.evidence')].map(c => c.textContent),
      ids: [...document.querySelectorAll('[id]')].map(h => h.id),
      text: article.textContent,
    };
  });
  assert.match(content.title, /architecture research/);
  assert.deepEqual(content.links, links, 'every citation target preserved, including duplicates');
  assert.deepEqual(content.headings, headings, 'all source headings preserved');
  assert.equal(new Set(content.ids).size, content.ids.length, 'unique anchors');
  assert.equal(content.tables, tables, 'all source tables preserved');
  for (const label of ['established', 'measured', 'one paper', 'contested', 'inference']) {
    assert(content.labels.some(x => x.includes(label)), `${label} remains visible`);
  }
  for (const section of ['Contradictions', 'Missing evidence', '100k', '128', '1536', '384']) assert(content.text.includes(section));
  receipt.checks.push({ citationsPreserved: links.length, headingsPreserved: headings.length, tables: content.tables, evidenceLabels: content.labels.length });
  for (const width of [1280, 390]) {
    await page.emulateViewport({ width, height: 844, mobile: width === 390, scale: 1 });
    for (const scheme of ['light', 'dark']) {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
      const layout = await page.evaluate(() => ({
        width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        background: getComputedStyle(document.body).backgroundColor,
        scrollableTables: [...document.querySelectorAll('.table-scroll')].filter(t => t.scrollWidth > t.clientWidth).length,
      }));
      assert(layout.scrollWidth <= width, `no page overflow at ${width}px`);
      assert.equal(layout.background, scheme === 'light' ? 'rgb(250, 250, 247)' : 'rgb(21, 27, 28)');
      await page.screenshot(resolve(evidence, `${width}-${scheme}.png`));
      receipt.checks.push({ width, scheme, ...layout });
    }
  }
  // Drive actual pointer clicks for every TOC entry, not just URL/hash assignment.
  await page.emulateViewport({ width: 1280, height: 844, mobile: false, scale: 1 });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  const anchors = await page.evaluate(() => [...document.querySelectorAll('nav a')].map(a => a.getAttribute('href')));
  for (const href of anchors) {
    const point = await page.evaluate(href => {
      const a = [...document.querySelectorAll('nav a')].find(a => a.getAttribute('href') === href);
      a.scrollIntoView({ block: 'center' });
      const r = a.getBoundingClientRect();
      return { x: r.x + 6, y: r.y + r.height / 2 };
    }, href);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    const target = await page.evaluate(() => ({ hash: location.hash, top: document.querySelector(':target')?.getBoundingClientRect().top }));
    assert.equal(target.hash, href);
    assert(target.top >= 0 && target.top < 120, `anchor scrolled into view: ${href}`);
  }
  receipt.checks.push({ anchorsClicked: anchors.length });
  const localLinks = await page.evaluate(async () => {
    const links = [...document.querySelectorAll('header a')].filter(a => !a.hash && a.origin === location.origin);
    return Promise.all(links.map(async a => ({ url: a.href, status: (await fetch(a.href)).status })));
  });
  for (const link of localLinks) assert.equal(link.status, 200, link.url);
  receipt.checks.push({ localLinks });
  await page.screenshot(resolve(evidence, 'anchor-sources.png'));
  if (process.argv.includes('--links')) {
    const pending = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="https:"]')].map(a => a.href))]);
    const responses = [];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (pending.length) {
        const url = pending.shift();
        if (!permittedCitation(url)) {
          responses.push({ url, error: 'Citation host not allowlisted; not fetched' });
          continue;
        }
        try {
          // Never follow a publisher redirect into an unapproved network target.
          const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'manual' });
          responses.push({ url, finalUrl: response.url, status: response.status });
          await response.body?.cancel();
        } catch (error) { responses.push({ url, error: error.message }); }
      }
    }));
    receipt.externalLinks = responses.sort((a, b) => a.url.localeCompare(b.url));
    // Keep source citations intact even when publishers refuse automated requests.
    // Record each failure rather than treating a successful local render as link verification.
    receipt.externalLinkFailures = responses.filter(r => !r.status || r.status >= 400);
    for (const external of [
      'https://github.com/jasonmayes/VectorSearch.js',
      'https://arxiv.org/html/2407.01972',
      'https://github.com/PaulKinlan/idb-vector/blob/232b95c0215dab48d760bef6c2cf7e88186f4780/reports/packed-read.json',
    ]) {
      await page.goto(external);
      const visited = await page.evaluate(() => ({ url: location.href, title: document.title, textLength: document.body.innerText.length }));
      assert.equal(visited.url, external);
      assert(visited.textLength > 200 && !/privacy error|site can.t be reached/i.test(visited.title));
      receipt.checks.push({ externalBrowserVisit: visited });
    }
  }
  // The header's demo link is only honest if the page behind it is a page. Load it for real and
  // require the module to have executed (app.js sets #connection from navigator.onLine before any
  // user action) and the stylesheet to have applied; with only /demo/index.html served both were
  // missing and the receipt still recorded status 200 (idb-vector-zyd). Last in the run, because it
  // navigates the shared page away from the report the checks above read.
  await page.goto(`${localUrl}/demo/`);
  const demo = await page.evaluate(() => ({
    connection: document.getElementById('connection')?.textContent ?? '',
    stylesheets: [...document.styleSheets].map((sheet) => ({ href: sheet.href, rules: sheet.cssRules?.length ?? 0 })),
  }));
  assert.match(
    demo.connection,
    /online|offline/,
    `demo/app.js did not run, so a module it imports is not served with the page: ${JSON.stringify(demo)}`,
  );
  assert.ok(
    demo.stylesheets.some((sheet) => sheet.href?.endsWith('/demo/style.css') && sheet.rules > 0),
    `demo/style.css is not served or not applied: ${JSON.stringify(demo.stylesheets)}`,
  );
  receipt.checks.push({ demoBooted: true, demo });
  receipt.ok = true;
} finally {
  await writeFile(resolve(evidence, 'browser.json'), JSON.stringify(receipt, null, 2) + '\n');
  await page.close();
  await new Promise(r => server.close(r));
}
console.log(JSON.stringify(receipt, null, 2));
