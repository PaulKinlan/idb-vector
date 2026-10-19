// The real-vector harness measures corpora it fetches from disk next to their own manifest. The
// manifest therefore has no authority: the pinned digest in test-harness/real-vector-pins.js does.
// These checks are pure — no browser, no prepared corpus, no network — so the fast tier can hold the
// trust root still.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  REAL_VECTOR_PINS,
  TRUSTED_FILES,
  pinFor,
  sha256Hex,
  trustedView,
  trustedDigest,
  verifyCorpus,
} from '../../test-harness/real-vector-pins.js';
import { realVectorAssets } from '../../tools/real-vector-assets.mjs';
// Imported rather than read as text wherever possible: this is the module the pin protects, so it has
// to load in a non-browser host, and the fast gate then maps the harness's changes to this suite.
import { run } from '../../test-harness/real-vectors.js';

const reports = {};
for (const file of ['reports/real-glove-2026-10-15.json', 'reports/real-wiki-2026-10-15.json']) {
  reports[file] = JSON.parse(await readFile(new URL(`../../${file}`, import.meta.url), 'utf8'));
}
const published = new Map(
  Object.entries(reports).flatMap(([file, report]) => report.corpora.map(corpus => [corpus.name, { file, corpus }]))
);

const clone = value => structuredClone(value);

test('every pin is the manifest the evidence reports published, and no published corpus lacks a pin', async () => {
  assert.ok(Object.keys(REAL_VECTOR_PINS).length > 0, 'the harness must pin at least one corpus');
  assert.deepEqual(Object.keys(REAL_VECTOR_PINS).sort(), [...published.keys()].sort(),
    'pins and published evidence reports must list the same corpora: a repin without published evidence is not a trust root');
  for (const [name, pin] of Object.entries(REAL_VECTOR_PINS)) {
    const { file, corpus } = published.get(name);
    assert.equal(pin.count, corpus.count, `${name}: pinned count must match ${file}`);
    assert.equal(pin.dimensions, corpus.dimensions, `${name}: pinned dimensions must match ${file}`);
    assert.equal(pin.sha256, await trustedDigest(corpus),
      `${name}: pinned digest must be the ${file} manifest, so repinning requires published evidence`);
  }
});

test('the trusted view covers the file digests, the held-out queries, the ground truth and the centroids', () => {
  const view = trustedView(published.get('glove25-10000').corpus);
  assert.deepEqual(Object.keys(view), ['name', 'count', 'dimensions', 'metric', 'files', 'queries', 'truth', 'centroids']);
  assert.deepEqual(Object.keys(view.files), TRUSTED_FILES);
  // Prepare-time telemetry varies between identical preparations, so it must stay outside the view:
  // otherwise a reproducible re-prepare would fail its own pin.
  for (const volatile of ['preparedAt', 'prepareTotalMs', 'shippedGroundTruthCheck']) {
    assert.equal(JSON.stringify(view).includes(volatile), false, `${volatile} must not be part of the pinned view`);
  }
  assert.equal(view.queries.length, 40);
  assert.equal(view.truth.length, 40);
  assert.equal(view.centroids.length, 64);
});

test('a manifest that matches its pin is accepted, and an unpinned corpus is refused', async () => {
  const corpus = published.get('wiki-api-10000').corpus;
  assert.equal(await verifyCorpus('wiki-api-10000', corpus), REAL_VECTOR_PINS['wiki-api-10000']);
  await assert.rejects(() => verifyCorpus('wiki-api-10000', clone(corpus), {}), /is not pinned/);
  assert.throws(() => pinFor('glove25-9999'), /is not pinned/);
  // Pin maps are injectable so a probe can drive the accept path with its own fixture; the commit
  // above is what makes the real corpora measurable.
  const injected = { 'wiki-api-10000': { count: corpus.count, dimensions: corpus.dimensions, sha256: await trustedDigest(corpus) } };
  assert.equal(await verifyCorpus('wiki-api-10000', corpus, injected), injected['wiki-api-10000']);
});

test('a corpus mutated together with the manifest served beside it is refused', async () => {
  const original = published.get('glove25-10000').corpus;
  // Exactly the attack the old check allowed: change the data, then change the manifest to match it,
  // so the harness's own checksum comparison still agrees with itself.
  const mutated = clone(original);
  mutated.files['vectors.f32'].sha256 = await sha256Hex(new TextEncoder().encode('different corpus bytes'));
  await assert.rejects(() => verifyCorpus('glove25-10000', mutated), /does not match its pin/);

  // The ground truth is pinned too: editing a single neighbour ID changes the published recall.
  const retruthed = clone(original);
  retruthed.truth[0].ids[0] = retruthed.truth[0].ids[0] + 1;
  await assert.rejects(() => verifyCorpus('glove25-10000', retruthed), /does not match its pin/);

  // So are the IVF centroids: a rewritten centroid set silently changes which cells are scanned.
  const recentroided = clone(original);
  recentroided.ivf.centroids[0][0] = recentroided.ivf.centroids[0][0] + 1;
  await assert.rejects(() => verifyCorpus('glove25-10000', recentroided), /does not match its pin/);

  // And the byte counts: a truncated corpus cannot pass as the pinned one.
  const truncated = clone(original);
  truncated.files['cells.u32'].bytes = truncated.files['cells.u32'].bytes / 2;
  await assert.rejects(() => verifyCorpus('glove25-10000', truncated), /does not match its pin/);
});

test('a manifest that misdescribes its own identity is refused before the digest is even compared', async () => {
  const original = published.get('glove25-10000').corpus;
  const renamed = clone(original);
  renamed.name = 'glove25-100000';
  await assert.rejects(() => verifyCorpus('glove25-10000', renamed), /names "glove25-100000", not "glove25-10000"/);
  const resized = clone(original);
  resized.count = 9999;
  await assert.rejects(() => verifyCorpus('glove25-10000', resized), /is 9999 × 25 but its pin is 10000 × 25/);
  await assert.rejects(() => verifyCorpus('glove25-10000', { name: 'glove25-10000', count: 10000, dimensions: 25 }), /does not match its pin/,
    'a manifest with no files, queries, truth or centroids cannot match a pin');
});

test('the browser harness verifies the served manifest against the pin before it reads any vector', async () => {
  assert.equal(typeof run, 'function', 'the harness must load where the pins do, not only in a browser');
  const harness = await readFile(new URL('../../test-harness/real-vectors.js', import.meta.url), 'utf8');
  // A comment mentioning the check is not wiring: require the call, before the first file read.
  const call = /^\s*await verifyCorpus\(name, manifest, pins\);$/m.exec(harness);
  assert.ok(call, 'run() must verify the manifest against the pin');
  const firstRead = harness.indexOf("await fetch(base + file)");
  assert.ok(firstRead > call.index, 'the pin check must precede fetching the corpus files');
  // The page imports the harness as a module, so the pins module has to be served to the browser.
  assert.ok(realVectorAssets('/example/repo').has('/test-harness/real-vector-pins.js'),
    'the real-vector server must serve the pins module the harness imports');
});
