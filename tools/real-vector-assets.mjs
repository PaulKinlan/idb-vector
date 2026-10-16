import path from 'node:path';

// Static asset map shared by the real-vector browser server and its fast routing test.
// Corpus files are added separately after validating their manifests.
export function realVectorAssets(root) {
  return new Map([
    'index.js',
    'utils/sortedarray.js',
    'utils/packed-snapshot.js',
    'utils/geometry.js',
    'utils/side-store.js',
    'test-harness/real-vectors.js',
    'test-harness/real-vectors.html',
  ].map(file => ['/' + file, path.join(root, file)]));
}
