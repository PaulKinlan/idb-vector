// The Pages build stages site/ from the commit and then uploads it, with no reader in between, so a
// process left running by `npm ci` or the research build can add a file to site/ after staging and the
// artifact publishes bytes no commit tracks (idb-vector-vy5v, residual risk (i) of the idb-vector-5yqb
// review). The workflow's answer is tools/audit-staged-site.mjs, run after the last write and before
// the upload; these tests drive that script end to end against a throwaway repository, one observed
// failure per case. Each case was run RED before the script existed: the invocation failed with
// MODULE_NOT_FOUND for the missing tool, and after the tool was added each mutation was run against the
// first (set-only) draft, which passed the modified-bytes case - which is why content and set are both
// checked.
//
// Middle tier: every case starts a real git repository (init, commit) and the audit spawns git for the
// commit tree and each file's blob id. tools/unit-tier-suites.sh `middle` is where spawn-shaped suites
// live, so this file is listed there rather than in the fast tier.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { REDIRECT_HTML } from '../../tools/audit-staged-site.mjs';

const repoRoot = resolve('.');
const auditScript = join(repoRoot, 'tools/audit-staged-site.mjs');
const stageScript = join(repoRoot, 'tools/stage-site.mjs');
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
const gitCommit = (cwd) => run(cwd, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);

// A miniature copy of the published layout: demo/ ships whole, index.js and utils/lib.js are the
// library modules demo/app.js imports, research/ ships whole, and site/index.html is the redirect stub
// the workflow generates. The extracted commit lives in .site-src, as the workflow leaves it.
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'staged-site-audit-'));
  const write = (path, body) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  };
  write('demo/index.html', '<!doctype html><title>demo</title>\n');
  write('demo/app.js', "import { VectorDB } from '../index.js';\nimport { lib } from '../utils/lib.js';\nexport { VectorDB, lib };\n");
  write('index.js', 'export class VectorDB {}\n');
  write('utils/lib.js', 'export const lib = 1;\n');
  write('research/index.html', '<!doctype html><title>research</title>\n');
  write('research/architecture.md', '# architecture\n');
  run(repo, 'git', ['init', '-q']);
  run(repo, 'git', ['add', '.']);
  gitCommit(repo);
  mkdirSync(join(repo, '.site-src'));
  for (const path of ['demo', 'index.js', 'utils', 'research']) cpSync(join(repo, path), join(repo, '.site-src', path), { recursive: true });
  execFileSync(process.execPath, [stageScript, 'site'], { cwd: repo });
  cpSync(join(repo, 'research'), join(repo, 'site/research'), { recursive: true });
  writeFileSync(join(repo, 'site/index.html'), REDIRECT_HTML);
  return repo;
}

function audit(repo, extra = []) {
  const args = [auditScript, '--commit', 'HEAD', '--site', 'site', '--source', '.site-src', ...extra];
  try {
    return { status: 0, stdout: execFileSync(process.execPath, args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? '').trim(), stderr: String(error.stderr ?? '').trim() };
  }
}

test('the audit passes the tree the staging step produces', () => {
  const repo = fixture();
  try {
    const result = audit(repo);
    assert.equal(result.status, 0, `clean staging must pass: ${result.stderr}`);
    assert.equal(result.stdout, `audit-staged-site: 7 files match ${run(repo, 'git', ['rev-parse', 'HEAD'])}`,
      'the passing run names how many files it held to the commit, which is the 45 -> 46 evidence');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a file written into site/ after staging fails, naming the file', () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, 'site/preseed.html'), '<!doctype html><title>not in the commit</title>\n');
    const result = audit(repo);
    assert.equal(result.status, 1, 'an extra file must fail the publication');
    assert.match(result.stderr, /audit-staged-site: the staged site does not match /);
    assert.match(result.stderr, /extra: preseed\.html \(staged, not published by the commit\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a file written into an already-staged directory also fails', () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, 'site/demo/injected.js'), 'export const injected = 1;\n');
    const result = audit(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /extra: demo\/injected\.js \(staged, not published by the commit\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a staged file with different bytes fails, naming the file and both blob ids', () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, 'site/demo/index.html'), '<!doctype html><title>rewritten</title>\n');
    const result = audit(repo);
    assert.equal(result.status, 1, 'the file set is unchanged, so only the content check can catch this');
    assert.match(result.stderr, /modified: demo\/index\.html \(expected [0-9a-f]{40}, staged [0-9a-f]{40}\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a generated index.html that is not the redirect stub fails', () => {
  const repo = fixture();
  try {
    writeFileSync(join(repo, 'site/index.html'), '<!doctype html><title>hijacked</title>\n');
    const result = audit(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /modified: index\.html \(expected the redirect stub in tools\/audit-staged-site\.mjs/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a file the commit publishes but staging lost fails, naming the file', () => {
  const repo = fixture();
  try {
    // demo/index.html is published but imported by nothing, so the missing-set comparison is the only
    // check that can see it gone - unlike a library module, whose vanished import is also caught below.
    rmSync(join(repo, 'site/demo/index.html'));
    const result = audit(repo);
    assert.equal(result.status, 1, 'a missing published file must fail the publication');
    assert.match(result.stderr, /missing: demo\/index\.html \(published by the commit, not staged\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a staged page whose imports no longer resolve fails even when the extracted tree was edited to match', () => {
  const repo = fixture();
  try {
    rmSync(join(repo, 'site/utils/lib.js'));
    // The extracted tree is writable after the extraction, so an edited demo/app.js there would shrink
    // the expected module set enough to hide the missing file from the set comparison. The staged page
    // still has to resolve its own imports, which is the check that closes this hole.
    writeFileSync(join(repo, '.site-src/demo/app.js'), "import { VectorDB } from '../index.js';\nexport { VectorDB };\n");
    const result = audit(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unresolved import: demo\/app\.js imports '\.\.\/utils\/lib\.js', which does not exist/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a symlink in site/ fails instead of being followed', () => {
  const repo = fixture();
  try {
    symlinkSync(join(repo, 'index.js'), join(repo, 'site/link.js'));
    const result = audit(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a regular file: link\.js/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('the audit refuses a staging source that does not exist instead of passing an empty expectation', () => {
  const repo = fixture();
  try {
    rmSync(join(repo, '.site-src'), { recursive: true, force: true });
    const result = audit(repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /the extracted commit \.site-src does not exist/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
