// The search panel is described here as plain data and rendered by app.js, so both of its states —
// ranked passages and the zero-result answer — are testable without a browser
// (tests/unit/results-view.test.mjs). The empty state exists because an empty <ol> under a timing
// line reads as "still loading" or "broken" rather than "nothing matched" (idb-vector-1m0).
//
// Stored records are checked before they reach the panel (demo/record-validation.js): a record that
// fails is withheld and counted, and when nothing usable is left the panel says so instead of
// claiming that the search found nothing (idb-vector-4skw).
import { validateRecord } from './record-validation.js';

export const NO_MATCH_HEADING = 'No passages matched that question';
export const WITHHELD_HEADING = 'Stored passages could not be shown';

const passages = (count) => `${count} ${count === 1 ? 'passage' : 'passages'}`;
const withheldNote = (problems) => `${passages(problems.length)} withheld from these results: ${problems[0]}.`;

function item(object, similarity) {
  return {
    title: object.title,
    href: `https://en.wikipedia.org/w/index.php?oldid=${object.revision}`,
    text: object.text,
    score: `Cosine similarity ${similarity.toFixed(4)} · cosine distance (1 − similarity) ${(1 - similarity).toFixed(4)}`,
    sourceText: 'Wikipedia contributors / history',
    sourceHref: `https://en.wikipedia.org/w/index.php?curid=${object.pageid}&action=history`,
  };
}

export function resultsView(results, query) {
  const items = [], problems = [];
  for (const { object, similarity } of results) {
    const problem = validateRecord(object);
    if (problem === null) items.push(item(object, similarity));
    else problems.push(problem);
  }
  if (items.length > 0) {
    const summary = `${passages(items.length)}, closest first.`;
    return { summary: problems.length ? `${summary} ${withheldNote(problems)}` : summary, empty: null, items };
  }
  if (problems.length > 0) {
    return {
      summary: `${passages(problems.length)} could not be shown: ${problems[0]}.`,
      empty: {
        heading: WITHHELD_HEADING,
        body: `The ${passages(problems.length)} that matched “${query}” failed validation (${problems[0]}), so none is drawn: a partial passage row would put a wrong title, text or link in front of a reader. Press Remove this demo’s local data and load the corpus again to repair it.`,
      },
      items,
    };
  }
  return {
    summary: 'No passages matched that question.',
    empty: {
      heading: NO_MATCH_HEADING,
      body: `No result came back for “${query}”: the search ran and found nothing stored, so this is not a loading state. Try a broader question, or reload the page to re-check what this browser still has.`,
    },
    items,
  };
}
