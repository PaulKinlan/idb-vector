// The Pages build stages `site/` from the published commit and then hands `site/` to
// actions/upload-pages-artifact. Nothing re-reads the tree in between, so a process that `npm ci`
// (third-party install scripts) or `npm run build:research` (project scripts) left running can write
// into `site/` after the stager returns, and the artifact then publishes a file no commit tracks -
// under the commit's trust root, which is exactly what demo/integrity.js and demo/README.md pin
// (idb-vector-vy5v, residual risk (i) of the idb-vector-5yqb review; the reviewer reproduced 45 -> 46
// files with nothing noticing). Deleting the staging roots again is not a fix: the delete has to stay
// before the first write, and this window is after the last one. So the build audits the staged tree
// instead, and this is the same audit the reviewer ran by hand, promoted into a script so
// tests/unit/staged-site-audit.test.mjs can drive it against a throwaway repository.
//
// Two directions, both failures: every file under `site/` must be a tracked file with the commit's
// bytes (`git hash-object` against the commit's blob id), and every file staging is supposed to
// produce must be present. Content and set are separate properties: a modified tracked file keeps the
// set intact, a stale set keeps every byte that remains intact, and both ship something the commit
// does not describe.
//
// The expected set comes from three places. `demo/` and `research/` ship whole (the stager copies
// demo/ recursively and the workflow copies the extracted research/), so the commit's paths under
// those roots are expected verbatim. The library modules outside demo/ are derived from the import
// graph of the extracted commit through tools/stage-site.mjs, which is how staging derives them too.
// The one generated file is `site/index.html`: the redirect stub the workflow writes with printf. Its
// bytes are REDIRECT_HTML here, and tests/unit/pages-workflow-permissions.test.mjs pins the
// workflow's printf to this constant, so the two copies cannot drift apart silently.
//
// The staged page's own import graph is checked as well, so a library module deleted from `site/` is
// reported as a missing import even if the extracted tree the expected set was read from was edited
// after staging. The stager itself is run out of the extracted commit for the same reason this script
// is: the code that decides what ships is committed code, not code `npm ci` may have rewritten.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEMO_DIR, DEMO_ENTRY, moduleClosure } from './stage-site.mjs';

// The workflow's redirect stub at the artifact root. `printf '<…>' > site/index.html` in pages.yml
// must write these bytes and no trailing newline; the fast-tier workflow test asserts it does.
export const REDIRECT_HTML = '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./demo/"><a href="./demo/">Open the Wikipedia search demo</a>';

