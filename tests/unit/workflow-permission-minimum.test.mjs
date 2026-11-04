// Least privilege for every workflow that installs dependencies (idb-vector-nkay). `npm ci` runs
// third-party install scripts, so the job that runs it must not hold token rights it never uses.
// pages.yml pins that for the Pages publication in pages-workflow-permissions.test.mjs; this suite is
// the repo-wide floor behind it: every workflow declares explicit permissions no wider than
// `contents: read`, no job that installs dependencies holds more than that, and any grant above the
// floor lives on a named job with its reason. Without a declared block a job runs with the repository
// or organisation default - often write-all - which nothing in this repo pins down.
//
// Text-level on purpose: the fast tier has no YAML parser and this must cost nothing.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const workflowsDir = new URL('../../.github/workflows/', import.meta.url);
const workflowFiles = readdirSync(workflowsDir)
  .filter(name => /\.ya?ml$/.test(name))
  .sort();

// Everything above `jobs:` is the workflow-level scope every job inherits; a job key is a two-space
// indented `name:` line inside the jobs block and everything deeper belongs to that job.
function splitWorkflow(yaml) {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex(line => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsAt, -1, 'a workflow must declare a jobs: block');
  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(jobsAt + 1)) {
    const key = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (key) {
      current = { name: key[1], lines: [] };
      jobs.set(current.name, current.lines);
    } else if (current && line.trim() !== '') {
      current.lines.push(line);
    }
  }
  return {
    scope: lines.slice(0, jobsAt).join('\n'),
    jobs: new Map([...jobs].map(([name, body]) => [name, body.join('\n')])),
  };
}

// The `permissions:` key at exactly `indent` spaces, either inline (`permissions: {contents: read}`) or
// as a block of `name: level` lines one level deeper. `null` means the key is absent at that level, so
// the job inherits whatever the level above grants, and at the workflow level that is the repository
// default rather than anything this repo chose.
function permissionsAt(scope, indent, where) {
  const lines = scope.split('\n');
  const key = new RegExp(`^ {${indent}}permissions:(.*)$`);
  const at = lines.findIndex(line => key.test(line));
  if (at === -1) return null;
  const inline = key.exec(lines[at])[1].replace(/#.*/, '').trim();
  if (inline !== '') {
    const body = inline.replace(/^\{/, '').replace(/\}$/, '').trim();
    if (body === '') return new Map();
    // `permissions: write-all` / `read-all` are broader than any named grant; keep them readable as one
    // entry so a test can say what they do to the floor.
    if (body === 'write-all' || body === 'read-all') return new Map([[body, 'all']]);
    return new Map(body.split(',').map(pair => {
      const [name, level] = pair.split(':').map(part => part.trim());
      assert.ok(name && level, `${where} has an unreadable inline permission entry: "${pair.trim()}"`);
      return [name, level];
    }));
  }
  const grants = new Map();
  const grant = new RegExp(`^ {${indent + 2}}([a-z-]+):\\s*(\\S+)\\s*$`);
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = grant.exec(line);
    if (!match) break; // dedent out of the block, or the next top-level key
    grants.set(match[1], match[2]);
  }
  return grants;
}

const workflows = workflowFiles.map(file => {
  const yaml = readFileSync(new URL(file, workflowsDir), 'utf8');
  const { scope, jobs } = splitWorkflow(yaml);
  return {
    file,
    workflowScope: permissionsAt(scope, 0, `${file} (workflow level)`),
    jobs: [...jobs].map(([name, body]) => {
      const declared = permissionsAt(body, 4, `${file} job "${name}"`);
      return { name, body, declared, effective: declared ?? permissionsAt(scope, 0, `${file} (workflow level)`) };
    }),
  };
});

const formatGrants = grants => [...grants].map(([name, level]) => (level === 'all' ? name : `${name}: ${level}`)).join(', ');

// The floor every job may hold. `contents: read` is what checkout needs to read the commit; nothing
// here needs to write it.
const floor = new Map([['contents', 'read']]);
const floorEntries = [...floor];

