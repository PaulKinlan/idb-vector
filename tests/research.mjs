// Real Chromium/CDP acceptance. RESEARCH_URL can target the published /research/ after deployment.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { Marked } from 'marked';
import { launch } from './lib/cdp.mjs';

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
const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + sep)) throw new Error('outside root');
    const content = await readFile(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.md': 'text/plain', '.js': 'text/javascript', '.json': 'application/json' })[extname(file)] || 'application/octet-stream');
    res.end(content);
  } catch { res.writeHead(404).end('Not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = process.env.RESEARCH_URL || `http://127.0.0.1:${server.address().port}/research/`;
const evidence = process.env.RESEARCH_EVIDENCE || resolve(root, '.cache/research-evidence');
await mkdir(evidence, { recursive: true });
const page = await launch();
const receipt = { url, browser: (await page.send('Browser.getVersion')).product, checks: [] };
try {
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
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
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
  receipt.ok = true;
} finally {
  await writeFile(resolve(evidence, 'browser.json'), JSON.stringify(receipt, null, 2) + '\n');
  await page.close();
  await new Promise(r => server.close(r));
}
console.log(JSON.stringify(receipt, null, 2));
