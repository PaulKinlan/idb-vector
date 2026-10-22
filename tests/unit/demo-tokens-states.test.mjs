// Pins the compute lab's shared control states in tokens.css (idb-vector-tjn,
// idb-vector-0tf): selects and inputs get the same disabled look and
// hover/pressed feedback as the buttons, and the details toggle gets a pointer
// cursor. Comments are stripped before matching so commenting a rule out
// cannot keep these assertions green. The focus RING for these controls is the
// global :focus-visible rule landed with idb-vector-tjn's button work and is
// asserted by tests/unit/demo-control-states.test.mjs there.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const css = readFileSync(resolve('demo/tokens.css'), 'utf8').replace(/\/\*.*?\*\//gs, '');

// Returns the declarations of the first rule whose selector list contains `selector`.
const declarations = (selector) => {
  const rule = new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  return rule ? rule[1] : null;
};

test('a disabled select or input looks as disabled as a button', () => {
  const disabled = declarations('select:disabled, input:disabled');
  assert.ok(disabled, 'tokens.css must style select/input :disabled');
  assert.match(disabled, /opacity:\s*\.55/);
  assert.match(disabled, /cursor:\s*not-allowed/);
});

test('selects and inputs answer hover with the buttons\u2019 brightness step', () => {
  const hover = declarations('select:not(:disabled):hover, input:not(:disabled):hover');
  assert.ok(hover, 'tokens.css must give select/input a hover state');
  assert.match(hover, /filter:\s*brightness\(1\.08\)/);
});

test('selects and inputs answer a press with the buttons\u2019 active step', () => {
  const active = declarations('select:not(:disabled):active, input:not(:disabled):active');
  assert.ok(active, 'tokens.css must give select/input an active state');
  assert.match(active, /filter:\s*brightness\(\.94\)/);
});

test('the details toggle claims a pointer cursor', () => {
  const summary = declarations('summary');
  assert.ok(summary, 'tokens.css must style summary');
  assert.match(summary, /cursor:\s*pointer/);
});
