import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnose, fitWhitening, moments } from '../../utils/geometry.js';

test('online diagnostic matches batch and distinguishes concentrated from uniform variance', () => {
  const rows = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const stats = moments();
  for (const row of rows) stats.add(row);
  assert.deepEqual(stats.result(), diagnose(rows));
  assert.equal(stats.result().dominance, 0.5);
  assert.equal(stats.result().warning, null);
  const concentrated = diagnose([
    Array.from({ length: 128 }, (_, i) => i === 0 ? -10 : -1),
    Array.from({ length: 128 }, (_, i) => i === 0 ? 10 : 1),
  ]);
  assert.ok(concentrated.dominance > 0.01);
  assert.match(concentrated.warning, /Concentrated/);
  assert.equal(diagnose([[1, 1], [1, 1]]).dominance, null);
});

test('invalid geometry input is rejected without depending on browser state', () => {
  const stats = moments();
  assert.throws(() => stats.add([]), TypeError);
  stats.add([1, 2]);
  assert.throws(() => stats.add([1]), TypeError);
  assert.throws(() => stats.add([1, Infinity]), TypeError);
  assert.throws(() => diagnose([[1e308], [-1e308]]), RangeError);
  for (const invalid of [[], [[1]], [[1], [Infinity]], [[1], [1]]]) {
    assert.throws(() => fitWhitening(invalid));
  }
});

test('full-covariance whitening is reversible and does not mutate source vectors', () => {
  const rows = [[10, 1], [20, 2], [30, 4], [40, 3], [50, 7], [60, 5]];
  const original = structuredClone(rows);
  const fit = fitWhitening(rows, { regularization: 1e-10 });
  const whitened = rows.map(row => fit.transform(row));
  assert.deepEqual(rows, original);
  for (let i = 0; i < rows.length; i++) {
    fit.inverse(whitened[i]).forEach((value, j) => assert.ok(Math.abs(value - rows[i][j]) < 1e-9));
  }
  const mean = [0, 1].map(axis => whitened.reduce((sum, row) => sum + row[axis], 0) / whitened.length);
  const covariance = (i, j) => whitened.reduce((sum, row) =>
    sum + (row[i] - mean[i]) * (row[j] - mean[j]), 0) / (whitened.length - 1);
  assert.ok(Math.abs(covariance(0, 0) - 1) < 1e-6);
  assert.ok(Math.abs(covariance(1, 1) - 1) < 1e-6);
  assert.ok(Math.abs(covariance(0, 1)) < 1e-6);
  assert.throws(() => fit.transform([1]), TypeError);
  assert.throws(() => fit.inverse([1, Infinity]), TypeError);
});