// The only grants any job in this repo may hold above the floor, keyed `workflow:job`, each with the
// reason it is required. Reaching for a new one is the review point: the entry has to say what the job
// does with it. The publish job is deliberately absent - `npm publish` authenticates to
// registry.npmjs.org with NODE_AUTH_TOKEN (secrets.NPM_TOKEN, a token outside GitHub), so it uses no
// GITHUB_TOKEN scope at all and `packages: write` would only be needed for a GitHub Packages registry.
const justifiedGrants = {
  'pages.yml:deploy': {
    pages: { level: 'write', why: 'actions/deploy-pages publishes the built artifact through the Pages API' },
    'id-token': { level: 'write', why: 'actions/deploy-pages mints the Pages OIDC token it deploys with' },
  },
};

// The jobs that install dependencies today, pinned so that dropping one of them out of the scan below
// (a renamed command, a switched package manager) is a failure rather than a silent gap.
const installJobs = [
  'npm-publish-github-packages.yml:build',
  'packed-stress.yml:stress',
  'pages.yml:build',
];

test('every workflow declares workflow-level permissions no wider than contents: read', () => {
  assert.ok(workflows.length > 0, 'the scan must actually read .github/workflows');
  for (const { file, workflowScope } of workflows) {
    assert.notEqual(workflowScope, null, `"${file}" declares no permissions: block, so every job in it runs with the repository or organisation default; declare contents: read on the workflow`);
    assert.ok(workflowScope.size > 0, `"${file}" resolves to an empty permissions block; declare contents: read on the workflow`);
    assert.deepEqual(
      [...workflowScope],
      floorEntries,
      `"${file}" grants ${formatGrants(workflowScope)} at the workflow level, which every job inherits; the workflow-level scope is exactly contents: read, and anything wider belongs on one named job`,
    );
  }
});

test('no job that installs dependencies holds more than contents: read', () => {
  const installing = [];
  for (const { file, jobs } of workflows) {
    for (const job of jobs) {
      if (/\bnpm (ci|install)\b/.test(job.body)) installing.push({ file, ...job });
    }
  }
  assert.deepEqual(
    installing.map(({ file, name }) => `${file}:${name}`).sort(),
    installJobs,
    'the set of jobs that install dependencies changed: a new one is reviewed here before it is added, and an install no longer visible to this scan is a gap, not a pass',
  );
  for (const { file, name, effective } of installing) {
    const where = `${file} job "${name}"`;
    assert.notEqual(effective, null, `${where} runs npm ci and declares no permissions at any level, so it runs with the repository or organisation default; declare contents: read`);
    assert.ok(effective.size > 0, `${where} runs npm ci and resolves to an empty permissions block; checkout still needs contents: read`);
    assert.deepEqual(
      [...effective],
      floorEntries,
      `${where} runs npm ci, which executes third-party install scripts, and holds ${formatGrants(effective)}; it may hold at most contents: read, and a publish or deploy credential belongs on a separate job or in a secret`,
    );
  }
});

test('every grant above the floor is a job that names its reason here', () => {
  for (const { file, jobs } of workflows) {
    for (const { name, effective } of jobs) {
      const above = [...(effective ?? new Map())].filter(([grant, level]) => floor.get(grant) !== level);
      const justified = justifiedGrants[`${file}:${name}`] ?? {};
      const declared = Object.entries(justified).map(([grant, { level }]) => [grant, level]);
      assert.deepEqual(
        above.sort(([a], [b]) => a.localeCompare(b)),
        declared.sort(([a], [b]) => a.localeCompare(b)),
        `${file} job "${name}" holds [${formatGrants(above)}] above the contents: read floor; list each grant with its level and reason in justifiedGrants, or drop it`,
      );
      for (const [grant, { why }] of Object.entries(justified)) {
        assert.match(why, /\S/, `${file} job "${name}": the justifiedGrants entry for ${grant} must say what the job does with it`);
      }
    }
  }
  for (const key of Object.keys(justifiedGrants)) {
    const [file, name] = key.split(':');
    const workflow = workflows.find(candidate => candidate.file === file);
    assert.ok(workflow, `justifiedGrants names ${file}, which is not a workflow here`);
    assert.ok(workflow.jobs.some(job => job.name === name), `justifiedGrants names job "${name}" in ${file}, which no longer exists; drop the entry so the grant is not carried forward`);
  }
});
