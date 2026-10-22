// idb-vector-tjn: the compute lab imports only ../tokens.css, so the control state rules
// (:focus-visible ring, :disabled, :hover/:active) must live in the shared tokens.css that both
// demo pages consume — not in demo/style.css alone, where the lab never sees them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const tokens = readFileSync('demo/tokens.css', 'utf8');
const pageStyle = readFileSync('demo/style.css', 'utf8');
const labPage = readFileSync('demo/compute/index.html', 'utf8');

test('tokens.css carries the shared control states both pages rely on', () => {
  assert.match(tokens, /:focus-visible\s*\{[^}]*outline:\s*3px solid/, 'explicit focus ring');
  assert.match(tokens, /:focus-visible\s*\{[^}]*outline-offset/, 'ring offset from the control');
  assert.match(tokens, /button:disabled\s*\{[^}]*cursor:\s*not-allowed/, 'disabled cursor');
  assert.match(tokens, /button:disabled\s*\{[^}]*opacity/, 'disabled dimming');
  assert.match(tokens, /button:not\(:disabled\):hover/, 'hover feedback');
  assert.match(tokens, /button:not\(:disabled\):active/, 'active feedback');
});

test('both demo pages consume tokens.css, and style.css no longer forks the state rules', () => {
  assert.match(pageStyle, /@import '\.\/tokens\.css'/, 'wikipedia demo imports the tokens');
  assert.match(labPage, /href="\.\.\/tokens\.css"/, 'compute lab links the tokens');
  assert.doesNotMatch(pageStyle, /button:disabled/, 'disabled rule lives in tokens.css only');
  assert.doesNotMatch(pageStyle, /:focus-visible/, 'focus ring lives in tokens.css only');
});
