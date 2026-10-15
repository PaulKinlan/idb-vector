import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const report = JSON.parse(await readFile(new URL('../../reports/real-glove-2026-10-15.json', import.meta.url)));
const wiki = JSON.parse(await readFile(new URL('../../reports/real-wiki-2026-10-15.json', import.meta.url)));
const markdown = await readFile(new URL('../../reports/real-vectors-2026-10-15.md', import.meta.url), 'utf8');
const approximate = (value, decimals) => value.toFixed(decimals);

// This validates committed measurements and the published numbers, not machine-specific timing.
test('GloVe evidence retains independent source and recomputed-slice oracles', () => {
  assert.equal(report.corpora.length, 3);
  const requiredRuns = [
    ['glove25-10000', 'library'], ['glove25-10000', 'ivf'],
    ['glove25-100000', 'library'], ['glove25-100000', 'ivf'],
    ['glove25-1183514', 'library'],
  ];
  for (const [corpus, method] of requiredRuns) {
    assert.equal(report.runs.filter(run => run.corpus === corpus && run.method === method).length, 1,
      `missing or duplicate ${corpus}/${method}`);
  }
  assert.equal(new Set(report.runs.map(run => `${run.corpus}/${run.method}`)).size, report.runs.length,
    'duplicate browser run');
  const fullIvf = report.runs.find(run => run.corpus === 'glove25-1183514' && run.method === 'ivf');
  if (fullIvf) {
    assert.ok(report.finishedAt, 'completed full-size IVF requires a finished report');
    assert.doesNotMatch(markdown, /\| 1,183,514 \| IVF \| —/,
      'completed full-size IVF cannot retain an unmeasured table row');
  } else {
    assert.equal(report.finishedAt, undefined, 'unfinished full-size IVF requires partial-report marker');
    assert.match(markdown, /Incomplete full-size IVF/);
    assert.match(markdown, /\| 1,183,514 \| IVF \| —/);
  }
  for (const corpus of report.corpora) {
    assert.equal(corpus.source.realVectors, true);
    assert.equal(corpus.source.sha256, '51004cb0ae962159f0db507a51fec2b395de14b166f55976c89f16bd2f8b6391');
    assert.match(corpus.groundTruth, /Slice truth recomputed/);
    assert.equal(corpus.queries.length, 40);
    assert.equal(corpus.truth.length, 40);
    assert.equal(corpus.anisotropy.centeredTruth.length, 40);
    assert.equal(corpus.anisotropy.top10SetOverlapPerQuery.length, 40);
    for (const row of corpus.truth) {
      assert.equal(new Set(row.ids).size, 10);
      assert.equal(row.scores.length, 10);
      assert.ok(row.scores.every(Number.isFinite));
    }
    if (corpus.count !== 1183514) assert.equal(corpus.shippedGroundTruthCheck, undefined);
    else {
      assert.equal(corpus.shippedGroundTruthCheck.queries, 40);
      assert.ok(corpus.shippedGroundTruthCheck.setRecallPerQuery.every(value => value === 1));
      assert.ok(corpus.shippedGroundTruthCheck.maxDistanceError < corpus.shippedGroundTruthCheck.tolerance);
    }
  }
});

