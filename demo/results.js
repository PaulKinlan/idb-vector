// The search panel is described here as plain data and rendered by app.js, so both of its states —
// ranked passages and the zero-result answer — are testable without a browser
// (tests/unit/results-view.test.mjs). The empty state exists because an empty <ol> under a timing
// line reads as "still loading" or "broken" rather than "nothing matched" (idb-vector-1m0).
export const NO_MATCH_HEADING = 'No passages matched that question';

export function resultsView(results, query) {
  if (results.length === 0) {
    return {
      summary: 'No passages matched that question.',
      empty: {
        heading: NO_MATCH_HEADING,
        body: `No result came back for “${query}”: the search ran and found nothing stored, so this is not a loading state. Try a broader question, or reload the page to re-check what this browser still has.`,
      },
      items: [],
    };
  }
  return {
    summary: `${results.length} ${results.length === 1 ? 'passage' : 'passages'}, closest first.`,
    empty: null,
    items: results.map(({ object, similarity }) => ({
      title: object.title,
      href: `https://en.wikipedia.org/w/index.php?oldid=${object.revision}`,
      text: object.text,
      score: `Cosine similarity ${similarity.toFixed(4)} · cosine distance (1 − similarity) ${(1 - similarity).toFixed(4)}`,
      sourceText: 'Wikipedia contributors / history',
      sourceHref: `https://en.wikipedia.org/w/index.php?curid=${object.pageid}&action=history`,
    })),
  };
}
