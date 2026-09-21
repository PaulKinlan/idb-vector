"""Offline oracle/IVF training only; search measurements run in Chromium/IndexedDB.
Requires numpy and h5py (test tooling, not runtime dependencies).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import urllib.request

# Bound BLAS on a shared machine; set before importing numpy.
os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
import numpy as np
import h5py

CACHE = Path(__file__).resolve().parents[1] / '.cache/real-vectors'
SOURCE = 'https://ann-benchmarks.com/glove-25-angular.hdf5'
SHA256 = '51004cb0ae962159f0db507a51fec2b395de14b166f55976c89f16bd2f8b6391'

def digest(path):
    with open(path, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def unit(x):
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    assert np.all(np.isfinite(x)) and np.all(norms > 0), 'finite nonzero vectors required'
    return x / norms

def truth(x, queries):
    # Independent float64 exhaustive oracle, not the JS scorer or the IVF shortlist.
    x = unit(x.astype(np.float64))
    q = unit(queries.astype(np.float64))
    result = []
    for query in q:
        scores = x @ query
        order = np.lexsort((np.arange(len(x)), -scores))[:10]
        cutoff = float(scores[order[-1]])
        ties = np.flatnonzero(np.abs(scores - cutoff) <= 1e-12)
        result.append({'ids': order.tolist(), 'scores': scores[order].tolist(),
                       'acceptableIds': np.union1d(order, ties).tolist()})
    return result

def train_ivf(x):
    started = time.perf_counter()
    x = unit(x.astype(np.float32))
    rng = np.random.default_rng(20260921)
    sample = x[rng.choice(len(x), min(10000, len(x)), replace=False)]
    centroids = sample[rng.choice(len(sample), 64, replace=False)].copy()
    for _ in range(10):
        assignment = np.argmax(sample @ centroids.T, axis=1)
        for cell in range(64):
            members = sample[assignment == cell]
            if len(members):
                mean = members.mean(axis=0)
                if np.linalg.norm(mean) > 0:
                    centroids[cell] = mean / np.linalg.norm(mean)
    assignments = np.empty(len(x), dtype='<u4')
    for start in range(0, len(x), 8192):
        assignments[start:start + 8192] = np.argmax(x[start:start + 8192] @ centroids.T, axis=1)
    return centroids, assignments, (time.perf_counter() - started) * 1000

def prepare(name, x, queries, source, shipped=None):
    assert len(queries) == 40 and len(x) >= 100, '40 held-out queries required'
    folder = CACHE / name
    folder.mkdir(exist_ok=True)
    started = time.perf_counter()
    expected = truth(x, queries)
    mean = x.astype(np.float64).mean(axis=0)
    centered = truth(x.astype(np.float64) - mean, queries.astype(np.float64) - mean)
    overlap = [len(set(a['ids']) & set(b['ids'])) / 10 for a, b in zip(expected, centered)]
    centroids, assignments, train_ms = train_ivf(x)
    x.astype('<f4').tofile(folder / 'vectors.f32')
    assignments.tofile(folder / 'cells.u32')
    files = {f: {'sha256': digest(folder / f), 'bytes': (folder / f).stat().st_size}
             for f in ['vectors.f32', 'cells.u32']}
    manifest = {
        'name': name, 'count': len(x), 'dimensions': x.shape[1], 'metric': 'cosine',
        'source': source, 'queries': queries.tolist(), 'truth': expected, 'files': files,
        'groundTruth': 'Independent NumPy float64 exhaustive cosine; descending score, ID ascending ties. '
                       'Slice truth recomputed, never truncated from full-corpus neighbour lists.',
        'ivf': {'centroids': centroids.tolist(), 'trainingMs': train_ms, 'seed': 20260921,
                'cells': 64, 'iterations': 10, 'trainingRows': min(len(x), 10000),
                'description': 'Offline spherical k-means; full assignment included in trainingMs; exact cosine rerank in browser'},
        'anisotropy': {'transform': 'Subtract raw training-vector mean from train AND held-out query, then normalize; no whitening',
                       'meanUnitVectorNorm': float(np.linalg.norm(unit(x.astype(np.float64)).mean(axis=0))),
                       'top10SetOverlapPerQuery': overlap, 'meanTop10SetOverlap': float(np.mean(overlap)),
                       'changedTop10Sets': sum(v < 1 for v in overlap),
                       'changedOrderedTop10': sum(a['ids'] != b['ids'] for a, b in zip(expected, centered)),
                       'centeredTruth': centered,
                       'qualityClaim': 'Rank change only. No relevance labels: neither ranking is shown better.'},
        'preparedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    if shipped is not None:
        ids, distances = shipped
        # Source truth uses float32. Compare distances as well as IDs, with explicit tie tolerance.
        source_recall, source_distance_error = [], []
        for i, row in enumerate(expected):
            source_recall.append(len(set(row['ids']) & set(ids[i, :10].tolist())) / 10)
            source_distance_error.append(float(np.max(np.abs(1 - np.array(row['scores']) - distances[i, :10]))))
        assert max(source_distance_error) < 2e-6, 'source angular distances disagree with exhaustive cosine'
        manifest['shippedGroundTruthCheck'] = {'queries': 40, 'setRecallPerQuery': source_recall,
                                              'maxDistanceError': max(source_distance_error), 'tolerance': 2e-6,
                                              'ids': ids[:, :10].tolist(), 'distances': distances[:, :10].tolist()}
    manifest['prepareTotalMs'] = (time.perf_counter() - started) * 1000
    (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'corpus': name, 'trainingMs': train_ms, 'meanCenteredTop10Overlap': np.mean(overlap)}), flush=True)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('corpus', choices=['glove', 'wiki'])
    parser.add_argument('--sizes', default='10000,100000,1183514')
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    if args.corpus == 'glove':
        path = CACHE / 'glove-25-angular.hdf5'
        if not path.exists():
            req = urllib.request.Request(SOURCE, headers={'User-Agent': 'idb-vector benchmark'})
            with urllib.request.urlopen(req, timeout=120) as response, open(str(path) + '.partial', 'wb') as out:
                while chunk := response.read(1024 * 1024):
                    out.write(chunk)
            Path(str(path) + '.partial').replace(path)
        assert digest(path) == SHA256, 'source checksum mismatch'
        with h5py.File(path, 'r') as f:
            assert f.attrs['distance'] == 'angular'
            for size in map(int, args.sizes.split(',')):
                assert 100 <= size <= len(f['train'])
                prepare(f'glove25-{size}', f['train'][:size], f['test'][:40],
                        {'url': SOURCE, 'sha256': SHA256, 'realVectors': True,
                         'description': 'GloVe Twitter word embeddings; NOT Wikipedia or sentence embeddings',
                         'fullTrainingRows': len(f['train']), 'slice': f'first {size} training rows; first 40 official test queries',
                         'shipsGroundTruth': True},
                        (f['neighbors'][:40], f['distances'][:40]) if size == len(f['train']) else None)
    else:
        metadata = json.loads((CACHE / 'wiki-api/source.json').read_text())
        path = CACHE / 'wiki-api/embeddings.f32'
        assert digest(path) == metadata['vectorSha256'], 'embedding checksum mismatch'
        x = np.fromfile(path, dtype='<f4').reshape(metadata['rows'], metadata['dimensions'])
        prepare(f'wiki-api-{len(x)-40}', x[40:], x[:40], metadata)