test('every published GloVe row matches 40 browser measurements and manifest truth', () => {
  for (const run of report.runs) {
    const corpus = report.corpora.find(item => item.name === run.corpus);
    assert.ok(corpus);
    assert.equal(run.count, corpus.count);
    assert.equal(run.measurements.length, run.method === 'ivf' ? 160 : 40);
    assert.ok(run.disk.logicalBytes > 0);
    for (const summary of run.summary) {
      const samples = run.measurements.filter(row => row.nprobe === summary.nprobe);
      assert.equal(samples.length, 40);
      for (const sample of samples) {
        const truth = corpus.truth[sample.query];
        assert.equal(sample.ids.length, 10);
        assert.equal(new Set(sample.ids).size, 10);
        assert.equal(sample.recallAt10, sample.ids.filter(id => truth.ids.includes(id)).length / 10);
        assert.equal(sample.tieAwareRecallAt10, sample.ids.filter(id => truth.acceptableIds.includes(id)).length / 10);
        if (run.method === 'library' || summary.nprobe === 64) assert.equal(sample.tieAwareRecallAt10, 1);
      }
      const sorted = samples.map(row => row.latencyMs).sort((a, b) => a - b);
      assert.equal(summary.p50Ms, sorted[19]);
      assert.equal(summary.p95Ms, sorted[37]);
      assert.ok(Math.abs(summary.recallAt10 - samples.reduce((sum, row) => sum + row.recallAt10, 0) / 40) < 1e-12);
      const label = run.method === 'library' ? 'Exact cursor' : `IVF / ${summary.nprobe}`;
      const published = markdown.split('\n').find(line => line.startsWith(`| ${run.count.toLocaleString('en-US')} | ${label} |`));
      assert.ok(published, `missing report row ${run.corpus}/${label}`);
      const cells = published.split('|').slice(1, -1).map(cell => cell.trim());
      assert.equal(cells[2], approximate(summary.p50Ms, 1));
      assert.equal(cells[3], approximate(summary.p95Ms, 1));
      assert.equal(cells[4], approximate(summary.recallAt10, 4));
      assert.equal(cells[5], new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(summary.meanCandidates));
      assert.equal(cells[6], approximate(run.buildMs, 1));
      assert.equal(cells[7], approximate(run.totalBuildMs, 1));
      assert.equal(cells[8], approximate(run.disk.logicalBytes / 1e6, 2));
    }
  }
});

test('Wikipedia paid corpus is bounded and report numbers match the successful browser run', () => {
  assert.ok(wiki.finishedAt);
  assert.equal(wiki.runs.length, 2);
  const corpus = wiki.corpora[0];
  assert.equal(corpus.name, 'wiki-api-10000');
  assert.equal(corpus.source.model, 'text-embedding-3-small');
  assert.equal(corpus.source.dimensions, 256);
  assert.equal(corpus.source.rows, 10040);
  assert.equal(corpus.source.articles.length, 167);
  assert.equal(corpus.source.shipsGroundTruth, false);
  assert.equal(corpus.truth.length, 40);
  assert.equal(corpus.source.tokenUsage, 949845);
  assert.ok(corpus.source.estimatedCostUSD <= corpus.source.maxEstimatedUSD);
  assert.equal(corpus.source.estimatedCostUSD, 0.0189969);
  const section = markdown.split('## Wikipedia API embeddings\n')[1];
  assert.ok(section);
  assert.match(section, /independently recomputed exact float64 cosine/i);
  assert.match(section, /0\.0189969 estimated/);
  assert.doesNotMatch(section, /PENDING MEASUREMENT/);
  for (const run of wiki.runs) {
    assert.equal(run.measurements.length, run.method === 'ivf' ? 160 : 40);
    assert.ok(run.disk.logicalBytes > 0);
    for (const summary of run.summary) {
      const samples = run.measurements.filter(sample => sample.nprobe === summary.nprobe);
      assert.equal(samples.length, 40);
      for (const sample of samples) {
        const truth = corpus.truth[sample.query];
        assert.equal(sample.recallAt10, sample.ids.filter(id => truth.ids.includes(id)).length / 10);
        if (run.method === 'library' || summary.nprobe === 64) assert.equal(sample.tieAwareRecallAt10, 1);
      }
      const label = run.method === 'library' ? 'Exact cursor' : `IVF / ${summary.nprobe}`;
      const row = section.split('\n').find(line => line.startsWith(`| 10,000 | ${label} |`));
      assert.ok(row, `missing Wikipedia row ${label}`);
      const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
      assert.equal(cells[2], approximate(summary.p50Ms, 1));
      assert.equal(cells[3], approximate(summary.p95Ms, 1));
      assert.equal(cells[4], approximate(summary.recallAt10, 4));
      assert.equal(cells[5], new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(summary.meanCandidates));
      assert.equal(cells[6], approximate(run.buildMs, 1));
      assert.equal(cells[7], approximate(run.totalBuildMs, 1));
      assert.equal(cells[8], approximate(run.disk.logicalBytes / 1e6, 2));
    }
  }
});
