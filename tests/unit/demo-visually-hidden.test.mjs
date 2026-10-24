// The visually-hidden recipe (#result-summary) must hide without becoming a scroll container.
// `overflow: hidden` makes a 1px box scrollable: find-in-page, scroll anchoring and scrollIntoView can
// move it, and the engine tracks scrollable overflow on every text mutation of a live region that
// receives a new sentence per search (idb-vector-6ly). `overflow: clip` hides the same way and creates
// no scroll container. The browser check proves the computed outcome (clip, not scrollable, still in
// the accessibility tree, nothing painted); this is the cheap guard that the recipe itself does not
// drift back.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const style = readFileSync('demo/style.css', 'utf8');
const page = readFileSync('demo/index.html', 'utf8');

const rule = style.match(/\.visually-hidden\s*\{([^}]*)\}/)?.[1] ?? '';

test('the visually-hidden recipe clips instead of hiding overflow', () => {
  assert.match(page, /id="result-summary"[^>]*role="status"[^>]*aria-live="polite"/, 'the live region keeps its accessible role');
  assert.ok(rule.length > 0, '.visually-hidden must exist in demo/style.css');
  assert.match(rule, /overflow:\s*clip\b/, 'clip creates no scroll container');
  assert.doesNotMatch(rule, /overflow:\s*hidden/, 'hidden would make the 1px box a scroll container');
  // The rest of the standard recipe stays: a 1px box, negative margin, a clipped visible region, no wrapping.
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /width:\s*1px/);
  assert.match(rule, /height:\s*1px/);
  assert.match(rule, /margin:\s*-1px/);
  assert.match(rule, /clip-path:\s*inset\(50%\)/);
  assert.match(rule, /white-space:\s*nowrap/);
  assert.match(rule, /border:\s*0/);
});