const normalize = (path) => path.split(sep).join('/');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// Every blob the commit tracks, keyed by repo-relative path. -z keeps paths literal (no quoting); the
// record is `mode SP type SP oid TAB path NUL`. A non-blob entry under a published root would be a
// submodule, which staging cannot copy as a file, so it fails here rather than silently dropping out
// of the expected set.
export function committedBlobs(cwd, commit) {
  const sha = git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  const tree = git(cwd, ['ls-tree', '-r', '-z', '--full-tree', sha]);
  const blobs = new Map();
  for (const record of tree.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [, type, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (type !== 'blob') {
      // A submodule under a published root cannot be copied as a file; one elsewhere in the repo does
      // not ship, so it is simply not part of the expected set.
      if (path.startsWith(`${DEMO_DIR}/`) || path.startsWith('research/')) throw new Error(`commit ${sha} tracks ${path} as a ${type}, not a blob`);
      continue;
    }
    blobs.set(path, oid);
  }
  return { sha, blobs };
}

// A regular file is something the artifact can publish; a directory is walked through; anything else
// (a symlink, a socket) is not a file the commit could match, so it is reported instead of followed.
function stagedEntries(siteDir) {
  const files = [];
  const notFiles = [];
  for (const entry of readdirSync(siteDir, { recursive: true, withFileTypes: true })) {
    const path = normalize(relative(siteDir, join(entry.parentPath, entry.name)));
    if (entry.isFile()) files.push(path);
    else if (!entry.isDirectory()) notFiles.push(path);
  }
  return { files: files.sort(), notFiles: notFiles.sort() };
}

// path -> expected content: `oid` for tracked files, `bytes` for the generated stub.
function expectedContents({ sourceDir, blobs }) {
  const expected = new Map();
  for (const [path, oid] of blobs) {
    if (path.startsWith(`${DEMO_DIR}/`) || path.startsWith('research/')) expected.set(path, { oid });
  }
  for (const file of moduleClosure(DEMO_ENTRY, sourceDir)) {
    const path = normalize(relative(sourceDir, file));
    if (path.startsWith(`${DEMO_DIR}/`)) continue;
    const oid = blobs.get(path);
    if (oid === undefined) throw new Error(`the staged page imports ${path}, which the commit does not track`);
    expected.set(path, { oid });
  }
  expected.set('index.html', { bytes: Buffer.from(REDIRECT_HTML) });
  return expected;
}

export function auditStagedSite({ site = 'site', source = '.site-src', commit = 'HEAD', cwd = process.cwd() } = {}) {
  const siteDir = resolve(cwd, site);
  const sourceDir = resolve(cwd, source);
  if (!existsSync(siteDir)) throw new Error(`the staged site ${site} does not exist`);
  if (!existsSync(sourceDir)) throw new Error(`the extracted commit ${source} does not exist`);
  const { sha, blobs } = committedBlobs(cwd, commit);
  const expected = expectedContents({ sourceDir, blobs });
  const { files: staged, notFiles } = stagedEntries(siteDir);
  const stagedSet = new Set(staged);
  const extras = staged.filter(path => !expected.has(path));
  const missing = [...expected.keys()].filter(path => !stagedSet.has(path)).sort();
  const differing = [];
  for (const path of staged) {
    const want = expected.get(path);
    if (want === undefined) continue;
    // git archive writes the blob's stored bytes, so the staged bytes are compared raw: a checkout
    // filter (none exist today) must not make a filtered file look like the committed one.
    const got = git(cwd, ['hash-object', '--no-filters', '--', normalize(relative(cwd, join(siteDir, path)))]).trim();
    if (want.oid !== undefined) {
      if (got !== want.oid) differing.push({ path, expected: want.oid, staged: got });
    } else if (!readFileSync(join(siteDir, path)).equals(want.bytes)) {
      differing.push({ path, expected: 'the redirect stub in tools/audit-staged-site.mjs', staged: got });
    }
  }
  // The published page has to resolve its own imports: staging's derivation and this audit's expected
  // set both read the extracted tree, which a writer can edit after the extraction.
  let unresolved = null;
  try {
    moduleClosure(DEMO_ENTRY, siteDir);
  } catch (error) {
    unresolved = error.message;
  }
  return {
    ok: extras.length === 0 && missing.length === 0 && differing.length === 0 && notFiles.length === 0 && unresolved === null,
    commit: sha,
    staged,
    extras,
    missing,
    differing,
    notFiles,
    unresolved,
  };
}

function report(result) {
  const lines = [`audit-staged-site: the staged site does not match ${result.commit}`];
  for (const path of result.extras) lines.push(`  extra: ${path} (staged, not published by the commit)`);
  for (const path of result.missing) lines.push(`  missing: ${path} (published by the commit, not staged)`);
  for (const { path, expected, staged } of result.differing) lines.push(`  modified: ${path} (expected ${expected}, staged ${staged})`);
  for (const path of result.notFiles) lines.push(`  not a regular file: ${path}`);
  if (result.unresolved !== null) lines.push(`  unresolved import: ${result.unresolved}`);
  return lines.join('\n');
}

const USAGE = 'usage: audit-staged-site.mjs [--site site] [--source .site-src] [--commit <rev>]';

function parseArgs(argv) {
  const options = { site: 'site', source: '.site-src', commit: 'HEAD' };
  const names = { '--site': 'site', '--source': 'source', '--commit': 'commit' };
  for (let i = 0; i < argv.length; i += 2) {
    const name = names[argv[i]];
    if (name === undefined) throw new Error(`unknown argument ${argv[i]}; ${USAGE}`);
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} needs a value; ${USAGE}`);
    options[name] = argv[i + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = auditStagedSite(parseArgs(process.argv.slice(2)));
    if (result.ok) {
      console.log(`audit-staged-site: ${result.staged.length} files match ${result.commit}`);
    } else {
      console.error(report(result));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`audit-staged-site: ${error.message}`);
    process.exitCode = 1;
  }
}
