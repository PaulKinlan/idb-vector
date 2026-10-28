// The search panel's two states are described as data (demo/results.js) and rendered by app.js, so
// the zero-result state is covered in the fast tier without a browser. The browser check
// (tests/unit/… is not where markup lives) is the demo gate's job; what is asserted here is that an
// empty result set produces a real answer, and that the ranked state did not change shape when the
// description moved out of app.js (idb-vector-1m0).
import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_MATCH_HEADING, WITHHELD_HEADING, resultsView } from '../../demo/results.js';

const passage = (title, similarity) => ({ object: { title, revision: 42, pageid: 7, text: `${title} excerpt` }, similarity });

test('an empty result set answers the question instead of leaving the panel blank', () => {
  const view = resultsView([], 'How do plants turn sunlight into food?');
  assert.deepEqual(view.items, []);
  assert.equal(view.empty.heading, NO_MATCH_HEADING);
  assert.match(view.empty.body, /How do plants turn sunlight into food\?/, 'the answer quotes what was asked');
  assert.match(view.empty.body, /not a loading state/, 'says which of the three blank-panel readings this is');
  assert.match(view.empty.body, /reload the page/, 'offers a next step');
  assert.equal(view.summary, 'No passages matched that question.', 'the live region announces the outcome');
});

test('the ranked state keeps the markup contract the demo gate reads', () => {
  const view = resultsView([passage('Photosynthesis', 0.8123), passage('Chlorophyll', 0.7564)], 'sunlight');
  assert.equal(view.empty, null);
  assert.equal(view.summary, '2 passages, closest first.');
  assert.deepEqual(view.items, [
    {
      title: 'Photosynthesis',
      href: 'https://en.wikipedia.org/w/index.php?oldid=42',
      text: 'Photosynthesis excerpt',
      score: 'Cosine similarity 0.8123 · cosine distance (1 − similarity) 0.1877',
      sourceText: 'Wikipedia contributors / history',
      sourceHref: 'https://en.wikipedia.org/w/index.php?curid=7&action=history',
    },
    {
      title: 'Chlorophyll',
      href: 'https://en.wikipedia.org/w/index.php?oldid=42',
      text: 'Chlorophyll excerpt',
      score: 'Cosine similarity 0.7564 · cosine distance (1 − similarity) 0.2436',
      sourceText: 'Wikipedia contributors / history',
      sourceHref: 'https://en.wikipedia.org/w/index.php?curid=7&action=history',
    },
  ]);
});

test('a single hit is announced in the singular', () => {
  assert.equal(resultsView([passage('Photosynthesis', 0.5)], 'sunlight').summary, '1 passage, closest first.');
});

// A record the panel cannot draw is withheld rather than rendered with a hole in it, and the panel
// says which outcome this was: some results shown, or nothing shown because every candidate failed
// (idb-vector-4skw).
test('a record that fails validation is withheld and counted, not rendered', () => {
  const view = resultsView([
    passage('Photosynthesis', 0.8),
    { object: { revision: 42, pageid: 7, text: 'no title' }, similarity: 0.7 },
    passage('Chlorophyll', 0.6),
  ], 'sunlight');
  assert.deepEqual(view.items.map(item => item.title), ['Photosynthesis', 'Chlorophyll']);
  assert.equal(view.summary, '2 passages, closest first. 1 passage withheld from these results: title is missing.');
  assert.equal(view.empty, null);
});

test('when every matching record fails, the panel says so instead of "no passages matched"', () => {
  const view = resultsView([
    { object: { title: 'Hostile', revision: 42, pageid: 7, url: 'javascript:alert(1)', text: 'x' }, similarity: 0.9 },
    { object: { title: 'Huge', revision: 42, pageid: 7, text: 'x'.repeat(10 * 1024 * 1024) }, similarity: 0.8 },
  ], 'sunlight');
  assert.deepEqual(view.items, []);
  assert.notEqual(view.empty.heading, NO_MATCH_HEADING, 'this is not "the search found nothing"');
  assert.equal(view.empty.heading, WITHHELD_HEADING);
  assert.match(view.summary, /2 passages could not be shown: url is not an https en\.wikipedia\.org link\./);
  assert.match(view.empty.body, /sunlight/, 'still quotes what was asked');
  assert.match(view.empty.body, /Remove this demo’s local data/, 'offers the repair');
  assert.doesNotMatch(JSON.stringify(view), /javascript:/, 'the refused link never reaches the view');
});

test('the withheld count reads as one passage, not one passages', () => {
  const view = resultsView([{ object: { revision: 42, pageid: 7, text: 'x' }, similarity: 0.9 }], 'q');
  assert.match(view.summary, /^1 passage could not be shown/);
  assert.match(view.empty.body, /The 1 passage that matched/);
});
