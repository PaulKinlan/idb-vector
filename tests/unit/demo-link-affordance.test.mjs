// Pins the demo's link affordance (idb-vector-gbl): an explicit underline
// (not one inherited from UA defaults), a hover response, and a pressed
// response. Comments are stripped before matching so commenting a rule out
// cannot keep these assertions green; a global no-underline guard fails the
// suite if any rule removes the affordance again.
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

test('links declare their own underline affordance, not a UA default', () => {
  const a = declarations('a');
  assert.ok(a, 'demo/style.css must have a bare a rule');
  assert.match(a, /text-decoration-line:\s*underline/);
  assert.match(a, /text-decoration-thickness:\s*1px/);
});

test('links answer hover with a thicker underline', () => {
  const hover = declarations('a:hover');
  assert.ok(hover, 'demo/style.css must have an a:hover rule');
  assert.match(hover, /text-decoration-thickness:\s*2px/);
});

test('links answer a press with the same brightness feedback buttons use', () => {
  const active = declarations('a:active');
  assert.ok(active, 'demo/style.css must have an a:active rule');
  assert.match(active, /filter:\s*brightness\(/);
});

test('nothing in the page stylesheet removes the underline', () => {
  assert.doesNotMatch(css, /text-decoration:[^;]*none/);
});
