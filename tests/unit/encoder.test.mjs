import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('demo/encoder.js enables padding and truncation by default for batched inputs', async () => {
  const source = await readFile(new URL('../../demo/encoder.js', import.meta.url), 'utf8');
  assert.match(source, /padding:\s*true/, 'encoder must pass padding: true to model');
  assert.match(source, /truncation:\s*true/, 'encoder must pass truncation: true to model');
});
