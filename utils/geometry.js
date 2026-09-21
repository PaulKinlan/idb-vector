// Coordinate variance is a diagnostic, not a proof of retrieval quality.
export function moments() {
  let count = 0, mean, m2;
  return {
    add(vector) {
      if (!vector || !Number.isSafeInteger(vector.length) || vector.length === 0) throw new TypeError('Expected a nonempty vector');
      if (!mean) { mean = new Float64Array(vector.length); m2 = new Float64Array(vector.length); }
      if (vector.length !== mean.length) throw new TypeError('Vectors must have the same dimension');
      for (let i = 0; i < vector.length; i++) if (!Number.isFinite(vector[i])) throw new TypeError('Vector coordinates must be finite numbers');
      count++;
      for (let i = 0; i < mean.length; i++) { const delta = vector[i] - mean[i]; mean[i] += delta / count; m2[i] += delta * (vector[i] - mean[i]);
        if (!Number.isFinite(mean[i]) || !Number.isFinite(m2[i])) throw new RangeError('Corpus variance overflow');
      }
    },
    result() {
      const dimensions = mean?.length ?? 0;
      const total = m2?.reduce((a, b) => a + b, 0) ?? 0;
      const dominance = total > 0 ? m2.reduce((a, b) => Math.max(a, b), 0) / total : null;
      const isotropicShare = dimensions ? 1 / dimensions : null;
      const relativeDominance = dominance === null ? null : dominance * dimensions;
      // A heuristic screen: >1% AND >twice equal-share variance. Not a learned cutoff.
      const warning = dominance !== null && dominance > 0.01 && relativeDominance > 2
        ? 'Concentrated coordinate variance: compare opt-in whitening against original retrieval; improvement is not guaranteed.' : null;
      return { count, dimensions, dominance, isotropicShare, relativeDominance, warning,
        limitation: 'Coordinate variance misses correlated anisotropy; unchanged rankings do not prove isotropy. Threshold is a heuristic, not a retrieval-quality test.' };
    }
  };
}

export function diagnose(vectors) {
  const stats = moments();
  for (const vector of vectors) stats.add(vector);
  return stats.result();
}

// Full-covariance Cholesky whitening, not just per-coordinate standardization.
// ponytail: dense O(n*d² + d³) fitting; use an external numerical library for large d.
export function fitWhitening(vectors, { regularization = 1e-6 } = {}) {
  if (!Array.isArray(vectors) || vectors.length < 2) throw new TypeError('Whitening needs at least two vectors');
  if (!(regularization > 0) || !Number.isFinite(regularization)) throw new TypeError('regularization must be positive and finite');
  const diagnostic = diagnose(vectors);
  const d = diagnostic.dimensions, n = vectors.length;
  const mean = new Float64Array(d), covariance = new Float64Array(d * d);
  // Stable online covariance. Keep the pre-update delta for both coordinates.
  const delta = new Float64Array(d);
  for (let row = 0; row < n; row++) {
    for (let i = 0; i < d; i++) { delta[i] = vectors[row][i] - mean[i]; mean[i] += delta[i] / (row + 1); }
    const factor = row / (row + 1);
    for (let i = 0; i < d; i++) for (let j = 0; j <= i; j++) covariance[i*d+j] += delta[i]*delta[j]*factor;
  }
  let trace = 0;
  for (let i = 0; i < d; i++) trace += covariance[i*d+i] / (n-1);
  if (!Number.isFinite(trace) || trace <= 0) throw new RangeError('Whitening needs finite nonzero corpus variance');
  const ridge = regularization * trace / d;
  const lower = new Float64Array(d*d);
  for (let i = 0; i < d; i++) for (let j = 0; j <= i; j++) {
    let value = covariance[i*d+j] / (n-1) + (i === j ? ridge : 0);
    for (let k = 0; k < j; k++) value -= lower[i*d+k] * lower[j*d+k];
    lower[i*d+j] = i === j ? Math.sqrt(value) : value/lower[j*d+j];
    if (!Number.isFinite(lower[i*d+j]) || (i === j && lower[i*d+j] <= 0)) throw new RangeError('Whitening covariance is numerically singular; increase regularization');
  }
  function validate(vector) {
    if (!vector || vector.length !== d) throw new TypeError(`Expected ${d} coordinates`);
    for (const x of vector) if (!Number.isFinite(x)) throw new TypeError('Vector coordinates must be finite numbers');
  }
  return {
    diagnostic, dimensions: d, regularization,
    transform(vector) {
      validate(vector);
      const output = new Array(d);
      for (let i = 0; i < d; i++) {
        let value = vector[i] - mean[i];
        for (let j = 0; j < i; j++) value -= lower[i*d+j] * output[j];
        output[i] = value / lower[i*d+i];
        if (!Number.isFinite(output[i])) throw new RangeError('Whitening transform overflow');
      }
      return output;
    },
    inverse(vector) {
      validate(vector);
      return Array.from(mean, (value, i) => {
        for (let j = 0; j <= i; j++) value += lower[i*d+j] * vector[j];
        if (!Number.isFinite(value)) throw new RangeError('Whitening inverse overflow');
        return value;
      });
    }
  };
}
