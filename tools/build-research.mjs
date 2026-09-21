// Build-time only: marked parses GFM; the published report needs no JS or dependencies.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('research/architecture.md', root), 'utf8');
const headings = [];
const ids = new Set();
const parser = new Marked({ gfm: true, renderer: {
  heading({ tokens, depth }) {
    const label = this.parser.parseInline(tokens);
    const base = label.replace(/<[^>]*>/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
    let id = base;
    for (let suffix = 2; ids.has(id); suffix++) id = `${base}-${suffix}`;
    ids.add(id);
    headings.push({ depth, id, label });
    return `<h${depth} id="${id}">${label}</h${depth}>\n`;
  },
  html({ text }) {
    // Research is text, not executable HTML. Preserve raw tags as visible source text.
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  },
} });
const body = parser.parse(source)
  .replace(/<code>(\[(?:established|measured|one paper|contested|inference)[\s\S]*?\])<\/code>/g, '<code class="evidence">$1</code>')
  .replace(/<table>/g, '<div class="table-scroll" role="region" aria-label="Research comparison table" tabindex="0"><table>')
  .replace(/<\/table>/g, '</table></div>');
const toc = headings.filter(h => h.depth === 2 || h.depth === 3)
  .map(h => `<li class="level-${h.depth}"><a href="#${h.id}">${h.label}</a></li>`).join('\n');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="description" content="Browser vector search research: IndexedDB, HNSW, WebGPU and anisotropy. Evidence labels, contradictions, sources and unmeasured hypotheses.">
<title>idb-vector architecture research</title>
<style>
:root { color-scheme: light dark; --bg: #fafaf7; --ink: #202727; --muted: #465555; --link: #00589b; --panel: #edf1ef; --line: #bac7c2; --note: #fff4d8; }
@media (prefers-color-scheme: dark) { :root { --bg: #151b1c; --ink: #e7efed; --muted: #b7c7c4; --link: #85caff; --panel: #222d2e; --line: #596c67; --note: #322c1d; } }
* { box-sizing: border-box; }
html { scroll-padding-top: 1rem; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 1.0625rem/1.7 system-ui, sans-serif; }
main, header, footer { max-width: 80ch; margin: auto; padding: 1.5rem; }
header { border-bottom: 1px solid var(--line); }
header p, footer { color: var(--muted); }
a { color: var(--link); text-underline-offset: .18em; overflow-wrap: anywhere; }
a:focus-visible, [tabindex]:focus-visible { outline: 3px solid var(--link); outline-offset: 4px; }
h1, h2, h3 { line-height: 1.25; text-wrap: balance; }
h1 { font-size: clamp(1.9rem, 5vw, 2.7rem); }
h2 { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); }
h3 { margin-top: 2rem; }
p, li { overflow-wrap: anywhere; }
li { margin-block: .45rem; }
code { font: .88em/1.6 ui-monospace, monospace; background: var(--panel); padding: .12em .25em; border-radius: .2em; overflow-wrap: anywhere; }
pre { padding: 1rem; background: var(--panel); overflow-x: auto; }
pre code { padding: 0; }
.evidence { border: 1px solid var(--line); font-weight: 600; }
.notice { padding: 1rem 1.25rem; background: var(--note); border-left: 4px solid var(--line); }
.notice h2 { margin: 0; padding: 0; border: 0; font-size: 1.2rem; }
nav { background: var(--panel); padding: 1rem; margin-block: 2rem; }
nav h2 { margin: 0; padding: 0; border: 0; }
nav ul { list-style: none; padding: 0; }
nav .level-3 { padding-left: 1.2rem; font-size: .95em; }
nav a { display: inline-block; padding-block: .2rem; }
.table-scroll { max-width: 100%; overflow-x: auto; margin-block: 1.5rem; border: 1px solid var(--line); }
table { border-collapse: collapse; width: 100%; font-size: .92rem; line-height: 1.55; }
th, td { text-align: left; vertical-align: top; padding: .75rem; border-bottom: 1px solid var(--line); min-width: 10rem; }
th { background: var(--panel); }
blockquote { margin-inline: 0; padding-left: 1rem; border-left: 3px solid var(--line); }
hr { border: 0; border-top: 1px solid var(--line); margin-block: 2rem; }
:target { outline: 2px solid var(--link); outline-offset: .25rem; }
@media (max-width: 480px) { main, header, footer { padding: 1rem; } ul, ol { padding-left: 1.35rem; } }
@media print { nav, .skip { display: none; } .table-scroll { overflow: visible; } th, td { min-width: 0; } }
</style>
</head>
<body>
<header id="top">
<a class="skip" href="#report">Skip to report</a>
<p><a href="../demo/">Wikipedia search demo</a> · <a href="https://github.com/PaulKinlan/idb-vector">idb-vector on GitHub</a></p>
<p>Research snapshot · 21 September 2026 · <a href="./architecture.md">Markdown source</a></p>
</header>
<main>
<aside class="notice" aria-labelledby="reading-notes">
<h2 id="reading-notes">Read the evidence, not just the headline</h2>
<p>This is the original research snapshot, not a report of shipped library improvements. The original recommendations are preserved below, including disagreements and missing evidence.</p>
<ul>
<li><strong>Performance estimates are not measurements.</strong> The ~666 ms IndexedDB / ~130 ms arithmetic split is a cross-source inference, not a timed decomposition. The 6–51 ms GPU upload range is extrapolated from other hardware and APIs. Neither establishes a speedup on this library.</li>
<li><strong>Measurement conditions matter.</strong> The local synthetic baseline used Chromium 152 on a Ryzen 9955HX, 128 dimensions, k=10 and medians of three runs. Other projects used different corpora, dimensions, hardware and recall tests, identified alongside their tables. These are not head-to-head results.</li>
<li><strong>IndexedDB supports keyed random access.</strong> The question is its measured cost for this workload, not whether the API permits it. HNSW at 128 dimensions remains unmeasured here; memory and device limits vary.</li>
<li><strong>Whitening is a developer choice, not a default.</strong> The owner requested an opt-in transformation on 21 September. The cited single-paper correlation results do not establish retrieval recall gains or a universal diagnostic threshold. Whitening, mean-centring and removing top principal components are different transformations; evaluate each on the target corpus and queries.</li>
<li><strong>Publication caveats.</strong> The post-filter example demonstrates global-top-k-then-filter failure, not a blanket library defect. Asynchronous persistence and arbitrary memory ceilings below are proposals, not adopted durability or resource policies. Browser support and third-party claims are dated, not independently reverified for this publication.</li>
</ul>
<p><strong>[measured] Follow-up, 21 September 2026:</strong> <a href="https://github.com/PaulKinlan/idb-vector/blob/232b95c0215dab48d760bef6c2cf7e88186f4780/reports/packed-read.json">Raw measurements at commit 232b95c</a> and <a href="https://github.com/PaulKinlan/idb-vector/blob/232b95c0215dab48d760bef6c2cf7e88186f4780/reports/packed-read.md">method and limitations</a> now test the packing hypothesis. Fresh headless Chromium 152.0.7977.82, Ryzen 9 9955HX, seeded synthetic 100,000 × 128 coordinates, warm IDB after committed writes, three rotated repetitions; not cold disk or an isolated host.</p>
<ul>
<li>Median packed read: <strong>31.4 ms for 51.2 MB Float32</strong>, <strong>93.6 ms for 102.4 MB Float64</strong>; individual JS-array records with 1,000-row getAll pages: <strong>742.9 ms</strong>.</li>
<li>Resident Float64 cosine arithmetic: <strong>8.6 ms, excluding top-k</strong>, rather than the original cross-source ~130 ms estimate. These separate operations do not constitute an end-to-end cached query measurement or an exact profiler decomposition.</li>
<li>Float32 rounds the original JS numbers. The existing library does <strong>not</strong> normalize on write, contrary to the proposed contract below; Float64 preserves stored coordinate precision at twice the payload size. Packing is supported as an experiment, not proof that an index or GPU is unnecessary.</li>
</ul>
<p><strong>Citation access check, 21 September 2026:</strong> 48 of 49 distinct external targets returned HTTP 200. The npm Vectra citation returned 403 and a browser security challenge; its <a href="https://stevenic.github.io/vectra/storage.html">separate documentation citation</a> loaded. Original links are retained. Successful loading does not independently validate a source's claims.</p>
<p>The internal supervisor appendix is omitted and the local baseline path made repository-relative; the research body, evidence labels, tables and citation links are otherwise preserved.</p>
</aside>
<nav aria-labelledby="contents"><h2 id="contents">Contents</h2><ul>${toc}</ul></nav>
<article id="report">${body}</article>
</main>
<footer><a href="#top">Back to top</a> · Generated from Markdown with <code>npm run build:research</code>. No client-side JavaScript, external fonts or runtime dependencies.</footer>
</body>
</html>
`;
const output = fileURLToPath(new URL('research/index.html', root));
await writeFile(output, html);
console.log(`Generated ${output} (${headings.length} headings)`);
