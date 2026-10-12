import assert from 'node:assert/strict';
import test from 'node:test';
import { SortedArray } from '../../utils/sortedarray.js';

test('keeps highest scores sorted and bounded without losing ties', () => {
  const top = new SortedArray(3, 'score');
  for (const row of [
    { id: 'low', score: 0.1 }, { id: 'first', score: 0.8 },
    { id: 'middle', score: 0.5 }, { id: 'best', score: 0.9 },
    { id: 'tie', score: 0.8 },
  ]) top.insert(row);
  assert.deepEqual(Array.from(top, row => row.id), ['best', 'first', 'tie']);
  assert.equal(top.length, 3);
});

test('supports scalar ranking, empty budget and rejects unsorted insertion', () => {
  const top = new SortedArray(2);
  for (const score of [3, 1, 5, 4]) top.insert(score);
  assert.deepEqual(Array.from(top), [5, 4]);
  assert.throws(() => top.push(6), /Can't push/);
  assert.throws(() => top.unshift(6), /Can't unshift/);
  const empty = new SortedArray(0);
  empty.insert(1);
  assert.equal(empty.length, 0);
});
