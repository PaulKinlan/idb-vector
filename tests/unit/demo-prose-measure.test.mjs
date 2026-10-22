// Pins the demo's prose measure (idb-vector-1j7): paragraphs and the footer
// attribution cap at 65ch while the layout boxes stay wide. Matching raw CSS
// text is not enough on its own — a commented-out rule would still match — so
// the file's comments are stripped before the rules are asserted, and the
// structural claims (main and .query-row stay uncapped) are asserted too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const css = readFileSync(resolve('demo/style.css'), 'utf8').replace(/\/\*.*?\*\//gs, '');

// Returns the declarations of the first rule whose selector list contains `selector`.
const declarations = (selector) => {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  return rule ? rule[1] : null;
};

test('paragraphs cap at a 65ch measure', () => {
  const p = declarations('p');
  assert.ok(p, 'demo/style.css must have a bare p rule');
  assert.match(p, /text-wrap:\s*pretty/);
  assert.match(p, /max-width:\s*65ch/);
});

test('the footer attribution shares the prose measure', () => {
  const footer = declarations('footer');
  assert.ok(footer, 'demo/style.css must have a footer rule');
  assert.match(footer, /max-width:\s*65ch/);
});

test('the layout boxes keep their width so borders and the query row do not shrink', () => {
  const main = declarations('main');
  assert.ok(main, 'demo/style.css must have a main rule');
  assert.match(main, /max-width:\s*900px/);
  const queryRow = declarations('.query-row');
  assert.ok(queryRow, 'demo/style.css must have a .query-row rule');
  assert.doesNotMatch(queryRow, /max-width/);
});
