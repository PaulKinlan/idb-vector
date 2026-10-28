// The #size select offers the corpora this page ships (demo/index.html), but the store outlives demo
// versions: IndexedDB keeps whatever corpus size an earlier visit loaded under the same dbName, and
// that count need not be one of today's options. The restore probe used to write the stored count
// straight into the select (idb-vector-z7q7), which matched no <option>, so #size had no selection,
// Load read Number('') = 0 and requested ./data/passages-0.json. Both halves of that rule are plain
// functions here so tests/unit/corpus-size.test.mjs can hold them without a browser: the select is
// always given an option the markup actually offers, and the corpus URLs cannot be built from a
// count that is not a corpus size.
export function nearestCorpusSize(storedCount, availableSizes) {
  const sizes = availableSizes.map(Number).filter(size => Number.isSafeInteger(size) && size > 0).sort((a, b) => a - b);
  // Every caller reads the sizes from this page's own markup, so an empty list is a broken page, not
  // a state to recover from: refuse rather than hand back a value that would empty the select again.
  if (!sizes.length) throw new Error('No corpus size is offered, so there is no size to select');
  const count = Number(storedCount);
  if (!Number.isSafeInteger(count) || count <= 0) return sizes[0];
  // Closest offered size; a tie picks the smaller corpus, which is also the one that downloads less.
  return sizes.reduce((best, size) => (Math.abs(size - count) < Math.abs(best - count) ? size : best), sizes[0]);
}

// `size` is #size's value, so it is a string from the DOM and may be '' when nothing is selected.
// The two paths differ only in their prefix: fetch() takes the page-relative './data/…' while
// assets.json pins the site-relative 'data/…' that integrity.js looks up.
export function corpusFiles(size) {
  const count = Number(size);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('No corpus size is selected, so there is nothing to load');
  }
  return {
    count,
    passages: { url: `./data/passages-${count}.json`, path: `data/passages-${count}.json` },
    vectors: { url: `./data/vectors-${count}.f32`, path: `data/vectors-${count}.f32` },
  };
}
