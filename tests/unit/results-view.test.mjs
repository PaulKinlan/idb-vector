// The search panel's two states are described as data (demo/results.js) and rendered by app.js, so
// the zero-result state is covered in the fast tier without a browser. The browser check
// (tests/unit/… is not where markup lives) is the demo gate's job; what is asserted here is that an
// empty result set produces a real answer, and that the ranked state did not change shape when the
// description moved out of app.js (idb-vector-1m0).
import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_MATCH_HEADING, resultsView } from '../../demo/results.js';

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
