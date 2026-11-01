// Least privilege for the Pages publication (idb-vector-yfdc). The job that runs `npm ci` executes
// third-party install scripts and the research build runs project scripts, so a compromise there must
// not inherit the ability to publish to Pages or mint a Pages OIDC token. That only holds while the
// deploy grants live on a separate, artifact-only job; the split is easy to undo by pasting
// `pages: write` back onto the build job, so it is pinned here.
//
// Text-level on purpose: the fast tier has no YAML parser and this must cost nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../../.github/workflows/pages.yml', import.meta.url), 'utf8');

// The jobs under `jobs:` keyed by name, each value the job's own lines. A job key is a two-space
// indented `name:` line inside the jobs block; everything deeper belongs to that job.
function jobBlocks(yaml) {
  const lines = yaml.split('\n');
  const jobsAt = lines.findIndex(line => /^jobs:\s*$/.test(line));
  assert.notEqual(jobsAt, -1, 'pages.yml must declare a jobs: block');
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
  return new Map([...jobs].map(([name, body]) => [name, body.join('\n')]));
}

const jobs = jobBlocks(workflow);
const deployGrantNames = ['pages: write', 'id-token: write'];
// Everything above `jobs:` is the workflow-level scope every job inherits unless it overrides it.
const workflowScope = workflow.slice(0, workflow.indexOf('\njobs:'));

test('the job that installs and builds holds no Pages or OIDC capability', () => {
  const buildJob = [...jobs].find(([, body]) => /\bnpm ci\b/.test(body));
  assert.ok(buildJob, 'some job must still run npm ci');
  const [buildName, buildBody] = buildJob;
  assert.match(buildBody, /\bnpm run build:research\b/, 'the research build stays in the installing job');
  for (const grant of deployGrantNames) {
    assert.doesNotMatch(buildBody, new RegExp(grant), `job "${buildName}" runs npm ci and must not carry ${grant}`);
    assert.doesNotMatch(workflowScope, new RegExp(grant), `the workflow-level permissions block is inherited by "${buildName}" and must not carry ${grant}`);
  }
  assert.doesNotMatch(buildBody, /^\s*permissions:/m, `job "${buildName}" needs no permissions override at all; contents: read is already the workflow default`);
  assert.doesNotMatch(buildBody, /actions\/deploy-pages/, 'the installing job must not publish');
  assert.doesNotMatch(buildBody, /github-pages/, 'the installing job must not join the publication environment');
});

test('deployment is a separate artifact-only job that needs the build', () => {
  assert.deepEqual([...jobs.keys()], ['build', 'deploy'], 'the publication path is exactly a build job and a deploy job');
  const build = jobs.get('build');
  const deploy = jobs.get('deploy');
  assert.match(build, /actions\/upload-pages-artifact/, 'the build job hands the site over as an artifact');
  assert.match(deploy, /actions\/deploy-pages/, 'the deploy job publishes that artifact and nothing else');
  assert.doesNotMatch(deploy, /\bnpm (ci|run)\b/, 'the deploy job runs no project or dependency script');
  assert.match(deploy, /^ {4}needs: build$/m, 'the deploy job must wait for the build job');
  for (const grant of deployGrantNames) {
    assert.match(deploy, new RegExp(`permissions:[\\s\\S]*\\n {6}${grant}`, 'm'), `the deploy job carries ${grant}`);
  }
  // actions/deploy-pages requires the github-pages environment; its page_url comes from the deploy step.
  assert.match(deploy, /environment:[\s\S]*name: github-pages/, 'the deploy job publishes through the github-pages environment');
  assert.match(deploy, /url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/, 'the environment URL is the live page URL');
  assert.match(deploy, /id: deployment[\s\S]*actions\/deploy-pages/, 'the deploy step is still id: deployment');
});

test('the publication triggers and concurrency are unchanged', () => {
  assert.match(workflowScope, /^on:[\s\S]*push:[\s\S]*branches: \[main\]/m, 'main still publishes');
  assert.match(workflowScope, /^ {2}workflow_dispatch:/m, 'manual dispatch still publishes');
  assert.match(workflowScope, /^concurrency:[\s\S]*group: pages[\s\S]*cancel-in-progress: true/m, 'one publication at a time');
});
