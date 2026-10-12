import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root));
const [reportBytes, fixtureBytes, corpusBytes, vectorBytes, sourceBytes] = await Promise.all([
  'reports/preprocessing-relevance.json', 'tests/fixtures/wikipedia-relevance.json',
  'demo/data/passages-2000.json', 'demo/data/vectors-2000.f32', 'demo/data/source.json',
].map(read));
const hash = value => createHash('sha256').update(value).digest('hex');
const report = JSON.parse(reportBytes), fixture = JSON.parse(fixtureBytes);
const corpus = JSON.parse(corpusBytes), source = JSON.parse(sourceBytes);
assert.equal(report.provenance.labelsSha256, hash(fixtureBytes));
assert.equal(report.provenance.corpusVectorsSha256, hash(vectorBytes));
assert.equal(report.provenance.corpusVectorsSha256, source.artifacts['2000'].vectorSha256);
assert.equal(report.provenance.corpusPassagesSha256, hash(corpusBytes));
assert.equal(report.model, source.model);
assert.equal(report.revision, source.revision);
assert.equal(report.dimensions, source.dimensions);
const titles = [...new Set(corpus.map(row => row.title))];
const heldOut = new Set(titles.filter((_, i) => i % 4 === 0));
const eligible = corpus.filter(row => heldOut.has(row.title));
assert.equal(report.trainPassages, corpus.length - eligible.length);
assert.equal(report.eligiblePassages, eligible.length);
assert.equal(report.eligiblePages, heldOut.size);
assert.equal(report.queryCount, fixture.queries.length);
for (let i = 0; i < report.rows.length; i++) {
  const row = report.rows[i];
  assert.equal(row.query, fixture.queries[i].query);
  assert.equal(row.targetTitle, fixture.queries[i].title);
  assert.ok(heldOut.has(row.targetTitle), `label ${row.targetTitle} is not held out`);
  assert.equal(row.relevantEligible, eligible.filter(candidate => candidate.title === row.targetTitle).length);
  const rawKeys = new Set(row.methods.raw.top.map(item => item.index));
  for (const method of Object.values(row.methods)) {
    assert.equal(method.top.length, 10);
    assert.ok(method.searchMs >= 0);
    assert.ok(method.top.every(item => heldOut.has(corpus[item.index].title)));
    assert.equal(method.firstRelevantRank, method.top.findIndex(item => item.title === row.targetTitle) + 1);
    assert.equal(method.hits, method.top.filter(item => item.title === row.targetTitle).length);
    assert.equal(method.eligibleRecallAt10, method.hits / row.relevantEligible);
    assert.equal(method.neighbourOverlapAt10, method.top.filter(item => rawKeys.has(item.index)).length / 10);
  }
}
for (const name of ['raw', 'centered', 'whitened']) {
  const samples = report.rows.map(row => row.methods[name]);
  const mean = fn => samples.reduce((sum, sample) => sum + fn(sample), 0) / samples.length;
  assert.equal(report.metrics[name].mrrAt10, mean(sample => sample.firstRelevantRank ? 1 / sample.firstRelevantRank : 0));
  assert.equal(report.metrics[name].hitAt1, mean(sample => Number(sample.firstRelevantRank === 1)));
  assert.equal(report.metrics[name].hitAt10, mean(sample => Number(sample.firstRelevantRank > 0)));
  assert.equal(report.metrics[name].eligibleRecallAt10, mean(sample => sample.eligibleRecallAt10));
  assert.equal(report.metrics[name].neighbourOverlapAt10, mean(sample => sample.neighbourOverlapAt10));
}
console.log(`PASS: ${report.queryCount} fixed labels, split/provenance hashes, held-out eligibility and relevance/overlap aggregations`);
