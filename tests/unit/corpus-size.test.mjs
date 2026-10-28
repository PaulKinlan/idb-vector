// #size is a <select> of the corpora the page ships, but the store outlives demo versions, so a
// valid stored corpus can have a count no option matches (idb-vector-z7q7). These are unit-level
// because both halves of the rule are one pure function each: which option to select, and which two
// corpus URLs Load may request. The demo gate still drives the page end to end.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { corpusFiles, nearestCorpusSize } from '../../demo/corpus-size.js';

const html = readFileSync('demo/index.html', 'utf8');
const app = readFileSync('demo/app.js', 'utf8');
const pins = new Set(JSON.parse(readFileSync('demo/assets.json', 'utf8')).map(entry => entry.file));

const offeredSizes = () => [...html.matchAll(/<option value="(\d+)"/g)].map(match => Number(match[1]));

test('the select is given one of the sizes its own markup offers, for any stored count', () => {
  const sizes = offeredSizes();
  assert.deepEqual(sizes, [250, 2000], 'the markup offers the two published corpora');
  for (const size of sizes) assert.equal(nearestCorpusSize(size, sizes), size, 'a matching option is selected unchanged');
  // The defect: count=2 is a valid stored corpus, but no option matches it.
  assert.equal(nearestCorpusSize(2, sizes), 250);
  assert.equal(nearestCorpusSize(249, sizes), 250);
  assert.equal(nearestCorpusSize(1125, sizes), 250, 'a tie picks the smaller corpus');
  assert.equal(nearestCorpusSize(1126, sizes), 2000);
  assert.equal(nearestCorpusSize(3000, sizes), 2000);
  // Absent or unusable counts (an empty store, a hand-written meta record) still select an option.
  for (const count of ['', undefined, null, 0, -1, 1.5, NaN, Infinity]) {
    assert.equal(nearestCorpusSize(count, sizes), 250, String(count));
  }
  for (let count = 1; count <= 3000; count++) {
    assert.ok(sizes.includes(nearestCorpusSize(count, sizes)), `count ${count} selects an offered option`);
  }
  // Sizes arrive as the select's own option values, which are strings.
  assert.equal(nearestCorpusSize('2', ['250', '2000']), 250);
  assert.throws(() => nearestCorpusSize(2, []), /no size to select/);
});

test('Load can only ask for a corpus this page publishes and pins', () => {
  for (const size of offeredSizes()) {
    const files = corpusFiles(size);
    assert.equal(files.count, size);
    assert.equal(files.passages.url, `./data/passages-${size}.json`);
    assert.equal(files.vectors.url, `./data/vectors-${size}.f32`);
    // integrity.js looks the pin up by its site-relative path, fetch by the page-relative one.
    assert.equal(files.passages.path, `data/passages-${size}.json`);
    assert.equal(files.vectors.path, `data/vectors-${size}.f32`);
    assert.ok(pins.has(files.passages.path), `${files.passages.path} is pinned in assets.json`);
    assert.ok(pins.has(files.vectors.path), `${files.vectors.path} is pinned in assets.json`);
  }
  // The defect's request: an unselected #size reads '' and Number('') is 0.
  for (const size of ['', '0', 0, undefined, null, -250, 2.5, NaN, 'abc']) {
    assert.throws(() => corpusFiles(size), /No corpus size is selected/, String(size));
  }
  assert.doesNotMatch(JSON.stringify(corpusFiles(250)), /passages-0/, 'no URL is built from a zero count');
});

test('the demo selects through nearestCorpusSize and builds corpus URLs through corpusFiles', () => {
  assert.match(app, /import \{ corpusFiles, nearestCorpusSize \} from '\.\/corpus-size\.js'/);
  assert.ok(app.includes("nearestCorpusSize(count, [...$('size').options].map(option => option.value))"), 'the offered sizes come from the markup');
  assert.ok(app.includes("$('size').value = String(size);"), 'the select is set from that choice');
  assert.doesNotMatch(app, /\$\('size'\)\.value = String\((meta\.)?count\)/, 'the stored count is not written straight into the select');
  assert.ok(app.includes("corpusFiles($('size').value)"), 'Load reads #size through corpusFiles()');
  assert.doesNotMatch(app, /fetch\(`\.\/data\//, 'the corpus fetch URLs come from corpusFiles()');
  assert.doesNotMatch(app, /verifyBytes\(manifest, `data\//, 'the pinned paths come from corpusFiles()');
});
