import { dataset, vector, batched, timed, sameKeys, discard } from './experiment.js';
const $ = id => document.getElementById(id);
let data;
let busy = false;
function state(message) { $('status').textContent = message; }
function lock(value) {
  busy = value;
  $('generate').disabled = value;
  $('run').disabled = value || !data;
}
$('build').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  lock(true);
  state('Creating real IndexedDB records…');
  $('results').replaceChildren();
  $('timing').textContent = '';
  try {
    if (data) discard(data);
    data = null;
    data = await dataset(Number($('count').value), Number($('dimensions').value));
    state(`Ready: ${data.count.toLocaleString()} vectors × ${data.dimensions} dimensions. Library seed: ${data.seedMs.toFixed(1)} ms; candidate store seed: ${data.candidateSeedMs.toFixed(1)} ms.`);
  } catch (error) { state(`Dataset failed: ${error.message}`); }
  finally { lock(false); }
});
$('search').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !data) return;
  lock(true);
  state('Reading and scoring…');
  try {
    const query = vector(Number($('query').value), data.dimensions);
    const category = $('category').value === '' ? null : Number($('category').value);
    const baseline = await timed(() => data.library.query(query, { limit: 10 }));
    const candidate = await timed(() => batched(category === null ? data.raw : data.indexed, query, { category, index: category !== null }));
    const exact = category === null ? baseline.result : (await batched(data.indexed, query, { category })).results;
    if (!sameKeys(exact, candidate.result.results)) throw new Error('Candidate disagrees with exact reference');
    $('results').replaceChildren(...candidate.result.results.map(row => {
      const tr = document.createElement('tr');
      for (const value of [row.object.id, row.object.category, row.similarity.toFixed(6)]) {
        const td = document.createElement('td'); td.textContent = value; tr.append(td);
      }
      return tr;
    }));
    $('timing').textContent = `Global library scan: ${baseline.ms.toFixed(1)} ms\n${category === null ? 'Exact paged scan' : 'Exact category-index search'}: ${candidate.ms.toFixed(1)} ms; ${candidate.result.visited} records visited\nOrdered keys match exact reference: yes`;
    if (category !== null) $('timing').textContent += `\nNegative control: filter global top 10 afterwards → ${baseline.result.filter(row => row.object.category === category).length} results; filter before top-k → ${exact.length}.`;
    state('Search complete. Results and measured timings below.');
  } catch (error) { state(`Search failed: ${error.message}`); }
  finally { lock(false); }
});
addEventListener('pagehide', () => { if (data) discard(data); });
