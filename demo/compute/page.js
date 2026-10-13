import { experiment } from './experiment.js';
const status = document.querySelector('#status'), results = document.querySelector('#results');
const number = n => n.toFixed(3);
function element(tag, text, parent) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; parent?.append(node); return node; }
function render(report) {
  results.replaceChildren();
  element('h2', 'Conditions', results);
  element('p', `${report.corpus}; ${report.count} × ${report.dim}; ${report.bytes} bytes. ${report.browser}`, results);
  element('p', report.conditions, results);
  element('h2', 'Storage: one write and one read (ms)', results);
  const table = element('table', undefined, element('div', undefined, results)); table.parentNode.className = 'scroll';
  const head = element('tr', undefined, element('thead', undefined, table));
  for (const title of ['Layout', 'Write incl. commit/close', 'Read + materialise', 'Exact roundtrip']) element('th', title, head);
  const body = element('tbody', undefined, table);
  for (const [name, item] of Object.entries(report.storage)) {
    const row = element('tr', undefined, body);
    for (const value of [name, item.unavailable || number(item.writeMs), item.unavailable ? '—' : number(item.readMs), String(item.roundTripExact ?? 'unavailable')]) element('td', value, row);
  }
  element('h2', 'One-time engine setup', results);
  for (const [name, item] of Object.entries(report.engines)) element('p', `${name}: ${item.unavailable || `setup ${number(item.setupMs)} ms (includes upload/copy ${number(item.uploadMs)} ms)`}${item.adapter ? `; adapter ${JSON.stringify(item.adapter)}` : ''}`, results);
  for (const query of report.queries) {
    element('h2', `Query: ${query.query}`, results);
    const cards = element('div', undefined, results); cards.className = 'cards';
    for (const [name, result] of Object.entries(query.results)) {
      const card = element('article', undefined, cards), c = result.comparison;
      element('h3', name, card);
      element('p', `${number(result.ms)} ms; ordered match: ${c.orderedTopKMatch}; overlap: ${c.overlap}; max score error: ${c.maxAbsoluteScoreError.toExponential(3)} (${c.scoreErrorScope})`, card);
      element('pre', result.top.map(x => `${x.id}: ${x.score.toPrecision(9)}`).join('\n'), card);
    }
  }
}
document.querySelector('#controls').addEventListener('submit', async event => {
  event.preventDefault();
  document.querySelector('#run').disabled = true;
  document.querySelector('#download').hidden = true;
  window.computeReport = null; window.computeError = null;
  results.replaceChildren();
  try {
    const report = await experiment({ count: Number(document.querySelector('#count').value), dim: Number(document.querySelector('#dim').value), onProgress: text => { status.textContent = text; } });
    window.computeReport = report; render(report);
    const agreement = report.queries.every(q => Object.values(q.results).every(r => r.comparison.orderedTopKMatch));
    status.textContent = `Complete. ${agreement ? 'All available paths agree on ordered top-k.' : 'Top-k divergence detected; inspect results.'} ${report.engines.gpu.unavailable ? `WebGPU unavailable: ${report.engines.gpu.unavailable}` : ''}`;
    document.querySelector('#download').hidden = false;
  } catch (error) { window.computeError = error.message; status.textContent = `Failed: ${error.message}`; }
  finally { document.querySelector('#run').disabled = false; }
});
document.querySelector('#download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(window.computeReport, null, 2)], { type: 'application/json' }));
  const link = element('a'); link.href = url; link.download = 'cosine-compute.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
